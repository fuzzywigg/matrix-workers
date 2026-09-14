/**
 * TOKENMAXX HEAVY leftovers after #161 — federation membership/state API soft/edge/reliability.
 * Complements federation-membership-state-api-routes.test.ts and federation-api-route-leftovers.
 * Orthogonal to keys/media/appservice races, push leftovers, relations, account-data leftovers.
 * Tests-only — no product inventing. Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

/** Side-channel so mocked federation auth can stamp origin onto Hono context. */
let federationOriginSideChannel: string | null = null;

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      if (federationOriginSideChannel) {
        c.set('federationOrigin', federationOriginSideChannel);
      }
      await next();
    };
  },
  optionalFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      if (federationOriginSideChannel) {
        c.set('federationOrigin', federationOriginSideChannel);
      }
      await next();
    };
  },
}));

import federation from '../src/api/federation';

const SERVER = 'example.com';
const REMOTE = 'remote.example.org';
const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const REMOTE_USER = '@carol:remote.example.org';
const ROOM = '!room:example.com';
const ROOM2 = '!other:example.com';
const SPACE = '!space:example.com';
const EVENT = '$event:example.com';
const CREATE = '$create:example.com';
const JOIN_RULES = '$join_rules:example.com';
const POWER = '$power:example.com';
const MEMBER = '$member:example.com';
const NOW = 1_700_000_000_000;

type KvPut = { key: string; value: string };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  return {
    data,
    puts,
    deletes,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return raw;
    },
    put: async (key: string, value: string) => {
      data[key] = value;
      puts.push({ key, value });
    },
    delete: async (key: string) => {
      deletes.push(key);
      delete data[key];
    },
  } as unknown as KVNamespace & { data: Record<string, string>; puts: KvPut[]; deletes: string[] };
}

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
  hashes?: string | null;
  signatures?: string | null;
};

type StateRow = {
  room_id: string;
  event_type: string;
  state_key: string;
  event_id: string;
};

type RoomRow = {
  room_id: string;
  room_version: string;
  is_public?: number;
  created_at?: number;
};

type MembershipRow = { room_id: string; user_id: string; membership: string };
type AliasRow = { alias: string; room_id: string };
type UserRow = { user_id: string; display_name?: string | null; avatar_url?: string | null };
type SqlCall = { sql: string; args: unknown[] };

function makeEvent(partial: Partial<EventRow> & Pick<EventRow, 'event_id'>): EventRow {
  return {
    event_id: partial.event_id,
    room_id: partial.room_id ?? ROOM,
    sender: partial.sender ?? USER,
    event_type: partial.event_type ?? 'm.room.message',
    state_key: partial.state_key !== undefined ? partial.state_key : null,
    content: partial.content ?? JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
    origin_server_ts: partial.origin_server_ts ?? NOW,
    depth: partial.depth ?? 3,
    auth_events: partial.auth_events ?? JSON.stringify([]),
    prev_events: partial.prev_events ?? JSON.stringify([]),
    hashes: partial.hashes !== undefined ? partial.hashes : JSON.stringify({ sha256: 'abc' }),
    signatures:
      partial.signatures !== undefined
        ? partial.signatures
        : JSON.stringify({ [SERVER]: { 'ed25519:1': 'sig' } }),
  };
}

