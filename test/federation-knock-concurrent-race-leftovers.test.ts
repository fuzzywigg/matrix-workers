/**
 * TOKENMAXX HEAVY leftovers after #275 — tertiary *federation knock protocol*
 * concurrent-race niches not covered by admin+federation second-wave (#275),
 * residual (#270/#265), or sequential unit coverage in
 * federation-membership-state-api-routes / federation-api-routes.
 *
 * Slice claimed: make_knock / send_knock leftover soft floods + Promise.all
 * races. #275 stayed on send/hash/EDU/media/openid + admin IdP; knock had
 * zero *leftover* soft/race describes.
 *
 * Distinct from #275 second-wave:
 *   legacy-v1∥hash-v10; custom-reject∥auth-fallback; Cache-Control∥octet;
 *   typing∥noop EDU; openid success∥invalid; missing-origin serial dual.
 *
 * Tertiary deepen after #275 tip (knock protocol):
 *   make_knock 404∥200 template; invite/missing-jr forbid∥knock ok;
 *   knock_restricted∥knock both membership knock; ban∥join exact errors;
 *   invite/leave/knock existing membership still 200; auth_events order +
 *   depth=latest+1 dual GET coherency; send_knock bad JSON∥non-knock;
 *   event_id mismatch∥omit falsy skip; missing room∥invite 403 isolation;
 *   ban∥join∥success knock_room_state triple; dual-user stripped state;
 *   depth||0 when missing; INSERT throw swallowed still returns state;
 *   join_rule soft matrix flood.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 * Reversible by deleting this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

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
const REMOTE_USER = '@carol:remote.example.org';
const REMOTE_USER_B = '@dave:remote.example.org';
const USER = '@alice:example.com';
const ROOM = '!room:example.com';
const EVENT = '$knock:example.com';
const EVENT_B = '$knock_b:example.com';
const CREATE = '$create:example.com';
const JOIN_RULES = '$join_rules:example.com';
const POWER = '$power:example.com';
const MEMBER = '$member:example.com';
const NOW = 1_700_000_000_000;

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

type RoomRow = { room_id: string; room_version: string };
type MembershipRow = { room_id: string; user_id: string; membership: string };
type SqlCall = { sql: string; args: unknown[] };

function mockKv(data: Record<string, string> = {}) {
  return {
    data,
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
    },
    delete: async (key: string) => {
      delete data[key];
    },
  } as unknown as KVNamespace & { data: Record<string, string> };
}

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

function createKnockDb(
  opts: {
    rooms?: RoomRow[];
    events?: EventRow[];
    state?: StateRow[];
    memberships?: MembershipRow[];
    throwOnInsert?: boolean;
  } = {}
) {
  const rooms = opts.rooms ?? [{ room_id: ROOM, room_version: '10' }];
  const events = opts.events ?? [];
  const state = opts.state ?? [];
  const memberships = opts.memberships ?? [];
  const selects: SqlCall[] = [];
  const inserts: SqlCall[] = [];

  const findState = (roomId: string, eventType: string, stateKey?: string) =>
    state.find(
      (s) =>
        s.room_id === roomId &&
        s.event_type === eventType &&
        (stateKey === undefined || s.state_key === stateKey)
    );

  const eventById = (id: string) => events.find((e) => e.event_id === id);

  const db = {
    rooms,
    events,
    state,
    memberships,
    selects,
    inserts,
    prepare(sql: string) {
      const exec = (args: unknown[]) => ({
        async first<T>() {
          selects.push({ sql, args });

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

          for (const t of [
            'm.room.join_rules',
            'm.room.name',
            'm.room.avatar',
            'm.room.canonical_alias',
            'm.room.create',
            'm.room.power_levels',
          ]) {
            if (!sql.includes(`rs.event_type = '${t}'`)) continue;
            const s = findState(args[0] as string, t);
            const ev = s ? eventById(s.event_id) : undefined;
            if (!ev) return null as T;
            if (sql.includes('SELECT e.event_id') && !sql.includes('e.content')) {
              return { event_id: s!.event_id } as T;
            }
            if (sql.includes('e.event_type')) {
              return {
                event_type: ev.event_type,
                state_key: ev.state_key ?? '',
                content: ev.content,
                sender: ev.sender,
                origin_server_ts: ev.origin_server_ts,
              } as T;
            }
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

          throw new Error(`Unhandled first() SQL: ${sql.slice(0, 180)}`);
        },

        async all<T>() {
          selects.push({ sql, args });
          return { results: [] } as unknown as T;
        },

        async run() {
          inserts.push({ sql, args });
          if (opts.throwOnInsert && sql.includes('INSERT')) {
            throw new Error('forced insert failure');
          }
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
            const [roomId, eventType, stateKey, eventId] = args as [
              string,
              string,
              string,
              string,
            ];
            const idx = state.findIndex(
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
            if (idx >= 0) state[idx] = row;
            else state.push(row);
          }
          if (sql.includes('INSERT') && sql.includes('INTO room_memberships')) {
            // send_knock: VALUES (?, ?, 'knock', ?)
            if (sql.includes("'knock'")) {
              const rid = args[0] as string;
              const uid = args[1] as string;
              const midx = memberships.findIndex(
                (m) => m.room_id === rid && m.user_id === uid
              );
              const mrow = { room_id: rid, user_id: uid, membership: 'knock' };
              if (midx >= 0) memberships[midx] = mrow;
              else memberships.push(mrow);
            }
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
  db?: ReturnType<typeof createKnockDb>;
  federationOrigin?: string | null;
} = {}): Env {
  federationOriginSideChannel = opts.federationOrigin ?? 'remote.example.org';
  const db = opts.db ?? createKnockDb();
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    SESSIONS: mockKv() as unknown as KVNamespace,
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

function baseline(joinRule: string = 'public') {
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
    content: JSON.stringify({ join_rule: joinRule }),
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

function knockBaseline(joinRule: string = 'knock') {
  return baseline(joinRule);
}

function withStrippedState(joinRule: string = 'knock') {
  const { events, state } = knockBaseline(joinRule);
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
    content: JSON.stringify({ url: 'mxc://example.com/av' }),
    depth: 2,
  });
  const alias = makeEvent({
    event_id: '$alias',
    event_type: 'm.room.canonical_alias',
    state_key: '',
    content: JSON.stringify({ alias: '#lobby:example.com' }),
    depth: 2,
  });
  return {
    events: [...events, name, avatar, alias],
    state: [
      ...state,
      { room_id: ROOM, event_type: 'm.room.name', state_key: '', event_id: '$name' },
      { room_id: ROOM, event_type: 'm.room.avatar', state_key: '', event_id: '$avatar' },
      {
        room_id: ROOM,
        event_type: 'm.room.canonical_alias',
        state_key: '',
        event_id: '$alias',
      },
    ],
  };
}

function knockBody(
  extras: Record<string, unknown> = {},
  userId: string = REMOTE_USER
): Record<string, unknown> {
  return {
    type: 'm.room.member',
    content: { membership: 'knock' },
    state_key: userId,
    sender: userId,
    origin_server_ts: NOW,
    depth: 5,
    auth_events: [CREATE, JOIN_RULES, POWER],
    prev_events: [MEMBER],
    ...extras,
  };
}

function makeKnockPath(roomId: string = ROOM, userId: string = REMOTE_USER) {
  return `/_matrix/federation/v1/make_knock/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`;
}

function sendKnockPath(roomId: string = ROOM, eventId: string = EVENT) {
  return `/_matrix/federation/v1/send_knock/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}`;
}

beforeEach(() => {
  federationOriginSideChannel = 'remote.example.org';
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  federationOriginSideChannel = null;
});

// ---------------------------------------------------------------------------
// Soft flood: join_rule matrix (unit covered sequentially; not leftover-flooded)
// ---------------------------------------------------------------------------

describe('soft tertiary federation knock join_rule matrix after #275', () => {
  for (const rule of ['public', 'invite', 'restricted'] as const) {
    for (let i = 0; i < 4; i++) {
      it(`make_knock ${rule} → 403 Room does not allow knocking flood-${i}`, async () => {
        const { events, state } = knockBaseline(rule);
        const res = await request(
          createEnv({ db: createKnockDb({ events, state }) }),
          makeKnockPath()
        );
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({
          errcode: 'M_FORBIDDEN',
          error: 'Room does not allow knocking',
        });
      });
    }
  }

  for (const rule of ['knock', 'knock_restricted'] as const) {
    for (let i = 0; i < 4; i++) {
      it(`make_knock ${rule} → 200 membership knock flood-${i}`, async () => {
        const { events, state } = knockBaseline(rule);
        const res = await request(
          createEnv({ db: createKnockDb({ events, state }) }),
          makeKnockPath()
        );
        expect(res.status).toBe(200);
        expect(res.body.room_version).toBe('10');
        expect(res.body.event.content.membership).toBe('knock');
        expect(res.body.event.type).toBe('m.room.member');
        expect(res.body.event.state_key).toBe(REMOTE_USER);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Race: make_knock missing room ∥ knock template
// ---------------------------------------------------------------------------

describe('race tertiary make_knock 404∥200 template after #275', () => {
  for (let i = 0; i < 10; i++) {
    it(`missing room 404 ∥ knock template 200 flood-${i}`, async () => {
      const { events, state } = knockBaseline('knock');
      const [missing, ok] = await Promise.all([
        request(createEnv({ db: createKnockDb({ rooms: [] }) }), makeKnockPath()),
        request(
          createEnv({ db: createKnockDb({ events, state }) }),
          makeKnockPath()
        ),
      ]);
      expect(missing.status).toBe(404);
      expect(missing.body.errcode).toBe('M_NOT_FOUND');
      expect(ok.status).toBe(200);
      expect(ok.body.event.content.membership).toBe('knock');
      expect(ok.body.event.depth).toBe(4); // latest member depth 3 + 1
      expect(ok.body.event.prev_events).toEqual([MEMBER]);
    });
  }
});

// ---------------------------------------------------------------------------
// Race: invite / missing join_rules forbid ∥ knock ok
// ---------------------------------------------------------------------------

describe('race tertiary make_knock invite∥missing-jr∥knock after #275', () => {
  for (let i = 0; i < 10; i++) {
    it(`invite+missing-jr forbid ∥ knock ok under Promise.all flood-${i}`, async () => {
      const invite = knockBaseline('invite');
      const knock = knockBaseline('knock');
      const { events: baseEvents, state: baseState } = baseline('public');
      const noJrState = baseState.filter((s) => s.event_type !== 'm.room.join_rules');

      const [forbidInvite, forbidMissing, ok] = await Promise.all([
        request(
          createEnv({ db: createKnockDb({ events: invite.events, state: invite.state }) }),
          makeKnockPath()
        ),
        request(
          createEnv({
            db: createKnockDb({ events: baseEvents, state: noJrState }),
          }),
          makeKnockPath()
        ),
        request(
          createEnv({ db: createKnockDb({ events: knock.events, state: knock.state }) }),
          makeKnockPath()
        ),
      ]);
      expect([forbidInvite.status, forbidMissing.status, ok.status]).toEqual([403, 403, 200]);
      expect(forbidInvite.body.error).toBe('Room does not allow knocking');
      expect(forbidMissing.body.error).toBe('Room does not allow knocking');
      expect(ok.body.event.content.membership).toBe('knock');
    });
  }
});

// ---------------------------------------------------------------------------
// Race: knock_restricted ∥ knock both 200
// ---------------------------------------------------------------------------

describe('race tertiary make_knock knock_restricted∥knock after #275', () => {
  for (let i = 0; i < 10; i++) {
    it(`knock_restricted∥knock dual 200 membership knock flood-${i}`, async () => {
      const a = knockBaseline('knock_restricted');
      const b = knockBaseline('knock');
      const [restricted, plain] = await Promise.all([
        request(
          createEnv({ db: createKnockDb({ events: a.events, state: a.state }) }),
          makeKnockPath()
        ),
        request(
          createEnv({ db: createKnockDb({ events: b.events, state: b.state }) }),
          makeKnockPath()
        ),
      ]);
      expect([restricted.status, plain.status]).toEqual([200, 200]);
      expect(restricted.body.event.content.membership).toBe('knock');
      expect(plain.body.event.content.membership).toBe('knock');
      expect(restricted.body.event.auth_events).toEqual(
        expect.arrayContaining([CREATE, JOIN_RULES, POWER])
      );
      expect(plain.body.event.auth_events).toEqual(
        expect.arrayContaining([CREATE, JOIN_RULES, POWER])
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Race: ban ∥ join exact error strings
// ---------------------------------------------------------------------------

describe('race tertiary make_knock ban∥join exact errors after #275', () => {
  for (let i = 0; i < 10; i++) {
    it(`ban∥join distinct M_FORBIDDEN strings flood-${i}`, async () => {
      const { events, state } = knockBaseline('knock');
      const [banned, joined] = await Promise.all([
        request(
          createEnv({
            db: createKnockDb({
              events,
              state,
              memberships: [
                { room_id: ROOM, user_id: REMOTE_USER, membership: 'ban' },
              ],
            }),
          }),
          makeKnockPath()
        ),
        request(
          createEnv({
            db: createKnockDb({
              events,
              state,
              memberships: [
                { room_id: ROOM, user_id: REMOTE_USER, membership: 'join' },
              ],
            }),
          }),
          makeKnockPath()
        ),
      ]);
      expect([banned.status, joined.status]).toEqual([403, 403]);
      expect(banned.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'User is banned from this room',
      });
      expect(joined.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'User is already a member of this room',
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Race: invite/leave/knock membership still 200 (only ban/join gated)
// ---------------------------------------------------------------------------

describe('race tertiary make_knock invite/leave/knock membership 200 after #275', () => {
  for (const mem of ['invite', 'leave', 'knock'] as const) {
    for (let i = 0; i < 4; i++) {
      it(`existing ${mem} membership still 200 ∥ ban sibling 403 flood-${i}`, async () => {
        const { events, state } = knockBaseline('knock');
        const [ok, ban] = await Promise.all([
          request(
            createEnv({
              db: createKnockDb({
                events,
                state,
                memberships: [
                  { room_id: ROOM, user_id: REMOTE_USER, membership: mem },
                ],
              }),
            }),
            makeKnockPath()
          ),
          request(
            createEnv({
              db: createKnockDb({
                events,
                state,
                memberships: [
                  { room_id: ROOM, user_id: REMOTE_USER, membership: 'ban' },
                ],
              }),
            }),
            makeKnockPath()
          ),
        ]);
        // Source gates only ban/join — invite/leave/knock proceed to template
        expect(ok.status).toBe(200);
        expect(ok.body.event.content.membership).toBe('knock');
        expect(ban.status).toBe(403);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Race: auth_events order create→join_rules→power + depth coherency
// ---------------------------------------------------------------------------

describe('race tertiary make_knock auth_events order + depth after #275', () => {
  for (let i = 0; i < 10; i++) {
    it(`dual GET auth_events order create→jr→pl + depth=latest+1 flood-${i}`, async () => {
      const { events, state } = knockBaseline('knock');
      const env = createEnv({ db: createKnockDb({ events, state }) });
      const [a, b] = await Promise.all([
        request(env, makeKnockPath()),
        request(env, makeKnockPath()),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      // Product pushes create, then join_rules, then power_levels in that order
      expect(a.body.event.auth_events).toEqual([CREATE, JOIN_RULES, POWER]);
      expect(b.body.event.auth_events).toEqual([CREATE, JOIN_RULES, POWER]);
      expect(a.body.event.depth).toBe(4);
      expect(b.body.event.depth).toBe(4);
      expect(a.body.event.prev_events).toEqual([MEMBER]);
      expect(b.body.event.origin_server_ts).toBe(NOW);
    });
  }
});

// ---------------------------------------------------------------------------
// Race: send_knock bad JSON ∥ non-knock membership
// ---------------------------------------------------------------------------

describe('race tertiary send_knock bad JSON∥non-knock after #275', () => {
  for (let i = 0; i < 10; i++) {
    it(`bad JSON ∥ join-membership body ∥ knock ok flood-${i}`, async () => {
      const { events, state } = withStrippedState('knock');
      const envOk = createEnv({ db: createKnockDb({ events, state }) });
      const envBad = createEnv({ db: createKnockDb({ events, state }) });

      const [badJson, notKnock, ok] = await Promise.all([
        request(envBad, sendKnockPath(), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        }),
        request(
          envBad,
          sendKnockPath(ROOM, `$nk_${i}`),
          jsonInit('PUT', {
            type: 'm.room.member',
            content: { membership: 'join' },
            state_key: REMOTE_USER,
            sender: REMOTE_USER,
          })
        ),
        request(
          envOk,
          sendKnockPath(ROOM, `$ok_${i}`),
          jsonInit('PUT', knockBody())
        ),
      ]);
      expect(badJson.status).toBe(400);
      expect(badJson.body.errcode).toBe('M_BAD_JSON');
      expect(notKnock.status).toBe(400);
      expect(notKnock.body).toMatchObject({
        errcode: 'M_INVALID_PARAM',
        error: 'Event is not a knock event',
      });
      expect(ok.status).toBe(200);
      expect(Array.isArray(ok.body.knock_room_state)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Race: event_id mismatch ∥ omit event_id falsy skip
// ---------------------------------------------------------------------------

describe('race tertiary send_knock mismatch∥omit event_id after #275', () => {
  for (let i = 0; i < 10; i++) {
    it(`mismatch 400 ∥ omit event_id proceeds 200 flood-${i}`, async () => {
      const stripped = withStrippedState('knock');
      const [mismatch, omit] = await Promise.all([
        request(
          createEnv({
            db: createKnockDb({ events: stripped.events, state: stripped.state }),
          }),
          sendKnockPath(ROOM, `$path_${i}`),
          jsonInit(
            'PUT',
            knockBody({ event_id: `$other_${i}` })
          )
        ),
        request(
          createEnv({
            db: createKnockDb({ events: stripped.events, state: stripped.state }),
          }),
          sendKnockPath(ROOM, `$omit_${i}`),
          // no event_id in body → falsy skip of mismatch gate
          jsonInit('PUT', knockBody())
        ),
      ]);
      expect(mismatch.status).toBe(400);
      expect(mismatch.body).toMatchObject({
        errcode: 'M_INVALID_PARAM',
        error: 'Event ID mismatch',
      });
      expect(omit.status).toBe(200);
      expect(omit.body.knock_room_state).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'm.room.name' }),
          expect.objectContaining({ type: 'm.room.join_rules' }),
        ])
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Race: send_knock missing room ∥ invite join_rule 403
// ---------------------------------------------------------------------------

describe('race tertiary send_knock missing∥invite forbid after #275', () => {
  for (let i = 0; i < 10; i++) {
    it(`missing room 404 ∥ invite join_rule 403 isolation flood-${i}`, async () => {
      const invite = knockBaseline('invite');
      const [missing, forbid] = await Promise.all([
        request(
          createEnv({ db: createKnockDb({ rooms: [] }) }),
          sendKnockPath(),
          jsonInit('PUT', knockBody())
        ),
        request(
          createEnv({
            db: createKnockDb({ events: invite.events, state: invite.state }),
          }),
          sendKnockPath(),
          jsonInit('PUT', knockBody())
        ),
      ]);
      expect([missing.status, forbid.status]).toEqual([404, 403]);
      expect(missing.body.errcode).toBe('M_NOT_FOUND');
      expect(forbid.body.error).toBe('Room does not allow knocking');
    });
  }
});

// ---------------------------------------------------------------------------
// Race: ban ∥ join ∥ success knock_room_state triple
// ---------------------------------------------------------------------------

describe('race tertiary send_knock ban∥join∥success triple after #275', () => {
  for (let i = 0; i < 10; i++) {
    it(`ban∥join forbid ∥ success stripped state flood-${i}`, async () => {
      const stripped = withStrippedState('knock');
      const eid = `$triple_${i}`;
      const [banned, joined, ok] = await Promise.all([
        request(
          createEnv({
            db: createKnockDb({
              events: stripped.events,
              state: stripped.state,
              memberships: [
                { room_id: ROOM, user_id: REMOTE_USER, membership: 'ban' },
              ],
            }),
          }),
          sendKnockPath(ROOM, `${eid}_ban`),
          jsonInit('PUT', knockBody())
        ),
        request(
          createEnv({
            db: createKnockDb({
              events: stripped.events,
              state: stripped.state,
              memberships: [
                { room_id: ROOM, user_id: REMOTE_USER, membership: 'join' },
              ],
            }),
          }),
          sendKnockPath(ROOM, `${eid}_join`),
          jsonInit('PUT', knockBody())
        ),
        request(
          createEnv({
            db: createKnockDb({
              events: stripped.events,
              state: stripped.state,
            }),
          }),
          sendKnockPath(ROOM, eid),
          jsonInit('PUT', knockBody())
        ),
      ]);
      expect([banned.status, joined.status, ok.status]).toEqual([403, 403, 200]);
      expect(banned.body.error).toBe('User is banned from this room');
      expect(joined.body.error).toBe('User is already a member of this room');
      expect(ok.body.knock_room_state).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'm.room.name',
            content: { name: 'Knock Lobby' },
          }),
          expect.objectContaining({
            type: 'm.room.avatar',
            content: { url: 'mxc://example.com/av' },
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
    });
  }
});

// ---------------------------------------------------------------------------
// Race: dual-user send_knock → both knock memberships + stripped state
// ---------------------------------------------------------------------------

describe('race tertiary send_knock dual-user stripped state after #275', () => {
  for (let i = 0; i < 10; i++) {
    it(`dual distinct users both knock + knock_room_state flood-${i}`, async () => {
      const stripped = withStrippedState('knock');
      const db = createKnockDb({ events: stripped.events, state: stripped.state });
      const env = createEnv({ db });
      const [a, b] = await Promise.all([
        request(
          env,
          sendKnockPath(ROOM, `${EVENT}_${i}_a`),
          jsonInit('PUT', knockBody({}, REMOTE_USER))
        ),
        request(
          env,
          sendKnockPath(ROOM, `${EVENT_B}_${i}_b`),
          jsonInit('PUT', knockBody({}, REMOTE_USER_B))
        ),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body.knock_room_state.length).toBeGreaterThanOrEqual(2);
      expect(b.body.knock_room_state.length).toBeGreaterThanOrEqual(2);
      expect(
        db.memberships.some(
          (m) => m.user_id === REMOTE_USER && m.membership === 'knock'
        )
      ).toBe(true);
      expect(
        db.memberships.some(
          (m) => m.user_id === REMOTE_USER_B && m.membership === 'knock'
        )
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Race: depth||0 when depth missing; INSERT throw still returns knock_room_state
// ---------------------------------------------------------------------------

describe('race tertiary send_knock depth||0 + insert-swallow after #275', () => {
  for (let i = 0; i < 8; i++) {
    it(`missing depth→0 store ∥ sibling with depth flood-${i}`, async () => {
      const stripped = withStrippedState('knock');
      const dbNoDepth = createKnockDb({
        events: [...stripped.events],
        state: [...stripped.state],
      });
      const dbDepth = createKnockDb({
        events: [...stripped.events],
        state: [...stripped.state],
      });
      const bodyNoDepth = knockBody();
      delete bodyNoDepth.depth;

      const [noDepth, withDepth] = await Promise.all([
        request(
          createEnv({ db: dbNoDepth }),
          sendKnockPath(ROOM, `$nd_${i}`),
          jsonInit('PUT', bodyNoDepth)
        ),
        request(
          createEnv({ db: dbDepth }),
          sendKnockPath(ROOM, `$wd_${i}`),
          jsonInit('PUT', knockBody({ depth: 9 }))
        ),
      ]);
      expect([noDepth.status, withDepth.status]).toEqual([200, 200]);
      const storedNd = dbNoDepth.events.find((e) => e.event_id === `$nd_${i}`);
      const storedWd = dbDepth.events.find((e) => e.event_id === `$wd_${i}`);
      // Product uses body.depth || 0
      expect(storedNd?.depth).toBe(0);
      expect(storedWd?.depth).toBe(9);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`INSERT throw swallowed → still knock_room_state ∥ ok sibling flood-${i}`, async () => {
      const stripped = withStrippedState('knock');
      const [swallowed, ok] = await Promise.all([
        request(
          createEnv({
            db: createKnockDb({
              events: stripped.events,
              state: stripped.state,
              throwOnInsert: true,
            }),
          }),
          sendKnockPath(ROOM, `$sw_${i}`),
          jsonInit('PUT', knockBody())
        ),
        request(
          createEnv({
            db: createKnockDb({
              events: stripped.events,
              state: stripped.state,
            }),
          }),
          sendKnockPath(ROOM, `$ok_${i}`),
          jsonInit('PUT', knockBody())
        ),
      ]);
      // catch only logs — still returns { knock_room_state }
      expect(swallowed.status).toBe(200);
      expect(Array.isArray(swallowed.body.knock_room_state)).toBe(true);
      expect(ok.status).toBe(200);
      expect(ok.body.knock_room_state).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'm.room.name' }),
        ])
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Soft: wrong methods on knock paths
// ---------------------------------------------------------------------------

describe('soft tertiary federation knock method matrix after #275', () => {
  for (let i = 0; i < 6; i++) {
    it(`POST/PUT make_knock + GET/POST send_knock reject flood-${i}`, async () => {
      const { events, state } = knockBaseline('knock');
      const env = createEnv({ db: createKnockDb({ events, state }) });
      const [postMake, putMake, getSend, postSend] = await Promise.all([
        request(env, makeKnockPath(), { method: 'POST' }),
        request(env, makeKnockPath(), { method: 'PUT' }),
        request(env, sendKnockPath(), { method: 'GET' }),
        request(env, sendKnockPath(), jsonInit('POST', knockBody())),
      ]);
      // Hono returns 404/405 for unmatched methods on these routes
      expect([postMake.status, putMake.status].every((s) => s === 404 || s === 405)).toBe(
        true
      );
      expect([getSend.status, postSend.status].every((s) => s === 404 || s === 405)).toBe(
        true
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Race: make_knock template ∥ send_knock success on same room isolation
// ---------------------------------------------------------------------------

describe('race tertiary make_knock∥send_knock same-room isolation after #275', () => {
  for (let i = 0; i < 10; i++) {
    it(`template GET ∥ send success stripped isolation flood-${i}`, async () => {
      const stripped = withStrippedState('knock');
      const [template, sent] = await Promise.all([
        request(
          createEnv({
            db: createKnockDb({ events: stripped.events, state: stripped.state }),
          }),
          makeKnockPath()
        ),
        request(
          createEnv({
            db: createKnockDb({ events: stripped.events, state: stripped.state }),
          }),
          sendKnockPath(ROOM, `$iso_${i}`),
          jsonInit('PUT', knockBody())
        ),
      ]);
      expect([template.status, sent.status]).toEqual([200, 200]);
      expect(template.body.event.content.membership).toBe('knock');
      expect(template.body.event.depth).toBe(4);
      expect(sent.body.knock_room_state).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'm.room.join_rules' }),
        ])
      );
    });
  }
});
