/**
 * TOKENMAXX HEAVY deepen after #120/#121 — federation membership / state / backfill /
 * directory / knock / publicRooms / hierarchy / timestamp / openid leftovers in
 * src/api/federation.ts.
 * Avoids keys+events (#121), voip/rtc/calls (#120), sliding-sync (#119), sync (#117).
 * Tests-only — no product inventing.
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

describe('federation GET /state/:roomId', () => {
  it('returns pdus + auth_chain for current room state', async () => {
    const { events, state } = baseline();
    const db = createMembershipDb({ events, state });
    const env = createEnv({ db });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.origin).toBe(SERVER);
    expect(res.body.origin_server_ts).toBe(NOW);
    expect(res.body.pdus).toHaveLength(4);
    expect(res.body.pdus.map((p: { type: string }) => p.type).sort()).toEqual(
      ['m.room.create', 'm.room.join_rules', 'm.room.member', 'm.room.power_levels'].sort()
    );
    // auth chain includes CREATE referenced by join_rules/power/member
    const authIds = res.body.auth_chain.map((e: { event_id: string }) => e.event_id);
    expect(authIds).toContain(CREATE);
  });

  it('returns empty pdus/auth_chain when room has no state', async () => {
    const env = createEnv({ db: createMembershipDb({ events: [], state: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.body.pdus).toEqual([]);
    expect(res.body.auth_chain).toEqual([]);
  });

  it('maps null state_key to empty string on pdus', async () => {
    const ev = makeEvent({
      event_id: '$ns',
      event_type: 'm.room.topic',
      state_key: null,
      content: JSON.stringify({ topic: 't' }),
      auth_events: '[]',
    });
    const db = createMembershipDb({
      events: [ev],
      state: [
        { room_id: ROOM, event_type: 'm.room.topic', state_key: '', event_id: '$ns' },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.body.pdus[0].state_key).toBe('');
  });

  it('skips missing auth events when building auth_chain', async () => {
    const ev = makeEvent({
      event_id: '$x',
      event_type: 'm.room.name',
      state_key: '',
      content: JSON.stringify({ name: 'N' }),
      auth_events: JSON.stringify(['$missing', CREATE]),
    });
    const create = makeEvent({
      event_id: CREATE,
      event_type: 'm.room.create',
      state_key: '',
      content: '{}',
      auth_events: '[]',
      depth: 1,
    });
    const db = createMembershipDb({
      events: [ev, create],
      state: [
        { room_id: ROOM, event_type: 'm.room.name', state_key: '', event_id: '$x' },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`
    );
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toEqual([
      CREATE,
    ]);
  });

  it('ignores event_id query (documented void) without error', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}?event_id=${encodeURIComponent(EVENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /state_ids/:roomId
// ---------------------------------------------------------------------------

describe('federation GET /state_ids/:roomId', () => {
  it('404 when room missing', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(404);
  });

  it('returns pdu_ids and auth_chain_ids for current state', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdu_ids.sort()).toEqual(
      [CREATE, JOIN_RULES, POWER, MEMBER].sort()
    );
    expect(res.body.auth_chain_ids).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });

  it('with event_id query still returns current state ids (snapshot TODO)', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}?event_id=$any`
    );
    expect(res.body.pdu_ids).toHaveLength(4);
  });

  it('empty state yields empty id lists', async () => {
    const env = createEnv({
      db: createMembershipDb({
        rooms: [{ room_id: ROOM, room_version: '10' }],
        events: [],
        state: [],
      }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`
    );
    expect(res.body).toEqual({ pdu_ids: [], auth_chain_ids: [] });
  });

  it('percent-decodes roomId', async () => {
    const room = '!a/b:example.com';
    const env = createEnv({
      db: createMembershipDb({
        rooms: [{ room_id: room, room_version: '10' }],
      }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(room)}`
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /backfill/:roomId
// ---------------------------------------------------------------------------

describe('federation GET /backfill/:roomId', () => {
  it('404 when room missing', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(404);
  });

  it('returns recent events when v omitted', async () => {
    const msgs = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        event_id: `$m${i}`,
        depth: i + 1,
        origin_server_ts: NOW + i,
      })
    );
    const env = createEnv({
      db: createMembershipDb({
        events: msgs,
        rooms: [{ room_id: ROOM, room_version: '10' }],
      }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=3`
    );
    expect(res.status).toBe(200);
    expect(res.body.origin).toBe(SERVER);
    expect(res.body.pdus).toHaveLength(3);
    expect(res.body.pdus.map((p: { depth: number }) => p.depth)).toEqual([5, 4, 3]);
  });

  it('clamps limit to [1,1000] and defaults NaN to 100', async () => {
    const msgs = Array.from({ length: 120 }, (_, i) =>
      makeEvent({ event_id: `$b${i}`, depth: i + 1 })
    );
    const db = createMembershipDb({
      events: msgs,
      rooms: [{ room_id: ROOM, room_version: '10' }],
    });
    const env = createEnv({ db });

    const tooBig = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=99999`
    );
    expect(tooBig.body.pdus).toHaveLength(120); // only 120 exist

    const zero = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=0`
    );
    expect(zero.body.pdus).toHaveLength(1); // Math.max(1, ...)

    const nan = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=nope`
    );
    expect(nan.body.pdus.length).toBeLessThanOrEqual(100);
  });

  it('walks before min depth of v= event ids', async () => {
    const msgs = [
      makeEvent({ event_id: '$a', depth: 1 }),
      makeEvent({ event_id: '$b', depth: 2 }),
      makeEvent({ event_id: '$c', depth: 3 }),
      makeEvent({ event_id: '$d', depth: 4 }),
    ];
    const env = createEnv({
      db: createMembershipDb({
        events: msgs,
        rooms: [{ room_id: ROOM, room_version: '10' }],
      }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${encodeURIComponent('$c')},${encodeURIComponent('$d')}&limit=10`
    );
    // min depth of $c,$d is 3 → depth < 3 → $a,$b
    expect(res.body.pdus.map((p: { event_id: string }) => p.event_id).sort()).toEqual([
      '$a',
      '$b',
    ]);
  });

  it('caps v= list at 20 ids', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `$v${i}`);
    const events = ids.map((id, i) => makeEvent({ event_id: id, depth: i + 10 }));
    events.push(makeEvent({ event_id: '$early', depth: 1 }));
    const env = createEnv({
      db: createMembershipDb({
        events,
        rooms: [{ room_id: ROOM, room_version: '10' }],
      }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${ids.map(encodeURIComponent).join(',')}`
    );
    expect(res.status).toBe(200);
    // first 20 of ids have min depth 10 → includes $early
    expect(res.body.pdus.some((p: { event_id: string }) => p.event_id === '$early')).toBe(
      true
    );
  });

  it('forbids when federationOrigin set and no remote member in room', async () => {
    const env = createEnv({
      db: createMembershipDb({
        rooms: [{ room_id: ROOM, room_version: '10' }],
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      }),
      federationOrigin: REMOTE,
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('allows backfill when remote server has a joined user', async () => {
    const env = createEnv({
      db: createMembershipDb({
        rooms: [{ room_id: ROOM, room_version: '10' }],
        events: [makeEvent({ event_id: '$m', depth: 1 })],
        memberships: [
          { room_id: ROOM, user_id: REMOTE_USER, membership: 'join' },
        ],
      }),
      federationOrigin: REMOTE,
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdus).toHaveLength(1);
  });

  it('omits null state_key/hashes/signatures on pdus', async () => {
    const env = createEnv({
      db: createMembershipDb({
        rooms: [{ room_id: ROOM, room_version: '10' }],
        events: [
          makeEvent({
            event_id: '$n',
            state_key: null,
            hashes: null,
            signatures: null,
            depth: 1,
          }),
        ],
      }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}`
    );
    expect(res.body.pdus[0].state_key).toBeUndefined();
    expect(res.body.pdus[0].hashes).toBeUndefined();
    expect(res.body.pdus[0].signatures).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /get_missing_events/:roomId
// ---------------------------------------------------------------------------

describe('federation POST /get_missing_events/:roomId', () => {
  it('rejects bad JSON', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }
    );
    expect(res.status).toBe(400);
  });

  it('404 when room missing', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
      jsonInit('POST', { latest_events: ['$a'], earliest_events: [] })
    );
    expect(res.status).toBe(404);
  });

  it('walks prev_events from latest toward earliest and respects limit', async () => {
    // chain: $e3 → $e2 → $e1 → $e0
    const e0 = makeEvent({
      event_id: '$e0',
      depth: 1,
      prev_events: '[]',
    });
    const e1 = makeEvent({
      event_id: '$e1',
      depth: 2,
      prev_events: JSON.stringify(['$e0']),
    });
    const e2 = makeEvent({
      event_id: '$e2',
      depth: 3,
      prev_events: JSON.stringify(['$e1']),
    });
    const e3 = makeEvent({
      event_id: '$e3',
      depth: 4,
      prev_events: JSON.stringify(['$e2']),
    });
    const env = createEnv({
      db: createMembershipDb({
        rooms: [{ room_id: ROOM, room_version: '10' }],
        events: [e0, e1, e2, e3],
      }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
      jsonInit('POST', {
        latest_events: ['$e3'],
        earliest_events: ['$e0'],
        limit: 10,
      })
    );
    expect(res.status).toBe(200);
    const ids = res.body.events.map((e: { event_id: string }) => e.event_id);
    expect(ids).toContain('$e3'); // latest is visited/emitted
    expect(ids).toContain('$e2');
    expect(ids).toContain('$e1');
    expect(ids).not.toContain('$e0'); // earliest excluded via visited seed
  });

  it('defaults limit to 10 and caps at 100', async () => {
    // Build a long prev chain
    const events = [];
    for (let i = 0; i < 30; i++) {
      events.push(
        makeEvent({
          event_id: `$c${i}`,
          depth: i + 1,
          prev_events: i === 0 ? '[]' : JSON.stringify([`$c${i - 1}`]),
        })
      );
    }
    const env = createEnv({
      db: createMembershipDb({
        rooms: [{ room_id: ROOM, room_version: '10' }],
        events,
      }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
      jsonInit('POST', { latest_events: ['$c29'], earliest_events: [] })
    );
    expect(res.body.events.length).toBeLessThanOrEqual(10);
  });

  it('skips events at or below min_depth', async () => {
    const e1 = makeEvent({
      event_id: '$low',
      depth: 1,
      prev_events: '[]',
    });
    const e2 = makeEvent({
      event_id: '$hi',
      depth: 5,
      prev_events: JSON.stringify(['$low']),
    });
    const env = createEnv({
      db: createMembershipDb({
        rooms: [{ room_id: ROOM, room_version: '10' }],
        events: [e1, e2],
      }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
      jsonInit('POST', {
        latest_events: ['$hi'],
        earliest_events: [],
        min_depth: 2,
      })
    );
    const ids = res.body.events.map((e: { event_id: string }) => e.event_id);
    expect(ids).not.toContain('$low');
  });

  it('forbids when origin has no joined member', async () => {
    const env = createEnv({
      db: createMembershipDb({
        rooms: [{ room_id: ROOM, room_version: '10' }],
        memberships: [],
      }),
      federationOrigin: REMOTE,
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
      jsonInit('POST', { latest_events: [], earliest_events: [] })
    );
    expect(res.status).toBe(403);
  });

  it('handles empty latest/earliest without walking', async () => {
    const env = createEnv({
      db: createMembershipDb({ rooms: [{ room_id: ROOM, room_version: '10' }] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /make_join + PUT send_join v1/v2
// ---------------------------------------------------------------------------

describe('federation make_join / send_join', () => {
  it('make_join 404 when room missing', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`
    );
    expect(res.status).toBe(404);
  });

  it('make_join returns unsigned template with auth/prev/depth', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.room_version).toBe('10');
    expect(res.body.event).toMatchObject({
      room_id: ROOM,
      sender: REMOTE_USER,
      type: 'm.room.member',
      state_key: REMOTE_USER,
      content: { membership: 'join' },
      depth: 4, // member depth 3 + 1
    });
    expect(res.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
    expect(res.body.event.prev_events).toEqual([MEMBER]);
  });

  it('make_join works with empty state (no auth/prev)', async () => {
    const env = createEnv({
      db: createMembershipDb({
        rooms: [{ room_id: ROOM, room_version: '11' }],
        events: [],
        state: [],
      }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`
    );
    expect(res.body.room_version).toBe('11');
    expect(res.body.event.auth_events).toEqual([]);
    expect(res.body.event.prev_events).toEqual([]);
    expect(res.body.event.depth).toBe(1);
  });

  it('send_join v1 rejects bad JSON', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/send_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' }
    );
    expect(res.status).toBe(400);
  });

  it('send_join v1 rejects event_id mismatch', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/send_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', { event_id: '$other', type: 'm.room.member' })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });

  it('send_join v1 returns origin + state + auth_chain', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/send_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', {
        event_id: EVENT,
        type: 'm.room.member',
        content: { membership: 'join' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.origin).toBe(SERVER);
    expect(res.body.state.length).toBe(4);
    expect(res.body.auth_chain.length).toBeGreaterThan(0);
  });

  it('send_join v2 same success shape as v1 (object, not tuple)', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', { type: 'm.room.member', content: { membership: 'join' } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body.origin).toBe(SERVER);
    expect(res.body.state).toBeTruthy();
  });

  it('send_join v2 rejects bad JSON and id mismatch', async () => {
    const env = createEnv();
    const bad = await request(
      env,
      `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: 'x' }
    );
    expect(bad.status).toBe(400);
    const mismatch = await request(
      env,
      `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', { event_id: '$nope' })
    );
    expect(mismatch.body.errcode).toBe('M_INVALID_PARAM');
  });
});

// ---------------------------------------------------------------------------
// make_leave / send_leave
// ---------------------------------------------------------------------------

describe('federation make_leave / send_leave', () => {
  it('make_leave 404 when room missing', async () => {
    const env = createEnv({ db: createMembershipDb({ rooms: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(404);
  });

  it('make_leave 403 when user has no member state', async () => {
    const env = createEnv({
      db: createMembershipDb({
        rooms: [{ room_id: ROOM, room_version: '10' }],
        state: [],
        events: [],
      }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('make_leave returns leave template with member in auth_events', async () => {
    const { events, state } = baseline();
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.event.content.membership).toBe('leave');
    expect(res.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, POWER, MEMBER])
    );
  });

  it('send_leave v1 rejects non-leave events and id mismatch', async () => {
    const env = createEnv();
    const notLeave = await request(
      env,
      `/_matrix/federation/v1/send_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', { type: 'm.room.member', content: { membership: 'join' } })
    );
    expect(notLeave.status).toBe(400);
    const mismatch = await request(
      env,
      `/_matrix/federation/v1/send_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', {
        type: 'm.room.member',
        content: { membership: 'leave' },
        event_id: '$x',
      })
    );
    expect(mismatch.body.errcode).toBe('M_INVALID_PARAM');
  });

  it('send_leave v1 404 when room missing; success returns [200, {}]', async () => {
    const missing = await request(
      createEnv({ db: createMembershipDb({ rooms: [] }) }),
      `/_matrix/federation/v1/send_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', { type: 'm.room.member', content: { membership: 'leave' } })
    );
    expect(missing.status).toBe(404);

    const ok = await request(
      createEnv(),
      `/_matrix/federation/v1/send_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', { type: 'm.room.member', content: { membership: 'leave' } })
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual([200, {}]);
  });

  it('send_leave v2 returns {} on success and rejects bad JSON', async () => {
    const bad = await request(
      createEnv(),
      `/_matrix/federation/v2/send_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' }
    );
    expect(bad.status).toBe(400);
    const ok = await request(
      createEnv(),
      `/_matrix/federation/v2/send_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', { type: 'm.room.member', content: { membership: 'leave' } })
    );
    expect(ok.body).toEqual({});
  });
});


// ---------------------------------------------------------------------------
// GET /query/directory + /query/profile
// ---------------------------------------------------------------------------

describe('federation GET /query/directory', () => {
  it('requires room_alias', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/directory');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('404 when alias unknown', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent('#missing:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('resolves alias to room_id + servers', async () => {
    const alias = '#lobby:example.com';
    const env = createEnv({
      db: createMembershipDb({
        aliases: [{ alias, room_id: ROOM }],
      }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });
});

describe('federation GET /query/profile', () => {
  it('requires user_id', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/query/profile');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('404 when user missing', async () => {
    const res = await request(
      createEnv({ db: createMembershipDb({ users: [] }) }),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent('@nobody:example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('returns full profile by default', async () => {
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

  it('field=displayname returns only displayname', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=displayname`
    );
    expect(res.body).toEqual({ displayname: 'Alice' });
  });

  it('field=avatar_url returns only avatar_url', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=avatar_url`
    );
    expect(res.body).toEqual({ avatar_url: 'mxc://a/b' });
  });

  it('unknown field still returns full profile', async () => {
    const res = await request(
      createEnv(),
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(USER)}&field=nope`
    );
    expect(res.body.displayname).toBe('Alice');
    expect(res.body.avatar_url).toBe('mxc://a/b');
  });
});

// ---------------------------------------------------------------------------
// make_knock / send_knock
// ---------------------------------------------------------------------------

function knockBaseline(joinRule: string = 'knock') {
  const { events, state, create, joinRules, power, member } = baseline();
  // replace join_rules content
  const jr = makeEvent({
    event_id: JOIN_RULES,
    event_type: 'm.room.join_rules',
    state_key: '',
    content: JSON.stringify({ join_rule: joinRule }),
    depth: 2,
    auth_events: JSON.stringify([CREATE]),
  });
  const events2 = events.map((e) => (e.event_id === JOIN_RULES ? jr : e));
  return { events: events2, state, create, joinRules: jr, power, member };
}

describe('federation make_knock / send_knock', () => {
  it('make_knock 404 when room missing', async () => {
    const res = await request(
      createEnv({ db: createMembershipDb({ rooms: [] }) }),
      `/_matrix/federation/v1/make_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`
    );
    expect(res.status).toBe(404);
  });

  it('make_knock 403 when join_rule is invite (default / no knock)', async () => {
    const { events, state } = baseline(); // join_rule public
    const res = await request(
      createEnv({ db: createMembershipDb({ events, state }) }),
      `/_matrix/federation/v1/make_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('make_knock 403 when join_rules state missing', async () => {
    const { events, state } = baseline();
    const stateNoJr = state.filter((s) => s.event_type !== 'm.room.join_rules');
    const res = await request(
      createEnv({ db: createMembershipDb({ events, state: stateNoJr }) }),
      `/_matrix/federation/v1/make_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`
    );
    expect(res.status).toBe(403);
  });

  it('make_knock allows knock_restricted and returns template', async () => {
    const { events, state } = knockBaseline('knock_restricted');
    const res = await request(
      createEnv({ db: createMembershipDb({ events, state }) }),
      `/_matrix/federation/v1/make_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.room_version).toBe('10');
    expect(res.body.event).toMatchObject({
      room_id: ROOM,
      sender: REMOTE_USER,
      type: 'm.room.member',
      state_key: REMOTE_USER,
      content: { membership: 'knock' },
      depth: 4,
    });
    expect(res.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
    expect(res.body.event.prev_events).toEqual([MEMBER]);
  });

  it('make_knock 403 when user banned or already joined', async () => {
    const { events, state } = knockBaseline('knock');
    const banned = await request(
      createEnv({
        db: createMembershipDb({
          events,
          state,
          memberships: [{ room_id: ROOM, user_id: REMOTE_USER, membership: 'ban' }],
        }),
      }),
      `/_matrix/federation/v1/make_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`
    );
    expect(banned.status).toBe(403);
    expect(banned.body.error).toMatch(/banned/i);

    const joined = await request(
      createEnv({
        db: createMembershipDb({
          events,
          state,
          memberships: [{ room_id: ROOM, user_id: REMOTE_USER, membership: 'join' }],
        }),
      }),
      `/_matrix/federation/v1/make_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`
    );
    expect(joined.status).toBe(403);
    expect(joined.body.error).toMatch(/already a member/i);
  });

  it('send_knock rejects bad JSON, non-knock, and event_id mismatch', async () => {
    const bad = await request(
      createEnv(),
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' }
    );
    expect(bad.status).toBe(400);

    const { events, state } = knockBaseline('knock');
    const env = createEnv({ db: createMembershipDb({ events, state }) });
    const notKnock = await request(
      env,
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', { type: 'm.room.member', content: { membership: 'join' } })
    );
    expect(notKnock.status).toBe(400);
    expect(notKnock.body.errcode).toBe('M_INVALID_PARAM');

    const mismatch = await request(
      env,
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', {
        type: 'm.room.member',
        content: { membership: 'knock' },
        event_id: '$other',
        state_key: REMOTE_USER,
        sender: REMOTE_USER,
      })
    );
    expect(mismatch.status).toBe(400);
  });

  it('send_knock 404 when room missing; 403 when knock disallowed', async () => {
    const missing = await request(
      createEnv({ db: createMembershipDb({ rooms: [] }) }),
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', {
        type: 'm.room.member',
        content: { membership: 'knock' },
        state_key: REMOTE_USER,
        sender: REMOTE_USER,
      })
    );
    expect(missing.status).toBe(404);

    const { events, state } = baseline();
    const forbidden = await request(
      createEnv({ db: createMembershipDb({ events, state }) }),
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', {
        type: 'm.room.member',
        content: { membership: 'knock' },
        state_key: REMOTE_USER,
        sender: REMOTE_USER,
      })
    );
    expect(forbidden.status).toBe(403);
  });

  it('send_knock stores knock and returns stripped knock_room_state', async () => {
    const { events, state } = knockBaseline('knock');
    const name = makeEvent({
      event_id: '$name',
      event_type: 'm.room.name',
      state_key: '',
      content: JSON.stringify({ name: 'Knock Lobby' }),
      depth: 2,
    });
    const avatar = makeEvent({
      event_id: '$avatar',
      event_type: 'm.room.avatar',
      state_key: '',
      content: JSON.stringify({ url: 'mxc://a/v' }),
      depth: 2,
    });
    const alias = makeEvent({
      event_id: '$alias',
      event_type: 'm.room.canonical_alias',
      state_key: '',
      content: JSON.stringify({ alias: '#lobby:example.com' }),
      depth: 2,
    });
    const allEvents = [...events, name, avatar, alias];
    const allState = [
      ...state,
      { room_id: ROOM, event_type: 'm.room.name', state_key: '', event_id: '$name' },
      { room_id: ROOM, event_type: 'm.room.avatar', state_key: '', event_id: '$avatar' },
      {
        room_id: ROOM,
        event_type: 'm.room.canonical_alias',
        state_key: '',
        event_id: '$alias',
      },
    ];
    const db = createMembershipDb({ events: allEvents, state: allState });
    const env = createEnv({ db });
    const res = await request(
      env,
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', {
        type: 'm.room.member',
        content: { membership: 'knock' },
        state_key: REMOTE_USER,
        sender: REMOTE_USER,
        origin_server_ts: NOW,
        depth: 5,
        auth_events: [CREATE, JOIN_RULES, POWER],
        prev_events: [MEMBER],
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.knock_room_state).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'm.room.name',
          content: { name: 'Knock Lobby' },
        }),
        expect.objectContaining({
          type: 'm.room.avatar',
          content: { url: 'mxc://a/v' },
        }),
        expect.objectContaining({
          type: 'm.room.join_rules',
          content: { join_rule: 'knock' },
        }),
        expect.objectContaining({
          type: 'm.room.canonical_alias',
          content: { alias: '#lobby:example.com' },
        }),
      ])
    );
    expect(db.memberships.some((m) => m.user_id === REMOTE_USER && m.membership === 'knock')).toBe(
      true
    );
    expect(db.events.some((e) => e.event_id === EVENT)).toBe(true);
  });

  it('send_knock 403 when user banned or already joined', async () => {
    const { events, state } = knockBaseline('knock');
    const banned = await request(
      createEnv({
        db: createMembershipDb({
          events,
          state,
          memberships: [{ room_id: ROOM, user_id: REMOTE_USER, membership: 'ban' }],
        }),
      }),
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', {
        type: 'm.room.member',
        content: { membership: 'knock' },
        state_key: REMOTE_USER,
        sender: REMOTE_USER,
      })
    );
    expect(banned.status).toBe(403);

    const joined = await request(
      createEnv({
        db: createMembershipDb({
          events,
          state,
          memberships: [{ room_id: ROOM, user_id: REMOTE_USER, membership: 'join' }],
        }),
      }),
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      jsonInit('PUT', {
        type: 'm.room.member',
        content: { membership: 'knock' },
        state_key: REMOTE_USER,
        sender: REMOTE_USER,
      })
    );
    expect(joined.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET/POST /publicRooms
// ---------------------------------------------------------------------------

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

describe('federation GET/POST /publicRooms', () => {
  it('GET lists public rooms with public info + pagination tokens', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0]).toMatchObject({
      room_id: ROOM,
      name: 'Lobby',
      topic: 'welcome friends',
      num_joined_members: 2,
      world_readable: true,
      guest_can_join: true,
      join_rule: 'public',
    });
    expect(res.body.total_room_count_estimate).toBe(2);
    expect(res.body.next_batch).toBe('offset_1');
    expect(res.body.prev_batch).toBeUndefined();

    const page2 = await request(
      env,
      '/_matrix/federation/v1/publicRooms?limit=1&since=offset_1'
    );
    expect(page2.body.chunk[0].room_id).toBe(ROOM2);
    expect(page2.body.prev_batch).toBe('offset_0');
    expect(page2.body.next_batch).toBeUndefined();
  });

  it('GET ignores include_all_networks and clamps limit', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms?limit=9999&include_all_networks=true'
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(2);
  });

  it('GET treats malformed since as offset 0', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms?since=nope');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
  });

  it('POST rejects bad JSON', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/publicRooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
  });

  it('POST without filter mirrors GET listing', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(env, '/_matrix/federation/v1/publicRooms', jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((c: { room_id: string }) => c.room_id)).toEqual([ROOM, ROOM2]);
  });

  it('POST filters by generic_search_term across name/topic/alias', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const byName = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: 'Lobby' }, limit: 10 })
    );
    expect(byName.body.chunk.map((c: { room_id: string }) => c.room_id)).toEqual([ROOM]);

    const byTopic = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: 'friends' } })
    );
    expect(byTopic.body.chunk).toHaveLength(1);

    const byAlias = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: '#lobby' } })
    );
    expect(byAlias.body.chunk).toHaveLength(1);

    const none = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { filter: { generic_search_term: 'zzzz-no-match' } })
    );
    expect(none.body.chunk).toEqual([]);
  });

  it('POST pagination with since + next_batch', async () => {
    const fixture = publicRoomFixture();
    const env = createEnv({ db: createMembershipDb(fixture) });
    const res = await request(
      env,
      '/_matrix/federation/v1/publicRooms',
      jsonInit('POST', { limit: 1, since: 'offset_0' })
    );
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.next_batch).toBe('offset_1');
  });
});

// ---------------------------------------------------------------------------
// GET /hierarchy/:roomId
// ---------------------------------------------------------------------------

describe('federation GET /hierarchy/:roomId', () => {
  function spaceFixture() {
    const childA = '!childA:example.com';
    const childB = '!childB:example.com';
    const childGone = '!gone:example.com';
    const spaceCreate = makeEvent({
      event_id: '$screate',
      room_id: SPACE,
      event_type: 'm.room.create',
      state_key: '',
      content: JSON.stringify({ creator: USER, type: 'm.space' }),
      depth: 1,
    });
    const spaceName = makeEvent({
      event_id: '$sname',
      room_id: SPACE,
      event_type: 'm.room.name',
      state_key: '',
      content: JSON.stringify({ name: 'Space' }),
      depth: 2,
    });
    const ca = makeEvent({
      event_id: '$ca',
      room_id: SPACE,
      event_type: 'm.space.child',
      state_key: childA,
      content: JSON.stringify({ via: [SERVER], suggested: true }),
      depth: 3,
    });
    const cb = makeEvent({
      event_id: '$cb',
      room_id: SPACE,
      event_type: 'm.space.child',
      state_key: childB,
      content: JSON.stringify({ via: [SERVER], suggested: false }),
      depth: 3,
    });
    const cg = makeEvent({
      event_id: '$cg',
      room_id: SPACE,
      event_type: 'm.space.child',
      state_key: childGone,
      content: JSON.stringify({ via: [], suggested: true }),
      depth: 3,
    });
    const childAName = makeEvent({
      event_id: '$caname',
      room_id: childA,
      event_type: 'm.room.name',
      state_key: '',
      content: JSON.stringify({ name: 'Child A' }),
    });
    const childBName = makeEvent({
      event_id: '$cbname',
      room_id: childB,
      event_type: 'm.room.name',
      state_key: '',
      content: JSON.stringify({ name: 'Child B' }),
    });
    return {
      childA,
      childB,
      childGone,
      rooms: [
        { room_id: SPACE, room_version: '10', is_public: 1, created_at: NOW },
        { room_id: childA, room_version: '10', is_public: 1, created_at: NOW },
        { room_id: childB, room_version: '10', is_public: 1, created_at: NOW },
      ],
      events: [spaceCreate, spaceName, ca, cb, cg, childAName, childBName],
      state: [
        {
          room_id: SPACE,
          event_type: 'm.room.create',
          state_key: '',
          event_id: '$screate',
        },
        { room_id: SPACE, event_type: 'm.room.name', state_key: '', event_id: '$sname' },
        { room_id: SPACE, event_type: 'm.space.child', state_key: childA, event_id: '$ca' },
        { room_id: SPACE, event_type: 'm.space.child', state_key: childB, event_id: '$cb' },
        {
          room_id: SPACE,
          event_type: 'm.space.child',
          state_key: childGone,
          event_id: '$cg',
        },
        {
          room_id: childA,
          event_type: 'm.room.name',
          state_key: '',
          event_id: '$caname',
        },
        {
          room_id: childB,
          event_type: 'm.room.name',
          state_key: '',
          event_id: '$cbname',
        },
      ],
    };
  }

  it('404 when space missing', async () => {
    const res = await request(
      createEnv({ db: createMembershipDb({ rooms: [] }) }),
      `/_matrix/federation/v1/hierarchy/${encodeURIComponent(SPACE)}`
    );
    expect(res.status).toBe(404);
  });

  it('returns room + children_state + children; skips empty via', async () => {
    const fx = spaceFixture();
    const env = createEnv({
      db: createMembershipDb({ rooms: fx.rooms, events: fx.events, state: fx.state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/hierarchy/${encodeURIComponent(SPACE)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.room.room_id).toBe(SPACE);
    expect(res.body.room.name).toBe('Space');
    expect(res.body.room.room_type).toBe('m.space');
    expect(res.body.room.children_state).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'm.space.child', state_key: fx.childA }),
        expect.objectContaining({ type: 'm.space.child', state_key: fx.childB }),
      ])
    );
    expect(res.body.children.map((c: { room_id: string }) => c.room_id).sort()).toEqual(
      [fx.childA, fx.childB].sort()
    );
    expect(res.body.children.every((c: { children_state: unknown[] }) => c.children_state.length === 0)).toBe(
      true
    );
    expect(res.body.inaccessible_children).toEqual([]);
  });

  it('suggested_only=true skips non-suggested children', async () => {
    const fx = spaceFixture();
    const env = createEnv({
      db: createMembershipDb({ rooms: fx.rooms, events: fx.events, state: fx.state }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/hierarchy/${encodeURIComponent(SPACE)}?suggested_only=true`
    );
    expect(res.body.children.map((c: { room_id: string }) => c.room_id)).toEqual([fx.childA]);
  });

  it('paginates children with from=offset_N and next_batch', async () => {
    const fx = spaceFixture();
    const env = createEnv({
      db: createMembershipDb({ rooms: fx.rooms, events: fx.events, state: fx.state }),
    });
    const page1 = await request(
      env,
      `/_matrix/federation/v1/hierarchy/${encodeURIComponent(SPACE)}?limit=1`
    );
    expect(page1.body.room.room_id).toBe(SPACE);
    expect(page1.body.children).toHaveLength(1);
    expect(page1.body.next_batch).toBe('offset_1');

    const page2 = await request(
      env,
      `/_matrix/federation/v1/hierarchy/${encodeURIComponent(SPACE)}?limit=1&from=offset_1`
    );
    // offset>0: space itself omitted; rooms[0] becomes `room` (first child page)
    expect(page2.body.room).not.toBeNull();
    expect(page2.body.room.room_id).not.toBe(SPACE);
    expect(page2.body.children).toHaveLength(0);
    // SQL still sees the empty-via child as a row, so next_batch advances
    expect(page2.body.next_batch).toBe('offset_2');

    const page3 = await request(
      env,
      `/_matrix/federation/v1/hierarchy/${encodeURIComponent(SPACE)}?limit=1&from=offset_2`
    );
    // empty-via child skipped → no rooms on this page
    expect(page3.body.room).toBeNull();
    expect(page3.body.children).toEqual([]);
    expect(page3.body.next_batch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GET /timestamp_to_event/:roomId
// ---------------------------------------------------------------------------

describe('federation GET /timestamp_to_event/:roomId', () => {
  it('requires positive ts', async () => {
    const missing = await request(
      createEnv(),
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}`
    );
    expect(missing.status).toBe(400);
    expect(missing.body.errcode).toBe('M_MISSING_PARAM');

    const zero = await request(
      createEnv(),
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=0`
    );
    expect(zero.status).toBe(400);
  });

  it('404 when room missing', async () => {
    const res = await request(
      createEnv({ db: createMembershipDb({ rooms: [] }) }),
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=${NOW}`
    );
    expect(res.status).toBe(404);
  });

  it('dir=f finds earliest event at-or-after ts; dir=b at-or-before', async () => {
    const e1 = makeEvent({ event_id: '$e1', origin_server_ts: NOW - 100, depth: 1 });
    const e2 = makeEvent({ event_id: '$e2', origin_server_ts: NOW, depth: 2 });
    const e3 = makeEvent({ event_id: '$e3', origin_server_ts: NOW + 100, depth: 3 });
    const env = createEnv({
      db: createMembershipDb({ events: [e1, e2, e3] }),
    });

    const forward = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=${NOW - 50}&dir=f`
    );
    expect(forward.body).toEqual({ event_id: '$e2', origin_server_ts: NOW });

    const backward = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=${NOW - 50}&dir=b`
    );
    expect(backward.body).toEqual({ event_id: '$e1', origin_server_ts: NOW - 100 });

    // default dir is f
    const def = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=${NOW + 50}`
    );
    expect(def.body.event_id).toBe('$e3');
  });

  it('404 when no event near timestamp', async () => {
    const e1 = makeEvent({ event_id: '$e1', origin_server_ts: NOW, depth: 1 });
    const env = createEnv({ db: createMembershipDb({ events: [e1] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=${NOW + 999}&dir=f`
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /openid/userinfo
// ---------------------------------------------------------------------------

describe('federation GET /openid/userinfo', () => {
  it('requires access_token', async () => {
    const res = await request(createEnv(), '/_matrix/federation/v1/openid/userinfo');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('401 for unknown token', async () => {
    const res = await request(
      createEnv(),
      '/_matrix/federation/v1/openid/userinfo?access_token=nope'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('returns sub for valid token', async () => {
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

  it('401 and deletes expired token', async () => {
    const kv = mockKv({
      'openid:old': JSON.stringify({ user_id: USER, expires_at: NOW - 1 }),
    });
    const res = await request(
      createEnv({ sessionsKv: kv }),
      '/_matrix/federation/v1/openid/userinfo?access_token=old'
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
    expect(kv.deletes).toContain('openid:old');
  });
});