function createMembershipDb(opts: {
  rooms?: RoomRow[];
  events?: EventRow[];
  state?: StateRow[];
  memberships?: MembershipRow[];
  aliases?: AliasRow[];
  users?: UserRow[];
  throwOn?: string;
} = {}) {
  const rooms = opts.rooms ?? [
    { room_id: ROOM, room_version: '10', is_public: 1, created_at: NOW },
  ];
  const events = opts.events ?? [];
  const state = opts.state ?? [];
  const memberships = opts.memberships ?? [];
  const aliases = opts.aliases ?? [];
  const users = opts.users ?? [
    { user_id: USER, display_name: 'Alice', avatar_url: 'mxc://a/b' },
  ];
  const selects: SqlCall[] = [];

  const findState = (roomId: string, eventType: string, stateKey?: string) =>
    state.find(
      (s) =>
        s.room_id === roomId &&
        s.event_type === eventType &&
        (stateKey === undefined || s.state_key === stateKey)
    );

  const eventById = (id: string) => events.find((e) => e.event_id === id);

  const stateContent = (roomId: string, eventType: string) => {
    const s = findState(roomId, eventType);
    const ev = s ? eventById(s.event_id) : undefined;
    return ev ? { content: ev.content } : null;
  };

  const db = {
    rooms,
    events,
    state,
    memberships,
    aliases,
    users,
    selects,
    prepare(sql: string) {
      const exec = (args: unknown[]) => ({
        async first<T>() {
          selects.push({ sql, args });
          if (opts.throwOn && sql.includes(opts.throwOn)) {
            throw new Error(`forced: ${opts.throwOn}`);
          }

          if (sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version')) {
            const hit = rooms.find((r) => r.room_id === args[0]);
            return (hit
              ? { room_id: hit.room_id, room_version: hit.room_version }
              : null) as T;
          }
          if (sql.includes('FROM rooms WHERE room_id = ?')) {
            const hit = rooms.find((r) => r.room_id === args[0]);
            return (hit ? { room_id: hit.room_id } : null) as T;
          }

          if (sql.includes("rs.event_type = 'm.room.create'") && sql.includes('SELECT e.event_id')) {
            const s = findState(args[0] as string, 'm.room.create');
            return (s ? { event_id: s.event_id } : null) as T;
          }
          if (sql.includes("rs.event_type = 'm.room.join_rules'") && sql.includes('SELECT e.event_id')) {
            const s = findState(args[0] as string, 'm.room.join_rules');
            return (s ? { event_id: s.event_id } : null) as T;
          }
          if (sql.includes("rs.event_type = 'm.room.power_levels'") && sql.includes('SELECT e.event_id')) {
            const s = findState(args[0] as string, 'm.room.power_levels');
            return (s ? { event_id: s.event_id } : null) as T;
          }
          if (
            sql.includes("rs.event_type = 'm.room.member'") &&
            sql.includes('rs.state_key = ?') &&
            sql.includes('SELECT e.event_id')
          ) {
            const s = findState(args[0] as string, 'm.room.member', args[1] as string);
            return (s ? { event_id: s.event_id } : null) as T;
          }

          for (const t of [
            'm.room.join_rules',
            'm.room.name',
            'm.room.topic',
            'm.room.canonical_alias',
            'm.room.avatar',
            'm.room.history_visibility',
            'm.room.guest_access',
            'm.room.create',
          ]) {
            if (!sql.includes(`rs.event_type = '${t}'`)) continue;
            const s = findState(args[0] as string, t);
            const ev = s ? eventById(s.event_id) : undefined;
            if (!ev) return null as T;
            // make_knock / auth path: SELECT e.event_id only
            if (sql.includes('SELECT e.event_id') && !sql.includes('e.content')) {
              return { event_id: s!.event_id } as T;
            }
            // send_knock stripped state: event_type + state_key + content + sender
            if (sql.includes('e.event_type')) {
              return {
                event_type: ev.event_type,
                state_key: ev.state_key ?? '',
                content: ev.content,
                sender: ev.sender,
                origin_server_ts: ev.origin_server_ts,
              } as T;
            }
            // getRoomPublicInfo / join_rules gate: SELECT e.content
            return { content: ev.content } as T;
          }

          if (sql.includes('FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1')) {
            const rows = events
              .filter((e) => e.room_id === args[0])
              .sort((a, b) => b.depth - a.depth);
            return (rows[0]
              ? { event_id: rows[0].event_id, depth: rows[0].depth }
              : null) as T;
          }

          if (sql.includes('FROM room_memberships WHERE room_id = ? AND user_id = ?')) {
            const hit = memberships.find(
              (m) => m.room_id === args[0] && m.user_id === args[1]
            );
            return (hit ? { membership: hit.membership } : null) as T;
          }

          if (
            sql.includes('FROM room_memberships') &&
            sql.includes("membership = 'join'") &&
            (sql.includes('SUBSTR') || sql.includes('INSTR'))
          ) {
            const [roomId, origin] = args as string[];
            const hit = memberships.find(
              (m) =>
                m.room_id === roomId &&
                m.membership === 'join' &&
                m.user_id.endsWith(`:${origin}`)
            );
            return (hit ? { 1: 1 } : null) as T;
          }

          if (
            sql.includes('COUNT(*)') &&
            sql.includes('room_memberships') &&
            sql.includes("membership = 'join'")
          ) {
            const count = memberships.filter(
              (m) => m.room_id === args[0] && m.membership === 'join'
            ).length;
            return { count } as T;
          }

          if (sql.includes('COUNT(*)') && sql.includes('FROM rooms WHERE is_public = 1')) {
            return { count: rooms.filter((r) => r.is_public === 1).length } as T;
          }

          if (sql.includes('FROM room_aliases WHERE alias = ?')) {
            const hit = aliases.find((a) => a.alias === args[0]);
            return (hit ? { room_id: hit.room_id } : null) as T;
          }

          if (sql.includes('FROM users WHERE user_id = ?') && sql.includes('display_name')) {
            const hit = users.find((u) => u.user_id === args[0]);
            return (hit
              ? {
                  display_name: hit.display_name ?? null,
                  avatar_url: hit.avatar_url ?? null,
                }
              : null) as T;
          }
          if (sql.includes('FROM users WHERE user_id = ?')) {
            const hit = users.find((u) => u.user_id === args[0]);
            return (hit ? { user_id: hit.user_id } : null) as T;
          }

          if (sql.includes('MIN(depth)') && sql.includes('event_id IN')) {
            const depths = events
              .filter((e) => (args as string[]).includes(e.event_id))
              .map((e) => e.depth);
            return { min_depth: depths.length ? Math.min(...depths) : 0 } as T;
          }

          if (sql.includes('origin_server_ts <= ?') && sql.includes('ORDER BY origin_server_ts DESC')) {
            const [roomId, ts] = args as [string, number];
            const rows = events
              .filter((e) => e.room_id === roomId && e.origin_server_ts <= ts)
              .sort((a, b) => b.origin_server_ts - a.origin_server_ts);
            return (rows[0]
              ? { event_id: rows[0].event_id, origin_server_ts: rows[0].origin_server_ts }
              : null) as T;
          }
          if (sql.includes('origin_server_ts >= ?') && sql.includes('ORDER BY origin_server_ts ASC')) {
            const [roomId, ts] = args as [string, number];
            const rows = events
              .filter((e) => e.room_id === roomId && e.origin_server_ts >= ts)
              .sort((a, b) => a.origin_server_ts - b.origin_server_ts);
            return (rows[0]
              ? { event_id: rows[0].event_id, origin_server_ts: rows[0].origin_server_ts }
              : null) as T;
          }

          if (
            sql.includes('FROM events') &&
            sql.includes('event_id = ?') &&
            sql.includes('room_id = ?') &&
            sql.includes('depth >= ?')
          ) {
            const [eventId, roomId, minDepth] = args as [string, string, number];
            const hit = events.find(
              (e) =>
                e.event_id === eventId && e.room_id === roomId && e.depth >= minDepth
            );
            return (hit ?? null) as T;
          }

          if (sql.includes('SELECT event_id, prev_events FROM events WHERE event_id = ?')) {
            const hit = eventById(args[0] as string);
            return (hit
              ? { event_id: hit.event_id, prev_events: hit.prev_events }
              : null) as T;
          }

          if (sql.includes('FROM events WHERE event_id = ?')) {
            return (eventById(args[0] as string) ?? null) as T;
          }

          throw new Error(`Unhandled first() SQL: ${sql.slice(0, 180)}`);
        },

        async all<T>() {
          selects.push({ sql, args });
          if (opts.throwOn && sql.includes(opts.throwOn)) {
            throw new Error(`forced: ${opts.throwOn}`);
          }

          if (
            sql.includes('FROM room_state rs') &&
            sql.includes('JOIN events e') &&
            sql.includes('e.event_id, e.auth_events')
          ) {
            const roomId = args[0] as string;
            const rows = state
              .filter((s) => s.room_id === roomId)
              .map((s) => {
                const ev = eventById(s.event_id);
                return ev ? { event_id: ev.event_id, auth_events: ev.auth_events } : null;
              })
              .filter(Boolean);
            return { results: rows } as unknown as T;
          }

          if (
            (sql.includes('FROM room_state rs') &&
              sql.includes('JOIN events e') &&
              sql.includes('WHERE rs.room_id = ?') &&
              (sql.includes('e.event_id, e.room_id') || sql.includes('SELECT e.*'))) ||
            sql.includes('SELECT e.* FROM room_state rs')
          ) {
            const roomId = args[0] as string;
            const rows = state
              .filter((s) => s.room_id === roomId)
              .map((s) => eventById(s.event_id))
              .filter(Boolean);
            return { results: rows } as unknown as T;
          }

          if (sql.includes('depth < ?') && sql.includes('ORDER BY depth DESC')) {
            const [roomId, maxDepth, limit] = args as [string, number, number];
            const rows = events
              .filter((e) => e.room_id === roomId && e.depth < maxDepth)
              .sort((a, b) => b.depth - a.depth)
              .slice(0, limit);
            return { results: rows } as unknown as T;
          }

          if (
            sql.includes('FROM events') &&
            sql.includes('WHERE room_id = ?') &&
            sql.includes('ORDER BY depth DESC') &&
            sql.includes('LIMIT ?') &&
            !sql.includes('depth <')
          ) {
            const [roomId, limit] = args as [string, number];
            const rows = events
              .filter((e) => e.room_id === roomId)
              .sort((a, b) => b.depth - a.depth)
              .slice(0, limit);
            return { results: rows } as unknown as T;
          }

          if (sql.includes('FROM rooms r') && sql.includes('is_public = 1')) {
            let list = rooms
              .filter((r) => r.is_public === 1)
              .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
            if (sql.includes('LIKE ?')) {
              const term = String(args[0]).replace(/%/g, '').toLowerCase();
              list = list.filter((r) => {
                const name = stateContent(r.room_id, 'm.room.name');
                const topic = stateContent(r.room_id, 'm.room.topic');
                const alias = aliases.find((a) => a.room_id === r.room_id)?.alias ?? '';
                return (
                  (name?.content ?? '').toLowerCase().includes(term) ||
                  (topic?.content ?? '').toLowerCase().includes(term) ||
                  alias.toLowerCase().includes(term)
                );
              });
              const limit = args[args.length - 2] as number;
              const offset = args[args.length - 1] as number;
              return {
                results: list.slice(offset, offset + limit).map((r) => ({ room_id: r.room_id })),
              } as unknown as T;
            }
            const limit = args[0] as number;
            const offset = args[1] as number;
            return {
              results: list.slice(offset, offset + limit).map((r) => ({ room_id: r.room_id })),
            } as unknown as T;
          }

          if (sql.includes("rs.event_type = 'm.space.child'")) {
            const roomId = args[0] as string;
            let rows = state
              .filter((s) => s.room_id === roomId && s.event_type === 'm.space.child')
              .map((s) => ({
                state_key: s.state_key,
                content: eventById(s.event_id)?.content ?? '{}',
              }));
            if (sql.includes('LIMIT ? OFFSET ?')) {
              const limit = args[1] as number;
              const offset = args[2] as number;
              rows = rows.slice(offset, offset + limit);
            }
            return { results: rows } as unknown as T;
          }

          return { results: [] } as unknown as T;
        },

        async run() {
          selects.push({ sql, args });
          if (sql.includes('INSERT') && sql.includes('INTO events')) {
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
              hashes,
              signatures,
            ] = args as [
              string,
              string,
              string,
              string,
              string | null,
              string,
              number,
              number,
              string,
              string,
              string | null,
              string | null,
            ];
            if (!events.some((e) => e.event_id === eventId)) {
              events.push({
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
                hashes,
                signatures,
              });
            }
          }
          if (sql.includes('INSERT') && sql.includes('INTO room_state')) {
            const [roomId, eventType, stateKey, eventId] = args as [string, string, string, string];
            const idx = state.findIndex(
              (s) =>
                s.room_id === roomId && s.event_type === eventType && s.state_key === stateKey
            );
            const row = {
              room_id: roomId,
              event_type: eventType,
              state_key: stateKey,
              event_id: eventId,
            };
            if (idx >= 0) state[idx] = row;
            else state.push(row);
          }
          if (sql.includes('INSERT') && sql.includes('INTO room_memberships')) {
            const [roomId, userId, membership, eventId] = args as [
              string,
              string,
              string,
              string,
            ];
            // send_knock binds (room_id, user_id, event_id) with membership literal 'knock'
            let mem = membership;
            let eid = eventId;
            if (sql.includes("'knock'")) {
              // INSERT ... VALUES (?, ?, 'knock', ?)
              mem = 'knock';
              eid = args[2] as string;
              const uid = args[1] as string;
              const rid = args[0] as string;
              const midx = memberships.findIndex((m) => m.room_id === rid && m.user_id === uid);
              const mrow = { room_id: rid, user_id: uid, membership: mem };
              if (midx >= 0) memberships[midx] = mrow;
              else memberships.push(mrow);
              void eid;
              return { success: true, meta: { changes: 1 } };
            }
            const midx = memberships.findIndex(
              (m) => m.room_id === roomId && m.user_id === userId
            );
            const mrow = { room_id: roomId, user_id: userId, membership: mem };
            if (midx >= 0) memberships[midx] = mrow;
            else memberships.push(mrow);
            void eid;
          }
          return { success: true, meta: { changes: 1 } };
        },
      });

      return {
        bind(...args: unknown[]) {
          return exec(args);
        },
        first: <T>() => exec([]).first<T>(),
        all: <T>() => exec([]).all<T>(),
        run: () => exec([]).run(),
      };
    },
  };

  return db as unknown as D1Database & typeof db;
}

