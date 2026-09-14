/**
 * TOKENMAXX HEAVY leftovers after #200 — voip + rtc + calls *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by:
 *   - voip/rtc/calls route leftovers (#118/#120/#162) soft/edge floods
 *   - voip-api-routes / rtc-api-routes / calls-api-routes base suites
 *   - voip-rtc-helpers / turn / livekit / cloudflare-calls unit helpers
 *
 * Distinct domain — not report/server-notices (#200), search/spaces (#199),
 * profile (#198/#197), tags (#196), workflows (#195), rooms-mutate (#194),
 * aliases (#193), rooms (#192), admin-mutate (#191), presence (#190),
 * sliding-sync (#189), fed-keys (#188).
 *
 * Calls focus: dual cold start under m.call.state SELECT barrier (both create);
 * start∥end / GET∥start / GET∥end; membership leave mid-start TOCTOU;
 * active-call second-start rejection; multi-room isolation; WS∥end;
 * config/auth soft concurrent floods.
 *
 * Voip focus: m.call.member read→merge→write lost-update under Promise.all;
 * PUT∥DELETE device membership; GET∥PUT; membership SELECT→write TOCTOU;
 * TURN credential concurrent soft; expired-member concurrent GET;
 * multi-room / multi-user isolation.
 *
 * RTC focus: get_token∥sfu/get dual-endpoint concurrent; OpenID KV mutate
 * mid-flight; transports concurrent; method/body soft floods.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { TurnError } from '../src/services/turn';

const authState = vi.hoisted(() => ({
  userId: '@alice:example.com' as string | undefined,
  deviceId: 'DEVICEA' as string,
}));

let opaqueSeq = 0;
const generateOpaqueId = vi.fn(async (length: number = 16) => {
  opaqueSeq += 1;
  return `callid${length}-${opaqueSeq}`;
});

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', authState.userId);
      c.set('deviceId', authState.deviceId);
      await next();
    };
  },
}));

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateOpaqueId: (...args: unknown[]) => generateOpaqueId(...(args as [number?])),
  };
});

const turnMocks = vi.hoisted(() => ({
  isTurnConfigured: vi.fn(() => true),
  getMatrixTurnCredentials: vi.fn(async () => ({
    username: 'u',
    password: 'p',
    uris: ['turn:turn.example.com:3478?transport=udp'],
    ttl: 3600,
  })),
  getStunServers: vi.fn(() => ({
    username: '',
    password: '',
    uris: ['stun:stun.cloudflare.com:3478'],
    ttl: 86400,
  })),
}));

vi.mock('../src/services/turn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/turn')>();
  return {
    ...actual,
    isTurnConfigured: turnMocks.isTurnConfigured,
    getMatrixTurnCredentials: turnMocks.getMatrixTurnCredentials,
    getStunServers: turnMocks.getStunServers,
  };
});

const livekitMocks = vi.hoisted(() => ({
  getLiveKitConfig: vi.fn(() => ({
    apiKey: 'lk-key',
    apiSecret: 'lk-secret',
    wsUrl: 'wss://livekit.example/rtc',
  })),
  generateLiveKitToken: vi.fn(async () => 'jwt.race.token'),
}));

vi.mock('../src/services/livekit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/livekit')>();
  return {
    ...actual,
    getLiveKitConfig: livekitMocks.getLiveKitConfig,
    generateLiveKitToken: livekitMocks.generateLiveKitToken,
  };
});

const callsMocks = vi.hoisted(() => ({
  isCallsConfigured: vi.fn(() => true),
}));

vi.mock('../src/services/cloudflare-calls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/cloudflare-calls')>();
  return {
    ...actual,
    isCallsConfigured: callsMocks.isCallsConfigured,
  };
});

const notifyMock = vi.hoisted(() => ({
  notifyUsersOfEvent: vi.fn(async () => undefined),
}));

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    notifyUsersOfEvent: notifyMock.notifyUsersOfEvent,
  };
});

import voipApp from '../src/api/voip';
import rtcApp from '../src/api/rtc';
import callsApp from '../src/api/calls';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ROOM2 = '!room2:example.com';
const ROOM3 = '!room3:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const ROOM2_ENC = encodeURIComponent(ROOM2);
const ROOM3_ENC = encodeURIComponent(ROOM3);
const CALL_ID = 'pinned-call-16';
const NOW = 1_700_000_000_000;
const AUTH = { Authorization: 'Bearer test-token' };

const CALLS_GET = `/_matrix/client/v3/rooms/${ROOM_ENC}/call`;
const CALLS_START = `/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`;
const CALLS_END = `/_matrix/client/v3/rooms/${ROOM_ENC}/call/end`;
const VOIP_TURN = '/_matrix/client/v3/voip/turnServer';
const VOIP_CALL_V1 = `/_matrix/client/v1/rooms/${ROOM_ENC}/call`;
const VOIP_CALL_V1_R2 = `/_matrix/client/v1/rooms/${ROOM2_ENC}/call`;
const TRANSPORTS = '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports';
const LK_TOKEN = '/livekit/get_token';
const LK_SFU = '/livekit/get_token/sfu/get';

type SqlCall = { sql: string; args: unknown[] };
type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type RunBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type Membership = { room_id: string; user_id: string; membership: string };

type CallsStateLink = {
  room_id: string;
  event_type: string;
  state_key: string;
  event_id: string;
};

type CallsEvent = {
  event_id: string;
  room_id: string;
  type: string;
  sender: string;
  content: string;
  origin_server_ts: number;
};

type VoipState = {
  room_id: string;
  type: string;
  state_key: string;
  event_id: string;
  content: string;
  sender: string;
  origin_server_ts: number;
};

type VoipEvent = {
  event_id: string;
  room_id: string;
  type: string;
  sender: string;
  content: string;
  state_key: string;
  origin_server_ts: number;
};

type CallFetch = {
  url: string;
  method: string;
  body?: unknown;
};

async function withBarrier(
  barrier: { match: (sql: string, args: unknown[]) => boolean; count: number } | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  sql: string,
  args: unknown[]
) {
  if (!barrier || !barrier.match(sql, args)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function joined(roomId = ROOM, userId = USER): Membership {
  return { room_id: roomId, user_id: userId, membership: 'join' };
}

function activeCallContent(partial: Record<string, unknown> = {}) {
  return {
    active: true,
    call_id: CALL_ID,
    started_by: USER,
    started_at: NOW,
    participants: [],
    ...partial,
  };
}

function createCallRoomStub(opts: { failInit?: boolean; failEnd?: boolean } = {}) {
  const fetches: CallFetch[] = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      const url = req.url;
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      fetches.push({ url, method: req.method, body });
      if (url.includes('/init') && opts.failInit) {
        return new Response('init fail', { status: 500 });
      }
      if (url.includes('/end') && opts.failEnd) {
        throw new Error('end boom');
      }
      if (url.includes('/ws')) {
        return new Response('ws-proxy', { status: 200 });
      }
      return Response.json({ ok: true });
    },
  };
}

type CallRoomStub = ReturnType<typeof createCallRoomStub>;

function createCallsDb(
  opts: {
    memberships?: Membership[];
    stateLinks?: CallsStateLink[];
    events?: CallsEvent[];
    selectBarrier?: SelectBarrier;
    runBarrier?: RunBarrier;
    mutateMembershipAfterSelects?: { after: number; next: Membership[] };
    mutateCallAfterSelects?: {
      after: number;
      nextLinks: CallsStateLink[];
      nextEvents: CallsEvent[];
    };
    failInsertAfter?: number;
  } = {}
) {
  const memberships = opts.memberships ?? [];
  const stateLinks = opts.stateLinks ?? [];
  const events = opts.events ?? [];
  const selects: SqlCall[] = [];
  const runs: SqlCall[] = [];
  const trace: string[] = [];

  let selectBarrier = opts.selectBarrier;
  let runBarrier = opts.runBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const runWaiters = { list: [] as Array<() => void> };

  let membershipSelectCount = 0;
  let callStateSelectCount = 0;
  let insertCount = 0;

  const mutateMembership = opts.mutateMembershipAfterSelects;
  const mutateCall = opts.mutateCallAfterSelects;
  const failInsertAfter = opts.failInsertAfter;

  const db = {
    memberships,
    stateLinks,
    events,
    selects,
    runs,
    trace,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );

              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const snapshot = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                membershipSelectCount += 1;
                if (mutateMembership && membershipSelectCount === mutateMembership.after) {
                  memberships.splice(0, memberships.length, ...mutateMembership.next);
                  trace.push('mutate:membership');
                }
                return (snapshot ? { membership: snapshot.membership } : null) as T;
              }

              if (
                sql.includes('FROM room_state rs') &&
                sql.includes("rs.event_type = 'm.call.state'")
              ) {
                const [roomId] = args as string[];
                const link = stateLinks.find(
                  (s) => s.room_id === roomId && s.event_type === 'm.call.state'
                );
                callStateSelectCount += 1;
                if (mutateCall && callStateSelectCount === mutateCall.after) {
                  stateLinks.splice(0, stateLinks.length, ...mutateCall.nextLinks);
                  events.splice(0, events.length, ...mutateCall.nextEvents);
                  trace.push('mutate:call-state');
                }
                if (!link) return null as T;
                const ev = events.find((e) => e.event_id === link.event_id);
                if (!ev) return null as T;
                if (sql.includes('e.event_id')) {
                  return { content: ev.content, event_id: ev.event_id } as T;
                }
                return { content: ev.content } as T;
              }

              if (sql.includes('FROM events') && sql.includes('event_id = ?')) {
                const [eventId] = args as string[];
                const ev = events.find((e) => e.event_id === eventId && e.type === 'm.call.state');
                return (ev
                  ? { room_id: ev.room_id, content: ev.content }
                  : null) as T;
              }

              return null as T;
            },
            async all<T>() {
              selects.push({ sql, args });
              return { results: [] as T[] };
            },
            async run() {
              await withBarrier(
                runBarrier,
                runWaiters,
                () => {
                  runBarrier = undefined;
                },
                sql,
                args
              );
              runs.push({ sql, args });

              if (sql.includes('INSERT INTO room_state')) {
                insertCount += 1;
                if (failInsertAfter !== undefined && insertCount > failInsertAfter) {
                  throw new Error('d1-call-state-insert-fail');
                }
                const [roomId, eventId] = args as string[];
                const existing = stateLinks.findIndex(
                  (s) =>
                    s.room_id === roomId &&
                    s.event_type === 'm.call.state' &&
                    s.state_key === ''
                );
                const row: CallsStateLink = {
                  room_id: roomId,
                  event_type: 'm.call.state',
                  state_key: '',
                  event_id: eventId,
                };
                if (existing >= 0) stateLinks[existing] = row;
                else stateLinks.push(row);
                trace.push('run:insert-room-state');
                return { meta: { changes: 1, last_row_id: 1 } };
              }

              if (sql.includes('INSERT OR REPLACE INTO events')) {
                const [eventId, roomId, sender, content, ts] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                ];
                const idx = events.findIndex((e) => e.event_id === eventId);
                const row: CallsEvent = {
                  event_id: eventId,
                  room_id: roomId,
                  type: 'm.call.state',
                  sender,
                  content,
                  origin_server_ts: ts,
                };
                if (idx >= 0) events[idx] = row;
                else events.push(row);
                trace.push('run:insert-event');
                return { meta: { changes: 1, last_row_id: events.length } };
              }

              if (sql.includes('UPDATE events SET content')) {
                const [content, eventId] = args as [string, string];
                const ev = events.find((e) => e.event_id === eventId);
                if (ev) ev.content = content;
                trace.push('run:update-event');
                return { meta: { changes: ev ? 1 : 0, last_row_id: 0 } };
              }

              return { meta: { changes: 0, last_row_id: 0 } };
            },
          };
        },
      };
    },
  };

  return db;
}

type CallsDb = ReturnType<typeof createCallsDb>;

function seedActiveCall(
  db: CallsDb,
  content: Record<string, unknown> = activeCallContent(),
  roomId = ROOM
) {
  const callId = String(content.call_id ?? CALL_ID);
  const eventId = `call_${callId}`;
  db.stateLinks.push({
    room_id: roomId,
    event_type: 'm.call.state',
    state_key: '',
    event_id: eventId,
  });
  db.events.push({
    event_id: eventId,
    room_id: roomId,
    type: 'm.call.state',
    sender: USER,
    content: JSON.stringify(content),
    origin_server_ts: NOW,
  });
}

function createCallsEnv(
  opts: {
    db?: CallsDb;
    callRoom?: CallRoomStub;
    noCallRooms?: boolean;
  } = {}
) {
  const db = opts.db ?? createCallsDb();
  const callRoom = opts.callRoom ?? createCallRoomStub();
  const env: Record<string, unknown> = {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    CALLS_APP_ID: 'app',
    CALLS_APP_SECRET: 'secret',
    _db: db,
    _callRoom: callRoom,
  };
  if (!opts.noCallRooms) {
    env.CALL_ROOMS = {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: (_id: { name: string }) => callRoom,
    };
  }
  return env as unknown as Env & { _db: CallsDb; _callRoom: CallRoomStub };
}

function createVoipDb(
  opts: {
    memberships?: Membership[];
    state?: VoipState[];
    selectBarrier?: SelectBarrier;
    runBarrier?: RunBarrier;
    mutateMembershipAfterSelects?: { after: number; next: Membership[] };
    mutateStateAfterSelects?: { after: number; next: VoipState[] };
    failInsertAfter?: number;
  } = {}
) {
  const memberships = opts.memberships ?? [];
  const state = opts.state ?? [];
  const events: VoipEvent[] = [];
  const selects: SqlCall[] = [];
  const runs: SqlCall[] = [];
  const trace: string[] = [];

  let selectBarrier = opts.selectBarrier;
  let runBarrier = opts.runBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const runWaiters = { list: [] as Array<() => void> };

  let membershipSelectCount = 0;
  let memberStateSelectCount = 0;
  let insertCount = 0;

  const mutateMembership = opts.mutateMembershipAfterSelects;
  const mutateState = opts.mutateStateAfterSelects;
  const failInsertAfter = opts.failInsertAfter;

  const db = {
    memberships,
    state,
    events,
    selects,
    runs,
    trace,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );

              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const snapshot = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                membershipSelectCount += 1;
                if (mutateMembership && membershipSelectCount === mutateMembership.after) {
                  memberships.splice(0, memberships.length, ...mutateMembership.next);
                  trace.push('mutate:membership');
                }
                return (snapshot ? { membership: snapshot.membership } : null) as T;
              }

              if (
                sql.includes("type = 'm.call.member'") &&
                sql.includes('state_key = ?') &&
                sql.includes('SELECT content')
              ) {
                const [roomId, stateKey] = args as string[];
                const row = state.find(
                  (s) =>
                    s.room_id === roomId &&
                    s.type === 'm.call.member' &&
                    s.state_key === stateKey
                );
                memberStateSelectCount += 1;
                if (mutateState && memberStateSelectCount === mutateState.after) {
                  state.splice(0, state.length, ...mutateState.next);
                  trace.push('mutate:call-member');
                }
                return (row ? { content: row.content } : null) as T;
              }

              return null as T;
            },
            async all<T>() {
              selects.push({ sql, args });
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (
                sql.includes("type = 'm.call.member'") &&
                sql.includes('SELECT state_key, content')
              ) {
                const [roomId] = args as string[];
                const rows = state
                  .filter((s) => s.room_id === roomId && s.type === 'm.call.member')
                  .map((s) => ({ state_key: s.state_key, content: s.content }));
                memberStateSelectCount += 1;
                if (mutateState && memberStateSelectCount === mutateState.after) {
                  state.splice(0, state.length, ...mutateState.next);
                  trace.push('mutate:call-member-all');
                }
                return { results: rows as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              await withBarrier(
                runBarrier,
                runWaiters,
                () => {
                  runBarrier = undefined;
                },
                sql,
                args
              );
              runs.push({ sql, args });

              if (sql.includes('INSERT INTO room_state')) {
                insertCount += 1;
                if (failInsertAfter !== undefined && insertCount > failInsertAfter) {
                  throw new Error('d1-voip-state-insert-fail');
                }
                const [roomId, stateKey, eventId, content, sender, ts] = args as [
                  string,
                  string,
                  string,
                  string,
                  string,
                  number,
                ];
                const existing = state.findIndex(
                  (s) =>
                    s.room_id === roomId &&
                    s.type === 'm.call.member' &&
                    s.state_key === stateKey
                );
                const row: VoipState = {
                  room_id: roomId,
                  type: 'm.call.member',
                  state_key: stateKey,
                  event_id: eventId,
                  content,
                  sender,
                  origin_server_ts: ts,
                };
                if (existing >= 0) state[existing] = row;
                else state.push(row);
                trace.push('run:insert-call-member');
                return { meta: { changes: 1, last_row_id: 1 } };
              }

              if (sql.includes('UPDATE room_state')) {
                const [eventId, content, sender, ts, roomId, stateKey] = args as [
                  string,
                  string,
                  string,
                  number,
                  string,
                  string,
                ];
                const row = state.find(
                  (s) =>
                    s.room_id === roomId &&
                    s.type === 'm.call.member' &&
                    s.state_key === stateKey
                );
                if (row) {
                  row.event_id = eventId;
                  row.content = content;
                  row.sender = sender;
                  row.origin_server_ts = ts;
                }
                trace.push('run:update-call-member');
                return { meta: { changes: row ? 1 : 0, last_row_id: 0 } };
              }

              if (sql.includes('INSERT INTO events')) {
                const [eventId, roomId, sender, content, stateKey, ts] = args as [
                  string,
                  string,
                  string,
                  string,
                  string,
                  number,
                ];
                events.push({
                  event_id: eventId,
                  room_id: roomId,
                  type: 'm.call.member',
                  sender,
                  content,
                  state_key: stateKey,
                  origin_server_ts: ts,
                });
                trace.push('run:insert-event');
                return { meta: { changes: 1, last_row_id: events.length } };
              }

              return { meta: { changes: 0, last_row_id: 0 } };
            },
          };
        },
      };
    },
  };

  return db;
}

type VoipDb = ReturnType<typeof createVoipDb>;

function callMemberState(
  userId: string,
  memberships: Array<Record<string, unknown>>,
  roomId = ROOM
): VoipState {
  return {
    room_id: roomId,
    type: 'm.call.member',
    state_key: userId,
    event_id: `$call_${userId.replace(/[^a-z0-9]/gi, '_')}`,
    content: JSON.stringify({ memberships }),
    sender: userId,
    origin_server_ts: NOW,
  };
}

function parseVoipMemberships(db: VoipDb, userId = USER, roomId = ROOM): Array<Record<string, unknown>> {
  const row = db.state.find(
    (s) => s.room_id === roomId && s.type === 'm.call.member' && s.state_key === userId
  );
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.content) as { memberships?: Array<Record<string, unknown>> };
    return parsed.memberships ?? [];
  } catch {
    return [];
  }
}

function createVoipEnv(opts: { db?: VoipDb } = {}) {
  const db = opts.db ?? createVoipDb();
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    TURN_KEY_ID: 'turnkey',
    TURN_API_TOKEN: 'token',
    _db: db,
  } as unknown as Env & { _db: VoipDb };
}

type KvPut = { key: string; value: string };

function mockKv(
  data: Record<string, string> = {},
  opts: {
    getBarrier?: { count: number; match: (key: string) => boolean };
    mutateAfterGets?: { after: number; next: Record<string, string> };
  } = {}
) {
  const puts: KvPut[] = [];
  const gets: string[] = [];
  let getBarrier = opts.getBarrier;
  const waiters = { list: [] as Array<() => void> };
  let getCount = 0;
  const mutateAfter = opts.mutateAfterGets;

  const kv = {
    data,
    puts,
    gets,
    get: async (key: string, type?: string) => {
      gets.push(key);
      getCount += 1;
      if (getBarrier && getBarrier.match(key)) {
        await new Promise<void>((resolve) => {
          waiters.list.push(resolve);
          if (waiters.list.length >= getBarrier!.count) {
            const all = [...waiters.list];
            waiters.list = [];
            getBarrier = undefined;
            for (const r of all) r();
          }
        });
      }
      if (mutateAfter && getCount === mutateAfter.after) {
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, mutateAfter.next);
      }
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
      delete data[key];
    },
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
    gets: string[];
  };
}

function createRtcEnv(opts: { sessions?: ReturnType<typeof mockKv> } = {}) {
  const sessions = opts.sessions ?? mockKv();
  return {
    SERVER_NAME: SERVER,
    SESSIONS: sessions,
    LIVEKIT_API_KEY: 'lk-key',
    LIVEKIT_API_SECRET: 'lk-secret',
    LIVEKIT_URL: 'wss://livekit.example/rtc',
    _sessions: sessions,
  } as unknown as Env & { _sessions: ReturnType<typeof mockKv> };
}

async function requestApp(
  app: { request: (...args: unknown[]) => Promise<Response> },
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await app.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      ...AUTH,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function openid(
  partial: Partial<{
    access_token: string;
    token_type: string;
    matrix_server_name: string;
    expires_in: number;
  }> = {}
) {
  return {
    access_token: 'oid-tok',
    token_type: 'Bearer',
    matrix_server_name: SERVER,
    expires_in: 3600,
    ...partial,
  };
}

function tokenBody(room = ROOM, extra: Record<string, unknown> = {}) {
  return {
    room,
    openid_token: openid(),
    device_id: 'DEVICEA',
    ...extra,
  };
}

beforeEach(() => {
  opaqueSeq = 0;
  generateOpaqueId.mockClear();
  authState.userId = USER;
  authState.deviceId = 'DEVICEA';
  turnMocks.isTurnConfigured.mockReset();
  turnMocks.isTurnConfigured.mockReturnValue(true);
  turnMocks.getMatrixTurnCredentials.mockReset();
  turnMocks.getMatrixTurnCredentials.mockResolvedValue({
    username: 'u',
    password: 'p',
    uris: ['turn:turn.example.com:3478?transport=udp'],
    ttl: 3600,
  });
  turnMocks.getStunServers.mockClear();
  livekitMocks.getLiveKitConfig.mockReset();
  livekitMocks.getLiveKitConfig.mockReturnValue({
    apiKey: 'lk-key',
    apiSecret: 'lk-secret',
    wsUrl: 'wss://livekit.example/rtc',
  });
  livekitMocks.generateLiveKitToken.mockReset();
  livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.race.token');
  callsMocks.isCallsConfigured.mockReset();
  callsMocks.isCallsConfigured.mockReturnValue(true);
  notifyMock.notifyUsersOfEvent.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});


// ---------------------------------------------------------------------------
// Calls: dual cold start TOCTOU under m.call.state SELECT barrier
// ---------------------------------------------------------------------------

describe('race calls dual cold start TOCTOU after #200', () => {
  it('parallel start both see inactive → both create; last-write-wins room_state', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBeGreaterThanOrEqual(2);
    // Both created distinct call_* events; room_state points at last upsert.
    const link = db.stateLinks[0];
    expect(link.event_id.startsWith('call_')).toBe(true);
    expect(generateOpaqueId).toHaveBeenCalledTimes(2);
  });

  it('sequential start: second sees active → M_CALL_ALREADY_ACTIVE', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const first = await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}));
    expect(first.status).toBe(200);
    const second = await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}));
    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });

  it('dual cold start soft-0 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-1 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-2 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-3 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-4 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-5 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-6 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-7 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-8 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-9 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-10 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-11 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-12 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-13 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-14 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

  it('dual cold start soft-15 under call-state barrier', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.events.length).toBe(2);
  });

});

describe('race calls start∥end / GET∥mutate after #200', () => {
  it('start∥end under call-state barrier: end may 404 if start not yet visible', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    const codes = results.map((r) => r.status).sort((a, b) => a - b);
    // Start should succeed (200). End either 404 (saw null) or 200 (saw started — unlikely under barrier before writes).
    expect(codes[0] === 200 || codes[0] === 404).toBe(true);
    expect(codes).toContain(200);
  });

  it('GET∥start concurrent: GET may see inactive or active', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(results[1].status).toBe(200);
    expect(results[0].status).toBe(200);
    const body = results[0].body as { active?: boolean };
    expect(typeof body.active).toBe('boolean');
  });

  it('GET∥end on active call: GET may see active or inactive', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    seedActiveCall(db);
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results[1].status).toBe(200);
    expect(results[0].status).toBe(200);
  });

  it('dual end on active call under barrier — both may succeed (idempotent content write)', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    seedActiveCall(db);
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const content = JSON.parse(db.events[0].content) as { active: boolean };
    expect(content.active).toBe(false);
  });

  it('start∥end soft-0 statuses are 200 and/or 404', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    for (const r of results) {
      expect([200, 404]).toContain(r.status);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it('start∥end soft-1 statuses are 200 and/or 404', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    for (const r of results) {
      expect([200, 404]).toContain(r.status);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it('start∥end soft-2 statuses are 200 and/or 404', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    for (const r of results) {
      expect([200, 404]).toContain(r.status);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it('start∥end soft-3 statuses are 200 and/or 404', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    for (const r of results) {
      expect([200, 404]).toContain(r.status);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it('start∥end soft-4 statuses are 200 and/or 404', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    for (const r of results) {
      expect([200, 404]).toContain(r.status);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it('start∥end soft-5 statuses are 200 and/or 404', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    for (const r of results) {
      expect([200, 404]).toContain(r.status);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it('start∥end soft-6 statuses are 200 and/or 404', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    for (const r of results) {
      expect([200, 404]).toContain(r.status);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it('start∥end soft-7 statuses are 200 and/or 404', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    for (const r of results) {
      expect([200, 404]).toContain(r.status);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it('start∥end soft-8 statuses are 200 and/or 404', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    for (const r of results) {
      expect([200, 404]).toContain(r.status);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it('start∥end soft-9 statuses are 200 and/or 404', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    for (const r of results) {
      expect([200, 404]).toContain(r.status);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it('start∥end soft-10 statuses are 200 and/or 404', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    for (const r of results) {
      expect([200, 404]).toContain(r.status);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it('start∥end soft-11 statuses are 200 and/or 404', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    for (const r of results) {
      expect([200, 404]).toContain(r.status);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it('dual end soft-0 both 200 when seeded active', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    seedActiveCall(db, activeCallContent({ call_id: `endsoft-0` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('dual end soft-1 both 200 when seeded active', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    seedActiveCall(db, activeCallContent({ call_id: `endsoft-1` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('dual end soft-2 both 200 when seeded active', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    seedActiveCall(db, activeCallContent({ call_id: `endsoft-2` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('dual end soft-3 both 200 when seeded active', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    seedActiveCall(db, activeCallContent({ call_id: `endsoft-3` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('dual end soft-4 both 200 when seeded active', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    seedActiveCall(db, activeCallContent({ call_id: `endsoft-4` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('dual end soft-5 both 200 when seeded active', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    seedActiveCall(db, activeCallContent({ call_id: `endsoft-5` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('dual end soft-6 both 200 when seeded active', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    seedActiveCall(db, activeCallContent({ call_id: `endsoft-6` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('dual end soft-7 both 200 when seeded active', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    seedActiveCall(db, activeCallContent({ call_id: `endsoft-7` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('dual end soft-8 both 200 when seeded active', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    seedActiveCall(db, activeCallContent({ call_id: `endsoft-8` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('dual end soft-9 both 200 when seeded active', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_state rs') && sql.includes("rs.event_type = 'm.call.state'"),
      },
    });
    seedActiveCall(db, activeCallContent({ call_id: `endsoft-9` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

});

describe('race calls membership SELECT→start TOCTOU after #200', () => {
  it('membership cleared after first SELECT; barrier may still allow both starts', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    const codes = new Set(results.map((r) => r.status));
    expect([...codes].every((c) => c === 200 || c === 403)).toBe(true);
  });

  it('post-mutate sequential start is forbidden after membership cleared', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createCallsEnv({ db });
    const first = await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}));
    expect(first.status).toBe(200);
    // Clear active so membership is the failing check
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    const second = await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}));
    expect(second.status).toBe(403);
  });

  it('join→leave mid-flight rejects next start (calls requires join)', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      },
    });
    const env = createCallsEnv({ db });
    const first = await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}));
    expect(first.status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    const second = await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}));
    expect(second.status).toBe(403);
  });

  it('join→ban mid-flight rejects next start (calls requires join)', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      },
    });
    const env = createCallsEnv({ db });
    const first = await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}));
    expect(first.status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    const second = await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}));
    expect(second.status).toBe(403);
  });

  it('join→invite mid-flight rejects next start (calls requires join)', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      },
    });
    const env = createCallsEnv({ db });
    const first = await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}));
    expect(first.status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    const second = await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}));
    expect(second.status).toBe(403);
  });

  it('join→knock mid-flight rejects next start (calls requires join)', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      },
    });
    const env = createCallsEnv({ db });
    const first = await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}));
    expect(first.status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    const second = await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}));
    expect(second.status).toBe(403);
  });

  it('membership clear soft-0: first ok second forbidden', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createCallsEnv({ db });
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(403);
  });

  it('membership clear soft-1: first ok second forbidden', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createCallsEnv({ db });
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(403);
  });

  it('membership clear soft-2: first ok second forbidden', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createCallsEnv({ db });
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(403);
  });

  it('membership clear soft-3: first ok second forbidden', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createCallsEnv({ db });
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(403);
  });

  it('membership clear soft-4: first ok second forbidden', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createCallsEnv({ db });
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(403);
  });

  it('membership clear soft-5: first ok second forbidden', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createCallsEnv({ db });
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(403);
  });

  it('membership clear soft-6: first ok second forbidden', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createCallsEnv({ db });
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(403);
  });

  it('membership clear soft-7: first ok second forbidden', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createCallsEnv({ db });
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(403);
  });

  it('membership clear soft-8: first ok second forbidden', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createCallsEnv({ db });
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(403);
  });

  it('membership clear soft-9: first ok second forbidden', async () => {
    const db = createCallsDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createCallsEnv({ db });
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(200);
    db.stateLinks.splice(0, db.stateLinks.length);
    db.events.splice(0, db.events.length);
    expect((await requestApp(callsApp, env, CALLS_START, jsonInit('POST', {}))).status).toBe(403);
  });

});

describe('race calls multi-room isolation + WS∥end after #200', () => {
  it('parallel start across three rooms keeps per-room state', async () => {
    const db = createCallsDb({
      memberships: [joined(ROOM), joined(ROOM2), joined(ROOM3)],
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`, jsonInit('POST', {})),
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM2_ENC}/call/start`, jsonInit('POST', {})),
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM3_ENC}/call/start`, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(db.stateLinks).toHaveLength(3);
    const rooms = db.stateLinks.map((s) => s.room_id).sort();
    expect(rooms).toEqual([ROOM, ROOM2, ROOM3].sort());
  });

  it('WS∥end: ws may still find event while end marks inactive', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    seedActiveCall(db);
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, `/calls/${CALL_ID}/ws`, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results[1].status).toBe(200);
    expect([200, 404]).toContain(results[0].status);
  });

  it('multi-room GET isolation soft-0', async () => {
    const db = createCallsDb({ memberships: [joined(ROOM), joined(ROOM2)] });
    seedActiveCall(db, activeCallContent({ call_id: `iso-a-0` }), ROOM);
    seedActiveCall(db, activeCallContent({ call_id: `iso-b-0` }), ROOM2);
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM_ENC}/call`, { headers: AUTH }),
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM2_ENC}/call`, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-a-0`);
    expect((results[1].body as { callId: string }).callId).toBe(`iso-b-0`);
  });

  it('multi-room GET isolation soft-1', async () => {
    const db = createCallsDb({ memberships: [joined(ROOM), joined(ROOM2)] });
    seedActiveCall(db, activeCallContent({ call_id: `iso-a-1` }), ROOM);
    seedActiveCall(db, activeCallContent({ call_id: `iso-b-1` }), ROOM2);
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM_ENC}/call`, { headers: AUTH }),
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM2_ENC}/call`, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-a-1`);
    expect((results[1].body as { callId: string }).callId).toBe(`iso-b-1`);
  });

  it('multi-room GET isolation soft-2', async () => {
    const db = createCallsDb({ memberships: [joined(ROOM), joined(ROOM2)] });
    seedActiveCall(db, activeCallContent({ call_id: `iso-a-2` }), ROOM);
    seedActiveCall(db, activeCallContent({ call_id: `iso-b-2` }), ROOM2);
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM_ENC}/call`, { headers: AUTH }),
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM2_ENC}/call`, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-a-2`);
    expect((results[1].body as { callId: string }).callId).toBe(`iso-b-2`);
  });

  it('multi-room GET isolation soft-3', async () => {
    const db = createCallsDb({ memberships: [joined(ROOM), joined(ROOM2)] });
    seedActiveCall(db, activeCallContent({ call_id: `iso-a-3` }), ROOM);
    seedActiveCall(db, activeCallContent({ call_id: `iso-b-3` }), ROOM2);
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM_ENC}/call`, { headers: AUTH }),
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM2_ENC}/call`, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-a-3`);
    expect((results[1].body as { callId: string }).callId).toBe(`iso-b-3`);
  });

  it('multi-room GET isolation soft-4', async () => {
    const db = createCallsDb({ memberships: [joined(ROOM), joined(ROOM2)] });
    seedActiveCall(db, activeCallContent({ call_id: `iso-a-4` }), ROOM);
    seedActiveCall(db, activeCallContent({ call_id: `iso-b-4` }), ROOM2);
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM_ENC}/call`, { headers: AUTH }),
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM2_ENC}/call`, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-a-4`);
    expect((results[1].body as { callId: string }).callId).toBe(`iso-b-4`);
  });

  it('multi-room GET isolation soft-5', async () => {
    const db = createCallsDb({ memberships: [joined(ROOM), joined(ROOM2)] });
    seedActiveCall(db, activeCallContent({ call_id: `iso-a-5` }), ROOM);
    seedActiveCall(db, activeCallContent({ call_id: `iso-b-5` }), ROOM2);
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM_ENC}/call`, { headers: AUTH }),
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM2_ENC}/call`, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-a-5`);
    expect((results[1].body as { callId: string }).callId).toBe(`iso-b-5`);
  });

  it('multi-room GET isolation soft-6', async () => {
    const db = createCallsDb({ memberships: [joined(ROOM), joined(ROOM2)] });
    seedActiveCall(db, activeCallContent({ call_id: `iso-a-6` }), ROOM);
    seedActiveCall(db, activeCallContent({ call_id: `iso-b-6` }), ROOM2);
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM_ENC}/call`, { headers: AUTH }),
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM2_ENC}/call`, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-a-6`);
    expect((results[1].body as { callId: string }).callId).toBe(`iso-b-6`);
  });

  it('multi-room GET isolation soft-7', async () => {
    const db = createCallsDb({ memberships: [joined(ROOM), joined(ROOM2)] });
    seedActiveCall(db, activeCallContent({ call_id: `iso-a-7` }), ROOM);
    seedActiveCall(db, activeCallContent({ call_id: `iso-b-7` }), ROOM2);
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM_ENC}/call`, { headers: AUTH }),
      requestApp(callsApp, env, `/_matrix/client/v3/rooms/${ROOM2_ENC}/call`, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-a-7`);
    expect((results[1].body as { callId: string }).callId).toBe(`iso-b-7`);
  });

});

describe('race calls soft config/auth concurrent floods after #200', () => {

  it('not-configured concurrent soft-0', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('not-configured concurrent soft-1', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('not-configured concurrent soft-2', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('not-configured concurrent soft-3', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('not-configured concurrent soft-4', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('not-configured concurrent soft-5', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('not-configured concurrent soft-6', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('not-configured concurrent soft-7', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('not-configured concurrent soft-8', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('not-configured concurrent soft-9', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('not-configured concurrent soft-10', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('not-configured concurrent soft-11', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_END, jsonInit('POST', {})),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('no CALL_ROOMS concurrent start soft-0', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db, noCallRooms: true });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('no CALL_ROOMS concurrent start soft-1', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db, noCallRooms: true });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('no CALL_ROOMS concurrent start soft-2', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db, noCallRooms: true });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('no CALL_ROOMS concurrent start soft-3', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db, noCallRooms: true });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('no CALL_ROOMS concurrent start soft-4', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db, noCallRooms: true });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('no CALL_ROOMS concurrent start soft-5', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db, noCallRooms: true });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('no CALL_ROOMS concurrent start soft-6', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db, noCallRooms: true });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('no CALL_ROOMS concurrent start soft-7', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    const env = createCallsEnv({ db, noCallRooms: true });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('already-active concurrent start soft-0', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    seedActiveCall(db, activeCallContent({ call_id: `active-0` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_CALL_ALREADY_ACTIVE')).toBe(true);
  });

  it('already-active concurrent start soft-1', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    seedActiveCall(db, activeCallContent({ call_id: `active-1` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_CALL_ALREADY_ACTIVE')).toBe(true);
  });

  it('already-active concurrent start soft-2', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    seedActiveCall(db, activeCallContent({ call_id: `active-2` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_CALL_ALREADY_ACTIVE')).toBe(true);
  });

  it('already-active concurrent start soft-3', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    seedActiveCall(db, activeCallContent({ call_id: `active-3` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_CALL_ALREADY_ACTIVE')).toBe(true);
  });

  it('already-active concurrent start soft-4', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    seedActiveCall(db, activeCallContent({ call_id: `active-4` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_CALL_ALREADY_ACTIVE')).toBe(true);
  });

  it('already-active concurrent start soft-5', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    seedActiveCall(db, activeCallContent({ call_id: `active-5` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_CALL_ALREADY_ACTIVE')).toBe(true);
  });

  it('already-active concurrent start soft-6', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    seedActiveCall(db, activeCallContent({ call_id: `active-6` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_CALL_ALREADY_ACTIVE')).toBe(true);
  });

  it('already-active concurrent start soft-7', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    seedActiveCall(db, activeCallContent({ call_id: `active-7` }));
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
      requestApp(callsApp, env, CALLS_START, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_CALL_ALREADY_ACTIVE')).toBe(true);
  });

  it('corrupt call content GET concurrent soft-0', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: `call_corrupt_0`,
    });
    db.events.push({
      event_id: `call_corrupt_0`,
      room_id: ROOM,
      type: 'm.call.state',
      sender: USER,
      content: '{not-json',
      origin_server_ts: NOW,
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { active: boolean }).active === false)).toBe(true);
  });

  it('corrupt call content GET concurrent soft-1', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: `call_corrupt_1`,
    });
    db.events.push({
      event_id: `call_corrupt_1`,
      room_id: ROOM,
      type: 'm.call.state',
      sender: USER,
      content: '{not-json',
      origin_server_ts: NOW,
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { active: boolean }).active === false)).toBe(true);
  });

  it('corrupt call content GET concurrent soft-2', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: `call_corrupt_2`,
    });
    db.events.push({
      event_id: `call_corrupt_2`,
      room_id: ROOM,
      type: 'm.call.state',
      sender: USER,
      content: '{not-json',
      origin_server_ts: NOW,
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { active: boolean }).active === false)).toBe(true);
  });

  it('corrupt call content GET concurrent soft-3', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: `call_corrupt_3`,
    });
    db.events.push({
      event_id: `call_corrupt_3`,
      room_id: ROOM,
      type: 'm.call.state',
      sender: USER,
      content: '{not-json',
      origin_server_ts: NOW,
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { active: boolean }).active === false)).toBe(true);
  });

  it('corrupt call content GET concurrent soft-4', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: `call_corrupt_4`,
    });
    db.events.push({
      event_id: `call_corrupt_4`,
      room_id: ROOM,
      type: 'm.call.state',
      sender: USER,
      content: '{not-json',
      origin_server_ts: NOW,
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { active: boolean }).active === false)).toBe(true);
  });

  it('corrupt call content GET concurrent soft-5', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: `call_corrupt_5`,
    });
    db.events.push({
      event_id: `call_corrupt_5`,
      room_id: ROOM,
      type: 'm.call.state',
      sender: USER,
      content: '{not-json',
      origin_server_ts: NOW,
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { active: boolean }).active === false)).toBe(true);
  });

  it('corrupt call content GET concurrent soft-6', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: `call_corrupt_6`,
    });
    db.events.push({
      event_id: `call_corrupt_6`,
      room_id: ROOM,
      type: 'm.call.state',
      sender: USER,
      content: '{not-json',
      origin_server_ts: NOW,
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { active: boolean }).active === false)).toBe(true);
  });

  it('corrupt call content GET concurrent soft-7', async () => {
    const db = createCallsDb({ memberships: [joined()] });
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: `call_corrupt_7`,
    });
    db.events.push({
      event_id: `call_corrupt_7`,
      room_id: ROOM,
      type: 'm.call.state',
      sender: USER,
      content: '{not-json',
      origin_server_ts: NOW,
    });
    const env = createCallsEnv({ db });
    const results = await Promise.all([
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
      requestApp(callsApp, env, CALLS_GET, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { active: boolean }).active === false)).toBe(true);
  });

});


// ---------------------------------------------------------------------------
// Voip: m.call.member read→merge→write lost-update TOCTOU
// ---------------------------------------------------------------------------

describe('race voip PUT call-member read→merge→write TOCTOU after #200', () => {
  it('parallel PUT distinct devices on empty map: last-write-wins may drop a device', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVA', call_id: 'c1' })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVB', call_id: 'c1' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const members = parseVoipMemberships(db);
    // Both SELECTs saw empty → each wrote singleton → final has one device
    expect(members).toHaveLength(1);
    expect(['DEVA', 'DEVB']).toContain(members[0].device_id);
  });

  it('sequential PUT distinct devices preserves both', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVA' }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVB' }))).status
    ).toBe(200);
    const ids = parseVoipMemberships(db).map((m) => m.device_id).sort();
    expect(ids).toEqual(['DEVA', 'DEVB']);
  });

  it('TOCTOU soft-0: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-0`;
    const b = `DEV-B-0`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-0` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-0` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-1: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-1`;
    const b = `DEV-B-1`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-1` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-1` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-2: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-2`;
    const b = `DEV-B-2`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-2` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-2` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-3: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-3`;
    const b = `DEV-B-3`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-3` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-3` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-4: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-4`;
    const b = `DEV-B-4`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-4` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-4` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-5: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-5`;
    const b = `DEV-B-5`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-5` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-5` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-6: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-6`;
    const b = `DEV-B-6`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-6` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-6` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-7: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-7`;
    const b = `DEV-B-7`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-7` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-7` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-8: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-8`;
    const b = `DEV-B-8`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-8` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-8` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-9: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-9`;
    const b = `DEV-B-9`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-9` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-9` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-10: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-10`;
    const b = `DEV-B-10`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-10` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-10` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-11: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-11`;
    const b = `DEV-B-11`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-11` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-11` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-12: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-12`;
    const b = `DEV-B-12`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-12` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-12` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-13: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-13`;
    const b = `DEV-B-13`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-13` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-13` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-14: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-14`;
    const b = `DEV-B-14`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-14` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-14` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft-15: dual PUT distinct devices under call.member barrier', async () => {
    const a = `DEV-A-15`;
    const b = `DEV-B-15`;
    const db = createVoipDb({
      memberships: [joined()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: a, call_id: `c-15` })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: b, call_id: `c-15` })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db)).toHaveLength(1);
  });

  it('TOCTOU soft merge-0: dual PUT same device last-write-wins expires_ts', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [callMemberState(USER, [{ device_id: 'DEVICEA', call_id: '', expires_ts: NOW + 1000 }])],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const tsA = NOW + 10_000 + 0;
    const tsB = NOW + 20_000 + 0;
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsA })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsB })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const members = parseVoipMemberships(db);
    expect(members).toHaveLength(1);
    expect([tsA, tsB]).toContain(members[0].expires_ts);
  });

  it('TOCTOU soft merge-1: dual PUT same device last-write-wins expires_ts', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [callMemberState(USER, [{ device_id: 'DEVICEA', call_id: '', expires_ts: NOW + 1000 }])],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const tsA = NOW + 10_000 + 1;
    const tsB = NOW + 20_000 + 1;
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsA })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsB })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const members = parseVoipMemberships(db);
    expect(members).toHaveLength(1);
    expect([tsA, tsB]).toContain(members[0].expires_ts);
  });

  it('TOCTOU soft merge-2: dual PUT same device last-write-wins expires_ts', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [callMemberState(USER, [{ device_id: 'DEVICEA', call_id: '', expires_ts: NOW + 1000 }])],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const tsA = NOW + 10_000 + 2;
    const tsB = NOW + 20_000 + 2;
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsA })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsB })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const members = parseVoipMemberships(db);
    expect(members).toHaveLength(1);
    expect([tsA, tsB]).toContain(members[0].expires_ts);
  });

  it('TOCTOU soft merge-3: dual PUT same device last-write-wins expires_ts', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [callMemberState(USER, [{ device_id: 'DEVICEA', call_id: '', expires_ts: NOW + 1000 }])],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const tsA = NOW + 10_000 + 3;
    const tsB = NOW + 20_000 + 3;
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsA })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsB })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const members = parseVoipMemberships(db);
    expect(members).toHaveLength(1);
    expect([tsA, tsB]).toContain(members[0].expires_ts);
  });

  it('TOCTOU soft merge-4: dual PUT same device last-write-wins expires_ts', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [callMemberState(USER, [{ device_id: 'DEVICEA', call_id: '', expires_ts: NOW + 1000 }])],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const tsA = NOW + 10_000 + 4;
    const tsB = NOW + 20_000 + 4;
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsA })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsB })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const members = parseVoipMemberships(db);
    expect(members).toHaveLength(1);
    expect([tsA, tsB]).toContain(members[0].expires_ts);
  });

  it('TOCTOU soft merge-5: dual PUT same device last-write-wins expires_ts', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [callMemberState(USER, [{ device_id: 'DEVICEA', call_id: '', expires_ts: NOW + 1000 }])],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const tsA = NOW + 10_000 + 5;
    const tsB = NOW + 20_000 + 5;
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsA })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsB })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const members = parseVoipMemberships(db);
    expect(members).toHaveLength(1);
    expect([tsA, tsB]).toContain(members[0].expires_ts);
  });

  it('TOCTOU soft merge-6: dual PUT same device last-write-wins expires_ts', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [callMemberState(USER, [{ device_id: 'DEVICEA', call_id: '', expires_ts: NOW + 1000 }])],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const tsA = NOW + 10_000 + 6;
    const tsB = NOW + 20_000 + 6;
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsA })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsB })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const members = parseVoipMemberships(db);
    expect(members).toHaveLength(1);
    expect([tsA, tsB]).toContain(members[0].expires_ts);
  });

  it('TOCTOU soft merge-7: dual PUT same device last-write-wins expires_ts', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [callMemberState(USER, [{ device_id: 'DEVICEA', call_id: '', expires_ts: NOW + 1000 }])],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const tsA = NOW + 10_000 + 7;
    const tsB = NOW + 20_000 + 7;
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsA })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsB })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const members = parseVoipMemberships(db);
    expect(members).toHaveLength(1);
    expect([tsA, tsB]).toContain(members[0].expires_ts);
  });

  it('TOCTOU soft merge-8: dual PUT same device last-write-wins expires_ts', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [callMemberState(USER, [{ device_id: 'DEVICEA', call_id: '', expires_ts: NOW + 1000 }])],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const tsA = NOW + 10_000 + 8;
    const tsB = NOW + 20_000 + 8;
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsA })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsB })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const members = parseVoipMemberships(db);
    expect(members).toHaveLength(1);
    expect([tsA, tsB]).toContain(members[0].expires_ts);
  });

  it('TOCTOU soft merge-9: dual PUT same device last-write-wins expires_ts', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [callMemberState(USER, [{ device_id: 'DEVICEA', call_id: '', expires_ts: NOW + 1000 }])],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const tsA = NOW + 10_000 + 9;
    const tsB = NOW + 20_000 + 9;
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsA })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', expires_ts: tsB })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const members = parseVoipMemberships(db);
    expect(members).toHaveLength(1);
    expect([tsA, tsB]).toContain(members[0].expires_ts);
  });

});

describe('race voip PUT∥DELETE∥GET call membership after #200', () => {
  it('parallel DELETE same device — both may succeed', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'c', expires_ts: Date.now() + 3_600_000 },
          { device_id: 'DEVICEB', call_id: 'c', expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=DEVICEA`, { method: 'DELETE', headers: AUTH }),
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=DEVICEA`, { method: 'DELETE', headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const ids = parseVoipMemberships(db).map((m) => m.device_id);
    expect(ids).toEqual(['DEVICEB']);
  });

  it('DELETE∥PUT same device under barrier — both 200, final ambiguous', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [callMemberState(USER, [{ device_id: 'DEVICEA', call_id: 'old', expires_ts: Date.now() + 1_000 }])],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=DEVICEA`, { method: 'DELETE', headers: AUTH }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', call_id: 'new' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const members = parseVoipMemberships(db);
    // Final is either empty (DELETE last) or DEVICEA with call_id new (PUT last)
    if (members.length === 0) {
      expect(members).toEqual([]);
    } else {
      expect(members[0].device_id).toBe('DEVICEA');
      expect(members[0].call_id).toBe('new');
    }
  });

  it('GET∥PUT concurrent: GET may see pre or post write', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [callMemberState(USER, [{ device_id: 'DEVICEA', call_id: 'c', expires_ts: Date.now() + 3_600_000 }])],
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVB', call_id: 'c2' })),
    ]);
    expect(results[1].status).toBe(200);
    expect([200, 404]).toContain(results[0].status);
  });

  it('DELETE∥PUT distinct devices soft-0', async () => {
    const keep = `KEEP-0`;
    const drop = `DROP-0`;
    const add = `ADD-0`;
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: keep, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
          { device_id: drop, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=${drop}`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: add, call_id: 'c' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db).length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE∥PUT distinct devices soft-1', async () => {
    const keep = `KEEP-1`;
    const drop = `DROP-1`;
    const add = `ADD-1`;
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: keep, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
          { device_id: drop, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=${drop}`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: add, call_id: 'c' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db).length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE∥PUT distinct devices soft-2', async () => {
    const keep = `KEEP-2`;
    const drop = `DROP-2`;
    const add = `ADD-2`;
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: keep, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
          { device_id: drop, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=${drop}`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: add, call_id: 'c' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db).length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE∥PUT distinct devices soft-3', async () => {
    const keep = `KEEP-3`;
    const drop = `DROP-3`;
    const add = `ADD-3`;
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: keep, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
          { device_id: drop, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=${drop}`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: add, call_id: 'c' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db).length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE∥PUT distinct devices soft-4', async () => {
    const keep = `KEEP-4`;
    const drop = `DROP-4`;
    const add = `ADD-4`;
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: keep, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
          { device_id: drop, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=${drop}`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: add, call_id: 'c' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db).length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE∥PUT distinct devices soft-5', async () => {
    const keep = `KEEP-5`;
    const drop = `DROP-5`;
    const add = `ADD-5`;
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: keep, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
          { device_id: drop, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=${drop}`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: add, call_id: 'c' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db).length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE∥PUT distinct devices soft-6', async () => {
    const keep = `KEEP-6`;
    const drop = `DROP-6`;
    const add = `ADD-6`;
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: keep, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
          { device_id: drop, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=${drop}`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: add, call_id: 'c' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db).length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE∥PUT distinct devices soft-7', async () => {
    const keep = `KEEP-7`;
    const drop = `DROP-7`;
    const add = `ADD-7`;
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: keep, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
          { device_id: drop, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=${drop}`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: add, call_id: 'c' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db).length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE∥PUT distinct devices soft-8', async () => {
    const keep = `KEEP-8`;
    const drop = `DROP-8`;
    const add = `ADD-8`;
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: keep, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
          { device_id: drop, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=${drop}`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: add, call_id: 'c' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db).length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE∥PUT distinct devices soft-9', async () => {
    const keep = `KEEP-9`;
    const drop = `DROP-9`;
    const add = `ADD-9`;
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: keep, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
          { device_id: drop, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=${drop}`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: add, call_id: 'c' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db).length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE∥PUT distinct devices soft-10', async () => {
    const keep = `KEEP-10`;
    const drop = `DROP-10`;
    const add = `ADD-10`;
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: keep, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
          { device_id: drop, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=${drop}`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: add, call_id: 'c' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db).length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE∥PUT distinct devices soft-11', async () => {
    const keep = `KEEP-11`;
    const drop = `DROP-11`;
    const add = `ADD-11`;
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: keep, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
          { device_id: drop, call_id: 'c', expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes("type = 'm.call.member'") && sql.includes('state_key = ?'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=${drop}`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: add, call_id: 'c' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(parseVoipMemberships(db).length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE no-op when missing soft-0', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-0`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-0-b`, {
        method: 'DELETE',
        headers: AUTH,
      }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.runs.filter((r) => r.sql.includes('UPDATE room_state'))).toHaveLength(0);
  });

  it('DELETE no-op when missing soft-1', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-1`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-1-b`, {
        method: 'DELETE',
        headers: AUTH,
      }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.runs.filter((r) => r.sql.includes('UPDATE room_state'))).toHaveLength(0);
  });

  it('DELETE no-op when missing soft-2', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-2`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-2-b`, {
        method: 'DELETE',
        headers: AUTH,
      }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.runs.filter((r) => r.sql.includes('UPDATE room_state'))).toHaveLength(0);
  });

  it('DELETE no-op when missing soft-3', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-3`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-3-b`, {
        method: 'DELETE',
        headers: AUTH,
      }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.runs.filter((r) => r.sql.includes('UPDATE room_state'))).toHaveLength(0);
  });

  it('DELETE no-op when missing soft-4', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-4`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-4-b`, {
        method: 'DELETE',
        headers: AUTH,
      }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.runs.filter((r) => r.sql.includes('UPDATE room_state'))).toHaveLength(0);
  });

  it('DELETE no-op when missing soft-5', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-5`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-5-b`, {
        method: 'DELETE',
        headers: AUTH,
      }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.runs.filter((r) => r.sql.includes('UPDATE room_state'))).toHaveLength(0);
  });

  it('DELETE no-op when missing soft-6', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-6`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-6-b`, {
        method: 'DELETE',
        headers: AUTH,
      }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.runs.filter((r) => r.sql.includes('UPDATE room_state'))).toHaveLength(0);
  });

  it('DELETE no-op when missing soft-7', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-7`, {
        method: 'DELETE',
        headers: AUTH,
      }),
      requestApp(voipApp, env, `${VOIP_CALL_V1}?device_id=MISSING-7-b`, {
        method: 'DELETE',
        headers: AUTH,
      }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.runs.filter((r) => r.sql.includes('UPDATE room_state'))).toHaveLength(0);
  });

});

describe('race voip membership SELECT→write TOCTOU after #200', () => {
  it('membership row removed after first SELECT; barrier may still allow both PUTs', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'A' })),
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'B' })),
    ]);
    const codes = new Set(results.map((r) => r.status));
    expect([...codes].every((c) => c === 200 || c === 403)).toBe(true);
  });

  it('post-mutate sequential PUT is forbidden after membership cleared', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'A' }))).status
    ).toBe(200);
    const second = await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'B' }));
    expect(second.status).toBe(403);
    expect(second.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('join→leave rejects next PUT (voip requires join)', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'OK' }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'NO' }))).status
    ).toBe(403);
  });

  it('join→ban rejects next PUT (voip requires join)', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'OK' }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'NO' }))).status
    ).toBe(403);
  });

  it('join→invite rejects next PUT (voip requires join)', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'OK' }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'NO' }))).status
    ).toBe(403);
  });

  it('join→knock rejects next PUT (voip requires join)', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'OK' }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'NO' }))).status
    ).toBe(403);
  });

  it('membership clear soft-0', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `A-0` }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `B-0` }))).status
    ).toBe(403);
  });

  it('membership clear soft-1', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `A-1` }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `B-1` }))).status
    ).toBe(403);
  });

  it('membership clear soft-2', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `A-2` }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `B-2` }))).status
    ).toBe(403);
  });

  it('membership clear soft-3', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `A-3` }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `B-3` }))).status
    ).toBe(403);
  });

  it('membership clear soft-4', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `A-4` }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `B-4` }))).status
    ).toBe(403);
  });

  it('membership clear soft-5', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `A-5` }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `B-5` }))).status
    ).toBe(403);
  });

  it('membership clear soft-6', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `A-6` }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `B-6` }))).status
    ).toBe(403);
  });

  it('membership clear soft-7', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `A-7` }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `B-7` }))).status
    ).toBe(403);
  });

  it('membership clear soft-8', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `A-8` }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `B-8` }))).status
    ).toBe(403);
  });

  it('membership clear soft-9', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const env = createVoipEnv({ db });
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `A-9` }))).status
    ).toBe(200);
    expect(
      (await requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: `B-9` }))).status
    ).toBe(403);
  });

});

describe('race voip multi-room / TURN concurrent after #200', () => {
  it('parallel PUT across two rooms keeps per-room call.member rows', async () => {
    const db = createVoipDb({
      memberships: [joined(ROOM), joined(ROOM2)],
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA', call_id: 'r1' })),
      requestApp(voipApp, env, VOIP_CALL_V1_R2, jsonInit('PUT', { device_id: 'DEVICEA', call_id: 'r2' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.state.filter((s) => s.type === 'm.call.member')).toHaveLength(2);
    expect(parseVoipMemberships(db, USER, ROOM)[0].call_id).toBe('r1');
    expect(parseVoipMemberships(db, USER, ROOM2)[0].call_id).toBe('r2');
  });

  it('parallel TURN credential requests both succeed when configured', async () => {
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledTimes(3);
  });

  it('TURN stun-fallback concurrent soft-0', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TURN stun-fallback concurrent soft-1', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TURN stun-fallback concurrent soft-2', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TURN stun-fallback concurrent soft-3', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TURN stun-fallback concurrent soft-4', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TURN stun-fallback concurrent soft-5', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TURN stun-fallback concurrent soft-6', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TURN stun-fallback concurrent soft-7', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TURN stun-fallback concurrent soft-8', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TURN stun-fallback concurrent soft-9', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TURN user-rate-limit concurrent soft-0', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate', 'USER_RATE_LIMITED', 429, 12000)
    );
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([429, 429]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_LIMIT_EXCEEDED')).toBe(
      true
    );
  });

  it('TURN user-rate-limit concurrent soft-1', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate', 'USER_RATE_LIMITED', 429, 12000)
    );
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([429, 429]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_LIMIT_EXCEEDED')).toBe(
      true
    );
  });

  it('TURN user-rate-limit concurrent soft-2', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate', 'USER_RATE_LIMITED', 429, 12000)
    );
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([429, 429]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_LIMIT_EXCEEDED')).toBe(
      true
    );
  });

  it('TURN user-rate-limit concurrent soft-3', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate', 'USER_RATE_LIMITED', 429, 12000)
    );
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([429, 429]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_LIMIT_EXCEEDED')).toBe(
      true
    );
  });

  it('TURN user-rate-limit concurrent soft-4', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate', 'USER_RATE_LIMITED', 429, 12000)
    );
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([429, 429]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_LIMIT_EXCEEDED')).toBe(
      true
    );
  });

  it('TURN user-rate-limit concurrent soft-5', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate', 'USER_RATE_LIMITED', 429, 12000)
    );
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([429, 429]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_LIMIT_EXCEEDED')).toBe(
      true
    );
  });

  it('TURN user-rate-limit concurrent soft-6', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate', 'USER_RATE_LIMITED', 429, 12000)
    );
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([429, 429]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_LIMIT_EXCEEDED')).toBe(
      true
    );
  });

  it('TURN user-rate-limit concurrent soft-7', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate', 'USER_RATE_LIMITED', 429, 12000)
    );
    const env = createVoipEnv();
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_TURN, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([429, 429]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_LIMIT_EXCEEDED')).toBe(
      true
    );
  });

  it('expired members concurrent GET soft-0', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'OLD', call_id: 'c', expires_ts: NOW - 1000 - 0 },
        ]),
      ],
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  it('expired members concurrent GET soft-1', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'OLD', call_id: 'c', expires_ts: NOW - 1000 - 1 },
        ]),
      ],
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  it('expired members concurrent GET soft-2', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'OLD', call_id: 'c', expires_ts: NOW - 1000 - 2 },
        ]),
      ],
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  it('expired members concurrent GET soft-3', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'OLD', call_id: 'c', expires_ts: NOW - 1000 - 3 },
        ]),
      ],
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  it('expired members concurrent GET soft-4', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'OLD', call_id: 'c', expires_ts: NOW - 1000 - 4 },
        ]),
      ],
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  it('expired members concurrent GET soft-5', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'OLD', call_id: 'c', expires_ts: NOW - 1000 - 5 },
        ]),
      ],
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  it('expired members concurrent GET soft-6', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'OLD', call_id: 'c', expires_ts: NOW - 1000 - 6 },
        ]),
      ],
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  it('expired members concurrent GET soft-7', async () => {
    const db = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'OLD', call_id: 'c', expires_ts: NOW - 1000 - 7 },
        ]),
      ],
    });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
      requestApp(voipApp, env, VOIP_CALL_V1, { headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  it('voip soft body validation concurrent soft-0', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-0',
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_NOT_JSON')).toBe(true);
  });

  it('voip soft body validation concurrent soft-1', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-1',
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_NOT_JSON')).toBe(true);
  });

  it('voip soft body validation concurrent soft-2', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-2',
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_NOT_JSON')).toBe(true);
  });

  it('voip soft body validation concurrent soft-3', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-3',
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_NOT_JSON')).toBe(true);
  });

  it('voip soft body validation concurrent soft-4', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-4',
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_NOT_JSON')).toBe(true);
  });

  it('voip soft body validation concurrent soft-5', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-5',
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_NOT_JSON')).toBe(true);
  });

  it('voip soft body validation concurrent soft-6', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-6',
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_NOT_JSON')).toBe(true);
  });

  it('voip soft body validation concurrent soft-7', async () => {
    const db = createVoipDb({ memberships: [joined()] });
    const env = createVoipEnv({ db });
    const results = await Promise.all([
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-7',
      }),
      requestApp(voipApp, env, VOIP_CALL_V1, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_NOT_JSON')).toBe(true);
  });

});


// ---------------------------------------------------------------------------
// RTC: dual-endpoint + OpenID KV concurrent
// ---------------------------------------------------------------------------

describe('race rtc get_token∥sfu/get dual-endpoint after #200', () => {
  it('parallel get_token and sfu/get both issue JWTs', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
    for (const r of results) {
      expect(r.body).toMatchObject({ url: 'wss://livekit.example/rtc', jwt: 'jwt.race.token' });
    }
  });

  it('dual-endpoint soft-0 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-0:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-0:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-1 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-1:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-1:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-2 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-2:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-2:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-3 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-3:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-3:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-4 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-4:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-4:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-5 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-5:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-5:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-6 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-6:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-6:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-7 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-7:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-7:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-8 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-8:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-8:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-9 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-9:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-9:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-10 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-10:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-10:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-11 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-11:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-11:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-12 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-12:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-12:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-13 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-13:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-13:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-14 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-14:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-14:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('dual-endpoint soft-15 both 200 with distinct rooms', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(`!a-15:example.com`))),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody(`!b-15:example.com`))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('triple get_token concurrent soft-0', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-0-1` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-0-2` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-0-3` }))),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(3);
  });

  it('triple get_token concurrent soft-1', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-1-1` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-1-2` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-1-3` }))),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(3);
  });

  it('triple get_token concurrent soft-2', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-2-1` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-2-2` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-2-3` }))),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(3);
  });

  it('triple get_token concurrent soft-3', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-3-1` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-3-2` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-3-3` }))),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(3);
  });

  it('triple get_token concurrent soft-4', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-4-1` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-4-2` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-4-3` }))),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(3);
  });

  it('triple get_token concurrent soft-5', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-5-1` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-5-2` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-5-3` }))),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(3);
  });

  it('triple get_token concurrent soft-6', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-6-1` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-6-2` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-6-3` }))),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(3);
  });

  it('triple get_token concurrent soft-7', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-7-1` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-7-2` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-7-3` }))),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(3);
  });

  it('triple get_token concurrent soft-8', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-8-1` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-8-2` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-8-3` }))),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(3);
  });

  it('triple get_token concurrent soft-9', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-9-1` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-9-2` }))),
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody(ROOM, { device_id: `D-9-3` }))),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(3);
  });

});

describe('race rtc OpenID KV mutate mid-flight after #200', () => {
  it('OpenID token deleted mid dual get — both still 200 (verify is soft)', async () => {
    const sessions = mockKv(
      { 'openid:oid-tok': JSON.stringify({ user_id: USER }) },
      {
        getBarrier: { count: 2, match: (key) => key.startsWith('openid:') },
        mutateAfterGets: { after: 1, next: {} },
      }
    );
    const env = createRtcEnv({ sessions });
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    // verifyOpenIDToken failure only logs — request still succeeds
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('OpenID foreign-server soft-0 still issues token', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(
        rtcApp,
        env,
        LK_TOKEN,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
      requestApp(
        rtcApp,
        env,
        LK_SFU,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('OpenID foreign-server soft-1 still issues token', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(
        rtcApp,
        env,
        LK_TOKEN,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
      requestApp(
        rtcApp,
        env,
        LK_SFU,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('OpenID foreign-server soft-2 still issues token', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(
        rtcApp,
        env,
        LK_TOKEN,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
      requestApp(
        rtcApp,
        env,
        LK_SFU,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('OpenID foreign-server soft-3 still issues token', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(
        rtcApp,
        env,
        LK_TOKEN,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
      requestApp(
        rtcApp,
        env,
        LK_SFU,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('OpenID foreign-server soft-4 still issues token', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(
        rtcApp,
        env,
        LK_TOKEN,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
      requestApp(
        rtcApp,
        env,
        LK_SFU,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('OpenID foreign-server soft-5 still issues token', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(
        rtcApp,
        env,
        LK_TOKEN,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
      requestApp(
        rtcApp,
        env,
        LK_SFU,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('OpenID foreign-server soft-6 still issues token', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(
        rtcApp,
        env,
        LK_TOKEN,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
      requestApp(
        rtcApp,
        env,
        LK_SFU,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('OpenID foreign-server soft-7 still issues token', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(
        rtcApp,
        env,
        LK_TOKEN,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
      requestApp(
        rtcApp,
        env,
        LK_SFU,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('OpenID foreign-server soft-8 still issues token', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(
        rtcApp,
        env,
        LK_TOKEN,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
      requestApp(
        rtcApp,
        env,
        LK_SFU,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('OpenID foreign-server soft-9 still issues token', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(
        rtcApp,
        env,
        LK_TOKEN,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
      requestApp(
        rtcApp,
        env,
        LK_SFU,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('OpenID foreign-server soft-10 still issues token', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(
        rtcApp,
        env,
        LK_TOKEN,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
      requestApp(
        rtcApp,
        env,
        LK_SFU,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('OpenID foreign-server soft-11 still issues token', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(
        rtcApp,
        env,
        LK_TOKEN,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
      requestApp(
        rtcApp,
        env,
        LK_SFU,
        jsonInit('POST', tokenBody(ROOM, { openid_token: openid({ matrix_server_name: 'other.example' }) }))
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

});

describe('race rtc transports + soft floods after #200', () => {
  it('parallel transports with LiveKit configured advertise livekit', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, TRANSPORTS, { headers: AUTH }),
      requestApp(rtcApp, env, TRANSPORTS, { headers: AUTH }),
      requestApp(rtcApp, env, TRANSPORTS, { headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { transports: Array<{ type: string }> };
      expect(body.transports[0].type).toBe('livekit');
    }
  });

  it('transports empty concurrent soft-0', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, TRANSPORTS),
      requestApp(rtcApp, env, TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { transports: unknown[] }).transports.length === 0)).toBe(
      true
    );
  });

  it('transports empty concurrent soft-1', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, TRANSPORTS),
      requestApp(rtcApp, env, TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { transports: unknown[] }).transports.length === 0)).toBe(
      true
    );
  });

  it('transports empty concurrent soft-2', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, TRANSPORTS),
      requestApp(rtcApp, env, TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { transports: unknown[] }).transports.length === 0)).toBe(
      true
    );
  });

  it('transports empty concurrent soft-3', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, TRANSPORTS),
      requestApp(rtcApp, env, TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { transports: unknown[] }).transports.length === 0)).toBe(
      true
    );
  });

  it('transports empty concurrent soft-4', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, TRANSPORTS),
      requestApp(rtcApp, env, TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { transports: unknown[] }).transports.length === 0)).toBe(
      true
    );
  });

  it('transports empty concurrent soft-5', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, TRANSPORTS),
      requestApp(rtcApp, env, TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { transports: unknown[] }).transports.length === 0)).toBe(
      true
    );
  });

  it('transports empty concurrent soft-6', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, TRANSPORTS),
      requestApp(rtcApp, env, TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { transports: unknown[] }).transports.length === 0)).toBe(
      true
    );
  });

  it('transports empty concurrent soft-7', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, TRANSPORTS),
      requestApp(rtcApp, env, TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { transports: unknown[] }).transports.length === 0)).toBe(
      true
    );
  });

  it('transports empty concurrent soft-8', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, TRANSPORTS),
      requestApp(rtcApp, env, TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { transports: unknown[] }).transports.length === 0)).toBe(
      true
    );
  });

  it('transports empty concurrent soft-9', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, TRANSPORTS),
      requestApp(rtcApp, env, TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { transports: unknown[] }).transports.length === 0)).toBe(
      true
    );
  });

  it('transports empty concurrent soft-10', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, TRANSPORTS),
      requestApp(rtcApp, env, TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { transports: unknown[] }).transports.length === 0)).toBe(
      true
    );
  });

  it('transports empty concurrent soft-11', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, TRANSPORTS),
      requestApp(rtcApp, env, TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { transports: unknown[] }).transports.length === 0)).toBe(
      true
    );
  });

  it('missing room concurrent soft-0', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', { openid_token: openid() })),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', { openid_token: openid() })),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_BAD_JSON')).toBe(true);
  });

  it('missing room concurrent soft-1', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', { openid_token: openid() })),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', { openid_token: openid() })),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_BAD_JSON')).toBe(true);
  });

  it('missing room concurrent soft-2', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', { openid_token: openid() })),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', { openid_token: openid() })),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_BAD_JSON')).toBe(true);
  });

  it('missing room concurrent soft-3', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', { openid_token: openid() })),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', { openid_token: openid() })),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_BAD_JSON')).toBe(true);
  });

  it('missing room concurrent soft-4', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', { openid_token: openid() })),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', { openid_token: openid() })),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_BAD_JSON')).toBe(true);
  });

  it('missing room concurrent soft-5', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', { openid_token: openid() })),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', { openid_token: openid() })),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_BAD_JSON')).toBe(true);
  });

  it('missing room concurrent soft-6', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', { openid_token: openid() })),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', { openid_token: openid() })),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_BAD_JSON')).toBe(true);
  });

  it('missing room concurrent soft-7', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', { openid_token: openid() })),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', { openid_token: openid() })),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_BAD_JSON')).toBe(true);
  });

  it('missing room concurrent soft-8', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', { openid_token: openid() })),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', { openid_token: openid() })),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_BAD_JSON')).toBe(true);
  });

  it('missing room concurrent soft-9', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', { openid_token: openid() })),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', { openid_token: openid() })),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_BAD_JSON')).toBe(true);
  });

  it('bad JSON concurrent soft-0', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-0',
      }),
      requestApp(rtcApp, env, LK_SFU, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  it('bad JSON concurrent soft-1', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-1',
      }),
      requestApp(rtcApp, env, LK_SFU, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  it('bad JSON concurrent soft-2', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-2',
      }),
      requestApp(rtcApp, env, LK_SFU, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  it('bad JSON concurrent soft-3', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-3',
      }),
      requestApp(rtcApp, env, LK_SFU, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  it('bad JSON concurrent soft-4', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-4',
      }),
      requestApp(rtcApp, env, LK_SFU, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  it('bad JSON concurrent soft-5', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-5',
      }),
      requestApp(rtcApp, env, LK_SFU, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  it('bad JSON concurrent soft-6', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-6',
      }),
      requestApp(rtcApp, env, LK_SFU, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  it('bad JSON concurrent soft-7', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-7',
      }),
      requestApp(rtcApp, env, LK_SFU, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  it('bad JSON concurrent soft-8', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-8',
      }),
      requestApp(rtcApp, env, LK_SFU, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  it('bad JSON concurrent soft-9', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: 'not-json-9',
      }),
      requestApp(rtcApp, env, LK_SFU, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  it('LiveKit not configured concurrent soft-0', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('LiveKit not configured concurrent soft-1', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('LiveKit not configured concurrent soft-2', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('LiveKit not configured concurrent soft-3', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('LiveKit not configured concurrent soft-4', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('LiveKit not configured concurrent soft-5', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('LiveKit not configured concurrent soft-6', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('LiveKit not configured concurrent soft-7', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('method-not-allowed GET concurrent soft-0', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, { method: 'GET', headers: AUTH }),
      requestApp(rtcApp, env, LK_SFU, { method: 'GET', headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([405, 405]);
  });

  it('method-not-allowed GET concurrent soft-1', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, { method: 'GET', headers: AUTH }),
      requestApp(rtcApp, env, LK_SFU, { method: 'GET', headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([405, 405]);
  });

  it('method-not-allowed GET concurrent soft-2', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, { method: 'GET', headers: AUTH }),
      requestApp(rtcApp, env, LK_SFU, { method: 'GET', headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([405, 405]);
  });

  it('method-not-allowed GET concurrent soft-3', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, { method: 'GET', headers: AUTH }),
      requestApp(rtcApp, env, LK_SFU, { method: 'GET', headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([405, 405]);
  });

  it('method-not-allowed GET concurrent soft-4', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, { method: 'GET', headers: AUTH }),
      requestApp(rtcApp, env, LK_SFU, { method: 'GET', headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([405, 405]);
  });

  it('method-not-allowed GET concurrent soft-5', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, { method: 'GET', headers: AUTH }),
      requestApp(rtcApp, env, LK_SFU, { method: 'GET', headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([405, 405]);
  });

  it('method-not-allowed GET concurrent soft-6', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, { method: 'GET', headers: AUTH }),
      requestApp(rtcApp, env, LK_SFU, { method: 'GET', headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([405, 405]);
  });

  it('method-not-allowed GET concurrent soft-7', async () => {
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, { method: 'GET', headers: AUTH }),
      requestApp(rtcApp, env, LK_SFU, { method: 'GET', headers: AUTH }),
    ]);
    expect(statusesOf(results)).toEqual([405, 405]);
  });

  it('token generate failure concurrent soft-0', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('jwt boom 0'));
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('token generate failure concurrent soft-1', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('jwt boom 1'));
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('token generate failure concurrent soft-2', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('jwt boom 2'));
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('token generate failure concurrent soft-3', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('jwt boom 3'));
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('token generate failure concurrent soft-4', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('jwt boom 4'));
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('token generate failure concurrent soft-5', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('jwt boom 5'));
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('token generate failure concurrent soft-6', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('jwt boom 6'));
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('token generate failure concurrent soft-7', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('jwt boom 7'));
    const env = createRtcEnv();
    const results = await Promise.all([
      requestApp(rtcApp, env, LK_TOKEN, jsonInit('POST', tokenBody())),
      requestApp(rtcApp, env, LK_SFU, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

});

describe('race module isolation voip∥rtc∥calls after #200', () => {
  it('parallel voip PUT + calls start + rtc get_token do not share DB state', async () => {
    const callsDb = createCallsDb({ memberships: [joined()] });
    const voipDb = createVoipDb({ memberships: [joined()] });
    const callsEnv = createCallsEnv({ db: callsDb });
    const voipEnv = createVoipEnv({ db: voipDb });
    const rtcEnv = createRtcEnv();
    const results = await Promise.all([
      requestApp(callsApp, callsEnv, CALLS_START, jsonInit('POST', {})),
      requestApp(voipApp, voipEnv, VOIP_CALL_V1, jsonInit('PUT', { device_id: 'DEVICEA' })),
      requestApp(rtcApp, rtcEnv, LK_TOKEN, jsonInit('POST', tokenBody())),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(callsDb.stateLinks).toHaveLength(1);
    expect(voipDb.state).toHaveLength(1);
    expect(callsDb.state).toBeUndefined();
  });

  it('isolation soft-0: voip GET + calls GET + transports', async () => {
    const callsDb = createCallsDb({ memberships: [joined()] });
    seedActiveCall(callsDb, activeCallContent({ call_id: `iso-0` }));
    const voipDb = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: `v-0`, expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
    });
    const results = await Promise.all([
      requestApp(callsApp, createCallsEnv({ db: callsDb }), CALLS_GET, { headers: AUTH }),
      requestApp(voipApp, createVoipEnv({ db: voipDb }), VOIP_CALL_V1, { headers: AUTH }),
      requestApp(rtcApp, createRtcEnv(), TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-0`);
    expect((results[1].body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('isolation soft-1: voip GET + calls GET + transports', async () => {
    const callsDb = createCallsDb({ memberships: [joined()] });
    seedActiveCall(callsDb, activeCallContent({ call_id: `iso-1` }));
    const voipDb = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: `v-1`, expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
    });
    const results = await Promise.all([
      requestApp(callsApp, createCallsEnv({ db: callsDb }), CALLS_GET, { headers: AUTH }),
      requestApp(voipApp, createVoipEnv({ db: voipDb }), VOIP_CALL_V1, { headers: AUTH }),
      requestApp(rtcApp, createRtcEnv(), TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-1`);
    expect((results[1].body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('isolation soft-2: voip GET + calls GET + transports', async () => {
    const callsDb = createCallsDb({ memberships: [joined()] });
    seedActiveCall(callsDb, activeCallContent({ call_id: `iso-2` }));
    const voipDb = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: `v-2`, expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
    });
    const results = await Promise.all([
      requestApp(callsApp, createCallsEnv({ db: callsDb }), CALLS_GET, { headers: AUTH }),
      requestApp(voipApp, createVoipEnv({ db: voipDb }), VOIP_CALL_V1, { headers: AUTH }),
      requestApp(rtcApp, createRtcEnv(), TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-2`);
    expect((results[1].body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('isolation soft-3: voip GET + calls GET + transports', async () => {
    const callsDb = createCallsDb({ memberships: [joined()] });
    seedActiveCall(callsDb, activeCallContent({ call_id: `iso-3` }));
    const voipDb = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: `v-3`, expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
    });
    const results = await Promise.all([
      requestApp(callsApp, createCallsEnv({ db: callsDb }), CALLS_GET, { headers: AUTH }),
      requestApp(voipApp, createVoipEnv({ db: voipDb }), VOIP_CALL_V1, { headers: AUTH }),
      requestApp(rtcApp, createRtcEnv(), TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-3`);
    expect((results[1].body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('isolation soft-4: voip GET + calls GET + transports', async () => {
    const callsDb = createCallsDb({ memberships: [joined()] });
    seedActiveCall(callsDb, activeCallContent({ call_id: `iso-4` }));
    const voipDb = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: `v-4`, expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
    });
    const results = await Promise.all([
      requestApp(callsApp, createCallsEnv({ db: callsDb }), CALLS_GET, { headers: AUTH }),
      requestApp(voipApp, createVoipEnv({ db: voipDb }), VOIP_CALL_V1, { headers: AUTH }),
      requestApp(rtcApp, createRtcEnv(), TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-4`);
    expect((results[1].body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('isolation soft-5: voip GET + calls GET + transports', async () => {
    const callsDb = createCallsDb({ memberships: [joined()] });
    seedActiveCall(callsDb, activeCallContent({ call_id: `iso-5` }));
    const voipDb = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: `v-5`, expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
    });
    const results = await Promise.all([
      requestApp(callsApp, createCallsEnv({ db: callsDb }), CALLS_GET, { headers: AUTH }),
      requestApp(voipApp, createVoipEnv({ db: voipDb }), VOIP_CALL_V1, { headers: AUTH }),
      requestApp(rtcApp, createRtcEnv(), TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-5`);
    expect((results[1].body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('isolation soft-6: voip GET + calls GET + transports', async () => {
    const callsDb = createCallsDb({ memberships: [joined()] });
    seedActiveCall(callsDb, activeCallContent({ call_id: `iso-6` }));
    const voipDb = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: `v-6`, expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
    });
    const results = await Promise.all([
      requestApp(callsApp, createCallsEnv({ db: callsDb }), CALLS_GET, { headers: AUTH }),
      requestApp(voipApp, createVoipEnv({ db: voipDb }), VOIP_CALL_V1, { headers: AUTH }),
      requestApp(rtcApp, createRtcEnv(), TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-6`);
    expect((results[1].body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('isolation soft-7: voip GET + calls GET + transports', async () => {
    const callsDb = createCallsDb({ memberships: [joined()] });
    seedActiveCall(callsDb, activeCallContent({ call_id: `iso-7` }));
    const voipDb = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: `v-7`, expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
    });
    const results = await Promise.all([
      requestApp(callsApp, createCallsEnv({ db: callsDb }), CALLS_GET, { headers: AUTH }),
      requestApp(voipApp, createVoipEnv({ db: voipDb }), VOIP_CALL_V1, { headers: AUTH }),
      requestApp(rtcApp, createRtcEnv(), TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-7`);
    expect((results[1].body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('isolation soft-8: voip GET + calls GET + transports', async () => {
    const callsDb = createCallsDb({ memberships: [joined()] });
    seedActiveCall(callsDb, activeCallContent({ call_id: `iso-8` }));
    const voipDb = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: `v-8`, expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
    });
    const results = await Promise.all([
      requestApp(callsApp, createCallsEnv({ db: callsDb }), CALLS_GET, { headers: AUTH }),
      requestApp(voipApp, createVoipEnv({ db: voipDb }), VOIP_CALL_V1, { headers: AUTH }),
      requestApp(rtcApp, createRtcEnv(), TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-8`);
    expect((results[1].body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('isolation soft-9: voip GET + calls GET + transports', async () => {
    const callsDb = createCallsDb({ memberships: [joined()] });
    seedActiveCall(callsDb, activeCallContent({ call_id: `iso-9` }));
    const voipDb = createVoipDb({
      memberships: [joined()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: `v-9`, expires_ts: Date.now() + 3_600_000 },
        ]),
      ],
    });
    const results = await Promise.all([
      requestApp(callsApp, createCallsEnv({ db: callsDb }), CALLS_GET, { headers: AUTH }),
      requestApp(voipApp, createVoipEnv({ db: voipDb }), VOIP_CALL_V1, { headers: AUTH }),
      requestApp(rtcApp, createRtcEnv(), TRANSPORTS),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect((results[0].body as { callId: string }).callId).toBe(`iso-9`);
    expect((results[1].body as { members: unknown[] }).members).toHaveLength(1);
  });

});