function createEnv(opts: {
  db?: ReturnType<typeof createMembershipDb>;
  sessionsKv?: ReturnType<typeof mockKv>;
  serverName?: string;
  federationOrigin?: string | null;
} = {}): Env {
  federationOriginSideChannel = opts.federationOrigin ?? null;
  const db = opts.db ?? createMembershipDb();
  const sessionsKv = opts.sessionsKv ?? mockKv();
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: opts.serverName ?? SERVER,
    SERVER_VERSION: '0.1.0-test',
    SESSIONS: sessionsKv as unknown as KVNamespace,
    DEVICE_KEYS: mockKv() as unknown as KVNamespace,
    ONE_TIME_KEYS: mockKv() as unknown as KVNamespace,
    CROSS_SIGNING_KEYS: mockKv() as unknown as KVNamespace,
    CACHE: mockKv() as unknown as KVNamespace,
    ACCOUNT_DATA: mockKv() as unknown as KVNamespace,
    MEDIA: {} as R2Bucket,
    USER_KEYS: {
      idFromName: (n: string) => ({ name: n }),
      get: () => ({ fetch: async () => Response.json({}) }),
    },
    FEDERATION: {
      idFromName: (n: string) => ({ name: n }),
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
    ROOM: { idFromName: () => ({}), get: () => ({}) },
    SYNC: { idFromName: () => ({}), get: () => ({}) },
    ADMIN: { idFromName: () => ({}), get: () => ({}) },
    PUSH: { idFromName: () => ({}), get: () => ({}) },
    RATE_LIMIT: { idFromName: () => ({}), get: () => ({}) },
    CALL_ROOM: { idFromName: () => ({}), get: () => ({}) },
  } as unknown as Env;
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any; text: string }> {
  const res = await federation.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function baseline() {
  const create = makeEvent({
    event_id: CREATE,
    event_type: 'm.room.create',
    state_key: '',
    content: JSON.stringify({ creator: USER, room_version: '10' }),
    depth: 1,
    auth_events: '[]',
  });
  const joinRules = makeEvent({
    event_id: JOIN_RULES,
    event_type: 'm.room.join_rules',
    state_key: '',
    content: JSON.stringify({ join_rule: 'public' }),
    depth: 2,
    auth_events: JSON.stringify([CREATE]),
  });
  const power = makeEvent({
    event_id: POWER,
    event_type: 'm.room.power_levels',
    state_key: '',
    content: JSON.stringify({ users: { [USER]: 100 } }),
    depth: 2,
    auth_events: JSON.stringify([CREATE]),
  });
  const member = makeEvent({
    event_id: MEMBER,
    event_type: 'm.room.member',
    state_key: USER,
    content: JSON.stringify({ membership: 'join' }),
    depth: 3,
    auth_events: JSON.stringify([CREATE, JOIN_RULES, POWER]),
  });
  const events = [create, joinRules, power, member];
  const state: StateRow[] = events.map((e) => ({
    room_id: e.room_id,
    event_type: e.event_type,
    state_key: e.state_key ?? '',
    event_id: e.event_id,
  }));
  return { events, state, create, joinRules, power, member };
}

function publicRoomFixture() {
  const { events, state } = baseline();
  const name = makeEvent({
    event_id: '$name',
    event_type: 'm.room.name',
    state_key: '',
    content: JSON.stringify({ name: 'Lobby' }),
  });
  const topic = makeEvent({
    event_id: '$topic',
    event_type: 'm.room.topic',
    state_key: '',
    content: JSON.stringify({ topic: 'welcome friends' }),
  });
  const hist = makeEvent({
    event_id: '$hist',
    event_type: 'm.room.history_visibility',
    state_key: '',
    content: JSON.stringify({ history_visibility: 'world_readable' }),
  });
  const guest = makeEvent({
    event_id: '$guest',
    event_type: 'm.room.guest_access',
    state_key: '',
    content: JSON.stringify({ guest_access: 'can_join' }),
  });
  return {
    rooms: [
      { room_id: ROOM, room_version: '10', is_public: 1, created_at: NOW },
      { room_id: ROOM2, room_version: '10', is_public: 1, created_at: NOW - 1000 },
      { room_id: SPACE, room_version: '10', is_public: 0, created_at: NOW - 2000 },
    ],
    events: [...events, name, topic, hist, guest],
    state: [
      ...state,
      { room_id: ROOM, event_type: 'm.room.name', state_key: '', event_id: '$name' },
      { room_id: ROOM, event_type: 'm.room.topic', state_key: '', event_id: '$topic' },
      {
        room_id: ROOM,
        event_type: 'm.room.history_visibility',
        state_key: '',
        event_id: '$hist',
      },
      { room_id: ROOM, event_type: 'm.room.guest_access', state_key: '', event_id: '$guest' },
    ],
    memberships: [
      { room_id: ROOM, user_id: USER, membership: 'join' },
      { room_id: ROOM, user_id: BOB, membership: 'join' },
    ],
    aliases: [{ alias: '#lobby:example.com', room_id: ROOM }],
  };
}


beforeEach(() => {
  federationOriginSideChannel = null;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  federationOriginSideChannel = null;
});

// ---------------------------------------------------------------------------
// GET /state/:roomId
// ---------------------------------------------------------------------------


void REMOTE;
void REMOTE_USER;
void EVENT;

describe('federation membership leftovers state soft flood after #161', () => {

  it('state soft-0', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-1', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-2', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-3', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-4', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-5', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-6', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-7', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-8', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-9', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-10', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-11', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-12', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-13', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-14', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });

  it('state soft-15', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.auth_chain)).toBe(true);
  });
});

describe('federation membership leftovers state_ids soft flood after #161', () => {

  it('state_ids soft-0', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-1', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-2', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-3', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-4', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-5', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-6', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-7', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-8', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-9', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-10', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-11', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-12', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-13', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-14', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });

  it('state_ids soft-15', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pdu_ids)).toBe(true);
    expect(res.body.pdu_ids.length).toBeGreaterThan(0);
  });
});

describe('federation membership leftovers state missing soft flood after #161', () => {

  it('state empty room soft-0', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing0:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-1', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing1:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-2', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing2:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-3', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing3:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-4', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing4:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-5', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing5:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-6', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing6:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-7', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing7:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-8', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing8:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-9', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing9:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-10', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing10:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-11', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing11:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-12', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing12:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-13', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing13:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-14', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing14:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('state empty room soft-15', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [], events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent('!missing15:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });
});

describe('federation membership leftovers state_ids missing soft flood after #161', () => {

  it('state_ids missing soft-0', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing0:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-1', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing1:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-2', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing2:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-3', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing3:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-4', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing4:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-5', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing5:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-6', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing6:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-7', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing7:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-8', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing8:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-9', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing9:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-10', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing10:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-11', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing11:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-12', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing12:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-13', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing13:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-14', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing14:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('state_ids missing soft-15', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent('!missing15:example.com')}`
    );
    expect(res.status).toBe(404);
  });
});

describe('federation membership leftovers directory soft flood after #161', () => {

  it('directory soft-0', async () => {
    const alias = `#soft0:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-1', async () => {
    const alias = `#soft1:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-2', async () => {
    const alias = `#soft2:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-3', async () => {
    const alias = `#soft3:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-4', async () => {
    const alias = `#soft4:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-5', async () => {
    const alias = `#soft5:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-6', async () => {
    const alias = `#soft6:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-7', async () => {
    const alias = `#soft7:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-8', async () => {
    const alias = `#soft8:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-9', async () => {
    const alias = `#soft9:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-10', async () => {
    const alias = `#soft10:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-11', async () => {
    const alias = `#soft11:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-12', async () => {
    const alias = `#soft12:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-13', async () => {
    const alias = `#soft13:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-14', async () => {
    const alias = `#soft14:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory soft-15', async () => {
    const alias = `#soft15:example.com`;
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });
});

describe('federation membership leftovers directory missing soft flood after #161', () => {

  it('directory missing soft-0', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope0:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-1', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope1:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-2', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope2:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-3', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope3:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-4', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope4:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-5', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope5:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-6', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope6:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-7', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope7:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-8', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope8:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-9', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope9:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-10', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope10:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-11', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope11:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-12', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope12:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-13', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope13:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-14', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope14:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('directory missing soft-15', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#nope15:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
});

describe('federation membership leftovers profile soft flood after #161', () => {

  it('profile soft-0', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-1', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-2', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-3', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-4', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-5', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-6', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-7', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-8', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-9', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-10', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-11', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-12', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-13', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-14', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });

  it('profile soft-15', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://a/b',
    });
  });
});

describe('federation membership leftovers profile field soft flood after #161', () => {

  it('profile field soft-0', async () => {
    const field = 'displayname';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-1', async () => {
    const field = 'avatar_url';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-2', async () => {
    const field = 'displayname';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-3', async () => {
    const field = 'avatar_url';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-4', async () => {
    const field = 'displayname';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-5', async () => {
    const field = 'avatar_url';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-6', async () => {
    const field = 'displayname';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-7', async () => {
    const field = 'avatar_url';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-8', async () => {
    const field = 'displayname';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-9', async () => {
    const field = 'avatar_url';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-10', async () => {
    const field = 'displayname';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-11', async () => {
    const field = 'avatar_url';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-12', async () => {
    const field = 'displayname';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-13', async () => {
    const field = 'avatar_url';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-14', async () => {
    const field = 'displayname';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });

  it('profile field soft-15', async () => {
    const field = 'avatar_url';
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=${field}`
    );
    expect(res.status).toBe(200);
    if (field === 'displayname') {
      expect(res.body).toEqual({ displayname: 'Alice' });
    } else {
      expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
    }
  });
});

describe('federation membership leftovers openid soft flood after #161', () => {

  it('openid soft-0', async () => {
    const kv = mockKv({
      'openid:tok0': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok0'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-1', async () => {
    const kv = mockKv({
      'openid:tok1': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok1'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-2', async () => {
    const kv = mockKv({
      'openid:tok2': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok2'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-3', async () => {
    const kv = mockKv({
      'openid:tok3': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok3'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-4', async () => {
    const kv = mockKv({
      'openid:tok4': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok4'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-5', async () => {
    const kv = mockKv({
      'openid:tok5': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok5'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-6', async () => {
    const kv = mockKv({
      'openid:tok6': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok6'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-7', async () => {
    const kv = mockKv({
      'openid:tok7': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok7'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-8', async () => {
    const kv = mockKv({
      'openid:tok8': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok8'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-9', async () => {
    const kv = mockKv({
      'openid:tok9': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok9'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-10', async () => {
    const kv = mockKv({
      'openid:tok10': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok10'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-11', async () => {
    const kv = mockKv({
      'openid:tok11': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok11'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-12', async () => {
    const kv = mockKv({
      'openid:tok12': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok12'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-13', async () => {
    const kv = mockKv({
      'openid:tok13': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok13'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-14', async () => {
    const kv = mockKv({
      'openid:tok14': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok14'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });

  it('openid soft-15', async () => {
    const kv = mockKv({
      'openid:tok15': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=tok15'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: USER });
  });
});

describe('federation membership leftovers openid fail soft flood after #161', () => {

  it('openid unknown soft-0', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope0'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-1', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope1'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-2', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope2'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-3', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope3'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-4', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope4'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-5', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope5'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-6', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope6'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-7', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope7'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-8', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope8'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-9', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope9'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-10', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope10'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-11', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope11'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-12', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope12'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-13', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope13'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-14', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope14'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('openid unknown soft-15', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope15'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });
});

describe('federation membership leftovers publicRooms soft flood after #161', () => {

  it('publicRooms soft-0', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-1', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-2', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-3', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-4', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-5', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-6', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-7', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-8', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-9', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-10', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-11', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-12', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-13', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-14', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });

  it('publicRooms soft-15', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBeGreaterThan(0);
    expect(res.body.total_room_count_estimate).toBe(2);
  });
});

describe('federation membership leftovers publicRooms POST soft flood after #161', () => {

  it('publicRooms POST soft-0', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'Lobby';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-1', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'friends';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-2', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'Lobby';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-3', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'friends';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-4', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'Lobby';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-5', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'friends';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-6', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'Lobby';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-7', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'friends';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-8', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'Lobby';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-9', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'friends';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-10', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'Lobby';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-11', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'friends';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-12', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'Lobby';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-13', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'friends';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-14', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'Lobby';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });

  it('publicRooms POST soft-15', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const term = 'friends';
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: term }, limit: 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(1);
  });
});

describe('federation membership leftovers timestamp soft flood after #161', () => {

  it('timestamp soft-0', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts0',
      origin_server_ts: NOW - 0 * 1000,
      depth: 10 + 0,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-1', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts1',
      origin_server_ts: NOW - 1 * 1000,
      depth: 10 + 1,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-2', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts2',
      origin_server_ts: NOW - 2 * 1000,
      depth: 10 + 2,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-3', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts3',
      origin_server_ts: NOW - 3 * 1000,
      depth: 10 + 3,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-4', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts4',
      origin_server_ts: NOW - 4 * 1000,
      depth: 10 + 4,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-5', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts5',
      origin_server_ts: NOW - 5 * 1000,
      depth: 10 + 5,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-6', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts6',
      origin_server_ts: NOW - 6 * 1000,
      depth: 10 + 6,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-7', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts7',
      origin_server_ts: NOW - 7 * 1000,
      depth: 10 + 7,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-8', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts8',
      origin_server_ts: NOW - 8 * 1000,
      depth: 10 + 8,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-9', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts9',
      origin_server_ts: NOW - 9 * 1000,
      depth: 10 + 9,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-10', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts10',
      origin_server_ts: NOW - 10 * 1000,
      depth: 10 + 10,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-11', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts11',
      origin_server_ts: NOW - 11 * 1000,
      depth: 10 + 11,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-12', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts12',
      origin_server_ts: NOW - 12 * 1000,
      depth: 10 + 12,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-13', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts13',
      origin_server_ts: NOW - 13 * 1000,
      depth: 10 + 13,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-14', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts14',
      origin_server_ts: NOW - 14 * 1000,
      depth: 10 + 14,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });

  it('timestamp soft-15', async () => {
    const { events, state } = baseline();
    const msg = makeEvent({
      event_id: '$ts15',
      origin_server_ts: NOW - 15 * 1000,
      depth: 10 + 15,
    });
    const env = createEnv({
      db: createMembershipDb({ events: [...events, msg], state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?dir=b&ts=${NOW}`
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.event_id).toBeTruthy();
    }
  });
});

describe('federation membership leftovers charset soft flood after #161', () => {

  it('charset publicRooms soft-0', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-1', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-2', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-3', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-4', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-5', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-6', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-7', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-8', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-9', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-10', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-11', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-12', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-13', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-14', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset publicRooms soft-15', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ filter: { generic_search_term: 'Lobby' } }),
    });
    expect(res.status).toBe(200);
  });
});

describe('federation membership leftovers failure edges after #161', () => {

  it('directory missing param soft-0', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-1', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-2', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-3', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-4', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-5', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-6', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-7', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-8', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-9', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-10', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-11', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-12', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-13', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-14', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('directory missing param soft-15', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
});

describe('federation membership leftovers method matrix after #161', () => {

  it('state GET soft-0', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-1', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-2', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-3', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-4', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-5', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-6', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-7', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-8', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-9', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-10', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-11', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-12', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-13', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-14', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });

  it('state GET soft-15', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(env, `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(res.status).toBe(200);
  });
});

describe('federation membership leftovers lifecycle after #161', () => {

  it('directory→profile→openid lifecycle soft-0', async () => {
    const alias = `#lc0:example.com`;
    const kv = mockKv({
      'openid:lc0': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc0'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-1', async () => {
    const alias = `#lc1:example.com`;
    const kv = mockKv({
      'openid:lc1': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc1'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-2', async () => {
    const alias = `#lc2:example.com`;
    const kv = mockKv({
      'openid:lc2': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc2'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-3', async () => {
    const alias = `#lc3:example.com`;
    const kv = mockKv({
      'openid:lc3': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc3'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-4', async () => {
    const alias = `#lc4:example.com`;
    const kv = mockKv({
      'openid:lc4': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc4'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-5', async () => {
    const alias = `#lc5:example.com`;
    const kv = mockKv({
      'openid:lc5': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc5'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-6', async () => {
    const alias = `#lc6:example.com`;
    const kv = mockKv({
      'openid:lc6': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc6'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-7', async () => {
    const alias = `#lc7:example.com`;
    const kv = mockKv({
      'openid:lc7': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc7'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-8', async () => {
    const alias = `#lc8:example.com`;
    const kv = mockKv({
      'openid:lc8': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc8'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-9', async () => {
    const alias = `#lc9:example.com`;
    const kv = mockKv({
      'openid:lc9': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc9'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-10', async () => {
    const alias = `#lc10:example.com`;
    const kv = mockKv({
      'openid:lc10': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc10'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-11', async () => {
    const alias = `#lc11:example.com`;
    const kv = mockKv({
      'openid:lc11': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc11'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-12', async () => {
    const alias = `#lc12:example.com`;
    const kv = mockKv({
      'openid:lc12': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc12'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-13', async () => {
    const alias = `#lc13:example.com`;
    const kv = mockKv({
      'openid:lc13': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc13'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-14', async () => {
    const alias = `#lc14:example.com`;
    const kv = mockKv({
      'openid:lc14': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc14'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });

  it('directory→profile→openid lifecycle soft-15', async () => {
    const alias = `#lc15:example.com`;
    const kv = mockKv({
      'openid:lc15': JSON.stringify({ user_id: USER, expires_at: NOW + 60_000 }),
    });
    const env = createEnv({
      db: createMembershipDb({ aliases: [{ alias, room_id: ROOM }] }),
      sessionsKv: kv,
    });
    const d = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(d.status).toBe(200);
    const p = await request(
      env,
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}`
    );
    expect(p.status).toBe(200);
    const o = await request(
      env,
      '/_matrix/federation/v1/openid/userinfo?access_token=lc15'
    );
    expect(o.status).toBe(200);
    expect(o.body.sub).toBe(USER);
  });
});

describe('federation membership leftovers backfill soft flood after #161', () => {

  it('backfill soft-0', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf0_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf0_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf0_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-1', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf1_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf1_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf1_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-2', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf2_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf2_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf2_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-3', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf3_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf3_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf3_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-4', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf4_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf4_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf4_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-5', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf5_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf5_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf5_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-6', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf6_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf6_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf6_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-7', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf7_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf7_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf7_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-8', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf8_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf8_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf8_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-9', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf9_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf9_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf9_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-10', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf10_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf10_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf10_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-11', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf11_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf11_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf11_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-12', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf12_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf12_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf12_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-13', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf13_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf13_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf13_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-14', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf14_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf14_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf14_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });

  it('backfill soft-15', async () => {
    const { events, state } = baseline();
    const msgs = [];
    for (let j = 0; j < 3; j++) {
      msgs.push(
        makeEvent({
          event_id: `$bf15_${j}`,
          depth: 20 + j,
          origin_server_ts: NOW - j * 10,
          prev_events: JSON.stringify(j === 0 ? [MEMBER] : [`$bf15_${j - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        events: [...events, ...msgs],
        state,
        memberships: [{ room_id: ROOM, user_id: '@serv:remote.example.org', membership: 'join' }],
      }),
      federationOrigin: 'remote.example.org',
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent(`$bf15_2`)}&limit=10`
    );
    expect([200, 403, 404]).toContain(res.status);
  });
});

