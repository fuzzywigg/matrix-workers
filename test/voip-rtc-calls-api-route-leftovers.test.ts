/**
 * TOKENMAXX HEAVY leftovers after #159 — voip/rtc/calls soft/edge/reliability.
 * Complements voip/rtc/calls route suites. Tests-only — no product inventing.
 * Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { TurnError } from '../src/services/turn';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

const turnMocks = vi.hoisted(() => ({
  isTurnConfigured: vi.fn(),
  getMatrixTurnCredentials: vi.fn(),
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
  getLiveKitConfig: vi.fn(),
  generateLiveKitToken: vi.fn(async () => 'jwt.leftover.token'),
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

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateOpaqueId: vi.fn(async () => 'leftover-call-id16'),
  };
});

import voipApp from '../src/api/voip';
import rtcApp from '../src/api/rtc';
import callsApp from '../src/api/calls';

const USER = '@alice:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const NOW = 1_700_000_000_000;
const STUN = {
  username: '',
  password: '',
  uris: ['stun:stun.cloudflare.com:3478'],
  ttl: 86400,
};
const LK_CONFIG = {
  apiKey: 'lk-key',
  apiSecret: 'lk-secret',
  wsUrl: 'wss://livekit.example.com/rtc',
};
const CALL_ID = 'leftover-call-id16';

type Membership = { room_id: string; user_id: string; membership: string };

type StateRow = {
  room_id: string;
  type: string;
  state_key: string;
  event_id: string;
  content: string;
  sender: string;
  origin_server_ts: number;
};

type EventRow = {
  event_id: string;
  room_id: string;
  type: string;
  sender: string;
  content: string;
  state_key: string;
  origin_server_ts: number;
};

type StateLink = {
  room_id: string;
  event_type: string;
  state_key: string;
  event_id: string;
};

type SqlCall = { sql: string; args: unknown[] };

type KvPut = { key: string; value: string };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const kv = {
    data,
    puts,
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
      delete data[key];
    },
  };
  return kv as unknown as KVNamespace & { data: Record<string, string>; puts: KvPut[] };
}

function createVoipDb(opts: {
  memberships?: Membership[];
  state?: StateRow[];
} = {}) {
  const memberships = opts.memberships ?? [];
  const state = opts.state ?? [];
  const events: EventRow[] = [];
  const selects: SqlCall[] = [];
  const runs: SqlCall[] = [];

  const db = {
    memberships,
    state,
    events,
    selects,
    runs,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                return (row ? { membership: row.membership } : null) as T;
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
                return (row ? { content: row.content } : null) as T;
              }
              return null as T;
            },
            async all<T>() {
              selects.push({ sql, args });
              if (sql.includes("type = 'm.call.member'") && sql.includes('SELECT state_key, content')) {
                const [roomId] = args as string[];
                const rows = state
                  .filter((s) => s.room_id === roomId && s.type === 'm.call.member')
                  .map((s) => ({ state_key: s.state_key, content: s.content }));
                return { results: rows as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              runs.push({ sql, args });
              if (sql.includes('INSERT INTO room_state')) {
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
                const row: StateRow = {
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

function createCallRoomStub(opts: { failEnd?: boolean } = {}) {
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      fetches.push({ url: req.url, method: req.method, body });
      if (opts.failEnd && req.url.includes('/end')) {
        throw new Error('end boom');
      }
      if (req.url.includes('/ws')) {
        return new Response('ws-proxy', { status: 200, headers: { 'X-WS-Proxy': '1' } });
      }
      return Response.json({ ok: true });
    },
  };
}

type CallRoomStub = ReturnType<typeof createCallRoomStub>;

function createCallsDb(opts: {
  memberships?: Membership[];
  stateLinks?: StateLink[];
  events?: EventRow[];
} = {}) {
  const memberships = opts.memberships ?? [];
  const stateLinks = opts.stateLinks ?? [];
  const events = opts.events ?? [];
  const selects: SqlCall[] = [];
  const runs: SqlCall[] = [];

  const db = {
    memberships,
    stateLinks,
    events,
    selects,
    runs,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                return (row ? { membership: row.membership } : null) as T;
              }
              if (
                sql.includes('FROM room_state rs') &&
                sql.includes("rs.event_type = 'm.call.state'")
              ) {
                const [roomId] = args as string[];
                const link = stateLinks.find(
                  (s) => s.room_id === roomId && s.event_type === 'm.call.state'
                );
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
              runs.push({ sql, args });
              if (sql.includes('INSERT INTO room_state')) {
                const [roomId, eventId] = args as string[];
                const existing = stateLinks.findIndex(
                  (s) =>
                    s.room_id === roomId &&
                    s.event_type === 'm.call.state' &&
                    s.state_key === ''
                );
                const row: StateLink = {
                  room_id: roomId,
                  event_type: 'm.call.state',
                  state_key: '',
                  event_id: eventId,
                };
                if (existing >= 0) stateLinks[existing] = row;
                else stateLinks.push(row);
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
                const row: EventRow = {
                  event_id: eventId,
                  room_id: roomId,
                  type: 'm.call.state',
                  sender,
                  content,
                  origin_server_ts: ts,
                };
                if (idx >= 0) events[idx] = row;
                else events.push(row);
                return { meta: { changes: 1, last_row_id: events.length } };
              }
              if (sql.includes('UPDATE events SET content')) {
                const [content, eventId] = args as [string, string];
                const ev = events.find((e) => e.event_id === eventId);
                if (ev) ev.content = content;
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

function createRtcEnv(opts: { sessions?: ReturnType<typeof mockKv> } = {}) {
  return {
    SERVER_NAME: SERVER,
    SESSIONS: opts.sessions ?? mockKv(),
    LIVEKIT_API_KEY: 'lk-key',
    LIVEKIT_API_SECRET: 'lk-secret',
    LIVEKIT_URL: LK_CONFIG.wsUrl,
  } as unknown as Env;
}

function createCallsEnv(
  opts: {
    db?: CallsDb;
    callRoom?: CallRoomStub;
    noCallRooms?: boolean;
    configured?: boolean;
  } = {}
) {
  const db = opts.db ?? createCallsDb();
  const callRoom = opts.callRoom ?? createCallRoomStub();
  const env: Record<string, unknown> = {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    CALLS_APP_ID: opts.configured === false ? undefined : 'app',
    CALLS_APP_SECRET: opts.configured === false ? undefined : 'secret',
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

async function voipRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await voipApp.request(`http://localhost${path}`, init, env);
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

async function rtcRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
  const res = await rtcApp.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text, headers: res.headers };
}

async function callsRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await callsApp.request(`http://localhost${path}`, init, env);
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

function jsonInit(method: string, body?: unknown, contentType = 'application/json'): RequestInit {
  return {
    method,
    headers: {
      Authorization: 'Bearer t',
      'Content-Type': contentType,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function joinMember(roomId = ROOM, userId = USER): Membership {
  return { room_id: roomId, user_id: userId, membership: 'join' };
}

function callMemberState(
  userId: string,
  memberships: Array<Record<string, unknown>>,
  roomId = ROOM
): StateRow {
  return {
    room_id: roomId,
    type: 'm.call.member',
    state_key: userId,
    event_id: `$call_${userId}`,
    content: JSON.stringify({ memberships }),
    sender: userId,
    origin_server_ts: NOW,
  };
}

function seedActiveCall(db: CallsDb, callId = CALL_ID, active = true) {
  const content = JSON.stringify({
    active,
    call_id: callId,
    started_by: USER,
    started_at: NOW,
    participants: [],
  });
  db.stateLinks.push({
    room_id: ROOM,
    event_type: 'm.call.state',
    state_key: '',
    event_id: `call_${callId}`,
  });
  db.events.push({
    event_id: `call_${callId}`,
    room_id: ROOM,
    type: 'm.call.state',
    sender: USER,
    content,
    origin_server_ts: NOW,
  });
}

function openid(accessToken = 'oid-tok') {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    matrix_server_name: SERVER,
    expires_in: 3600,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  turnMocks.getStunServers.mockReturnValue(STUN);
  turnMocks.isTurnConfigured.mockReturnValue(false);
  livekitMocks.getLiveKitConfig.mockReturnValue(null);
  livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.leftover.token');
  callsMocks.isCallsConfigured.mockReturnValue(true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});


describe('leftovers voip turnServer STUN-only soft flood after #159', () => {

  it('STUN-only soft-0', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-1', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-2', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-3', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-4', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-5', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-6', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-7', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-8', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-9', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-10', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-11', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-12', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-13', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-14', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-15', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-16', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-17', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-18', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-19', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

});

describe('leftovers voip turnServer TURN configured soft flood after #159', () => {

  it('TURN configured soft-0', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u0',
      password: 'p0',
      uris: [`turn:turn0.example.com:3478?transport=udp`],
      ttl: 3600 + 0,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u0');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-1', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u1',
      password: 'p1',
      uris: [`turn:turn1.example.com:3478?transport=udp`],
      ttl: 3600 + 1,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u1');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-2', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u2',
      password: 'p2',
      uris: [`turn:turn2.example.com:3478?transport=udp`],
      ttl: 3600 + 2,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u2');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-3', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u3',
      password: 'p3',
      uris: [`turn:turn3.example.com:3478?transport=udp`],
      ttl: 3600 + 3,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u3');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-4', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u4',
      password: 'p4',
      uris: [`turn:turn4.example.com:3478?transport=udp`],
      ttl: 3600 + 4,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u4');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-5', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u5',
      password: 'p5',
      uris: [`turn:turn5.example.com:3478?transport=udp`],
      ttl: 3600 + 5,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u5');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-6', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u6',
      password: 'p6',
      uris: [`turn:turn6.example.com:3478?transport=udp`],
      ttl: 3600 + 6,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u6');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-7', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u7',
      password: 'p7',
      uris: [`turn:turn7.example.com:3478?transport=udp`],
      ttl: 3600 + 7,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u7');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-8', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u8',
      password: 'p8',
      uris: [`turn:turn8.example.com:3478?transport=udp`],
      ttl: 3600 + 8,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u8');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-9', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u9',
      password: 'p9',
      uris: [`turn:turn9.example.com:3478?transport=udp`],
      ttl: 3600 + 9,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u9');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-10', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u10',
      password: 'p10',
      uris: [`turn:turn10.example.com:3478?transport=udp`],
      ttl: 3600 + 10,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u10');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-11', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u11',
      password: 'p11',
      uris: [`turn:turn11.example.com:3478?transport=udp`],
      ttl: 3600 + 11,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u11');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-12', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u12',
      password: 'p12',
      uris: [`turn:turn12.example.com:3478?transport=udp`],
      ttl: 3600 + 12,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u12');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-13', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u13',
      password: 'p13',
      uris: [`turn:turn13.example.com:3478?transport=udp`],
      ttl: 3600 + 13,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u13');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-14', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u14',
      password: 'p14',
      uris: [`turn:turn14.example.com:3478?transport=udp`],
      ttl: 3600 + 14,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u14');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-15', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u15',
      password: 'p15',
      uris: [`turn:turn15.example.com:3478?transport=udp`],
      ttl: 3600 + 15,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u15');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-16', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u16',
      password: 'p16',
      uris: [`turn:turn16.example.com:3478?transport=udp`],
      ttl: 3600 + 16,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u16');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-17', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u17',
      password: 'p17',
      uris: [`turn:turn17.example.com:3478?transport=udp`],
      ttl: 3600 + 17,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u17');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-18', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u18',
      password: 'p18',
      uris: [`turn:turn18.example.com:3478?transport=udp`],
      ttl: 3600 + 18,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u18');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN configured soft-19', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u19',
      password: 'p19',
      uris: [`turn:turn19.example.com:3478?transport=udp`],
      ttl: 3600 + 19,
    });
    const env = createVoipEnv();
    const res = await voipRequest(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { username: string }).username).toBe('u19');
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

});

describe('leftovers voip turnServer failure edges after #159', () => {

  it('USER_RATE_LIMITED with retry', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new TurnError('rate', 'USER_RATE_LIMITED', 429, 30000));
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ errcode: 'M_LIMIT_EXCEEDED' });
  });

  it('USER_RATE_LIMITED default retry', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new TurnError('rate', 'USER_RATE_LIMITED', 429));
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ errcode: 'M_LIMIT_EXCEEDED' });
  });

  it('RATE_LIMITED', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new TurnError('cf', 'RATE_LIMITED', 429));
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ errcode: 'M_LIMIT_EXCEEDED' });
  });

  it('API_ERROR degrades STUN', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new TurnError('api', 'API_ERROR', 500));
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
  });

  it('NOT_CONFIGURED degrades STUN', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new TurnError('nope', 'NOT_CONFIGURED'));
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
  });

  it('INVALID_RESPONSE degrades STUN', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new TurnError('bad', 'INVALID_RESPONSE'));
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
  });

  it('network error degrades STUN', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new Error('network'));
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
  });

  it('TypeError degrades STUN', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new TypeError('oops'));
    const res = await voipRequest(createVoipEnv(), '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STUN);
  });

});

describe('leftovers rtc transports empty soft flood after #159', () => {

  it('transports empty soft-0', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-1', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-2', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-3', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-4', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-5', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-6', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-7', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-8', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-9', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-10', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-11', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-12', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-13', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-14', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-15', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

});

describe('leftovers rtc transports configured soft flood after #159', () => {

  it('transports livekit soft-0', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-1', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-2', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-3', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-4', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-5', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-6', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-7', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-8', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-9', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-10', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-11', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-12', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-13', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-14', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-15', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

});

describe('leftovers rtc get_token missing config soft flood after #159', () => {

  it('get_token no config soft-0', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-1', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-2', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-3', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-4', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-5', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-6', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-7', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-8', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-9', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-10', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-11', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-12', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-13', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-14', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('get_token no config soft-15', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await rtcRequest(
      createRtcEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

});

describe('leftovers rtc get_token charset room grid after #159', () => {
  beforeEach(() => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.charset');
  });

  it('charset room-0', async () => {
    await rtcRequest(createRtcEnv(), '/livekit/get_token', jsonInit('POST', { room: '!a:example.com' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_a_example_com');
  });

  it('charset room-1', async () => {
    await rtcRequest(createRtcEnv(), '/livekit/get_token', jsonInit('POST', { room: '!AbC/xyz:server.name' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_AbC_xyz_server_name');
  });

  it('charset room-2', async () => {
    await rtcRequest(createRtcEnv(), '/livekit/get_token', jsonInit('POST', { room: '!room+plus:example.com' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_room_plus_example_com');
  });

  it('charset room-3', async () => {
    await rtcRequest(createRtcEnv(), '/livekit/get_token', jsonInit('POST', { room: '!weird/slash:example.com' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_weird_slash_example_com');
  });

  it('charset room-4', async () => {
    await rtcRequest(createRtcEnv(), '/livekit/get_token', jsonInit('POST', { room: '!dash-room:example.com' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_dash-room_example_com');
  });

  it('charset room-5', async () => {
    await rtcRequest(createRtcEnv(), '/livekit/get_token', jsonInit('POST', { room: '!under_score:example.com' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_under_score_example_com');
  });

  it('charset room-6', async () => {
    await rtcRequest(createRtcEnv(), '/livekit/get_token', jsonInit('POST', { room: '!mix/+-_:x.y' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_mix__-__x_y');
  });

  it('charset room-7', async () => {
    await rtcRequest(createRtcEnv(), '/livekit/get_token', jsonInit('POST', { room: '!unicode-ok:example.com' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_unicode-ok_example_com');
  });

  it('charset room-8', async () => {
    await rtcRequest(createRtcEnv(), '/livekit/get_token', jsonInit('POST', { room: '!0123:example.com' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_0123_example_com');
  });

  it('charset room-9', async () => {
    await rtcRequest(createRtcEnv(), '/livekit/get_token', jsonInit('POST', { room: '!UPPER:EXAMPLE.COM' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_UPPER_EXAMPLE_COM');
  });

  it('charset room-10', async () => {
    await rtcRequest(createRtcEnv(), '/livekit/get_token', jsonInit('POST', { room: '!a.b:c.d' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_a_b_c_d');
  });

  it('charset room-11', async () => {
    await rtcRequest(createRtcEnv(), '/livekit/get_token', jsonInit('POST', { room: '!room%20:example.com' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_room_20_example_com');
  });

});

describe('leftovers rtc livekit method matrix after #159', () => {
  beforeEach(() => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
  });

  it('method matrix GET /livekit/get_token soft-0', async () => {
    const res = await rtcRequest(createRtcEnv(), '/livekit/get_token', { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('method matrix PUT /livekit/get_token soft-1', async () => {
    const res = await rtcRequest(createRtcEnv(), '/livekit/get_token', { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('method matrix PATCH /livekit/get_token soft-2', async () => {
    const res = await rtcRequest(createRtcEnv(), '/livekit/get_token', { method: 'PATCH' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('method matrix DELETE /livekit/get_token soft-3', async () => {
    const res = await rtcRequest(createRtcEnv(), '/livekit/get_token', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('method matrix HEAD /livekit/get_token soft-4', async () => {
    const res = await rtcRequest(createRtcEnv(), '/livekit/get_token', { method: 'HEAD' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('method matrix GET /livekit/get_token/sfu/get soft-5', async () => {
    const res = await rtcRequest(createRtcEnv(), '/livekit/get_token/sfu/get', { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('method matrix PUT /livekit/get_token/sfu/get soft-6', async () => {
    const res = await rtcRequest(createRtcEnv(), '/livekit/get_token/sfu/get', { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('method matrix PATCH /livekit/get_token/sfu/get soft-7', async () => {
    const res = await rtcRequest(createRtcEnv(), '/livekit/get_token/sfu/get', { method: 'PATCH' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('method matrix DELETE /livekit/get_token/sfu/get soft-8', async () => {
    const res = await rtcRequest(createRtcEnv(), '/livekit/get_token/sfu/get', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('method matrix HEAD /livekit/get_token/sfu/get soft-9', async () => {
    const res = await rtcRequest(createRtcEnv(), '/livekit/get_token/sfu/get', { method: 'HEAD' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('OPTIONS preflight /livekit/get_token', async () => {
    const res = await rtcRequest(createRtcEnv(), '/livekit/get_token', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('OPTIONS preflight /livekit/get_token/sfu/get', async () => {
    const res = await rtcRequest(createRtcEnv(), '/livekit/get_token/sfu/get', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

});

describe('leftovers voip GET call 404 soft flood after #159', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('GET call 404 soft-0', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-1', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-2', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-3', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-4', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-5', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-6', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-7', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-8', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-9', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-10', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-11', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-12', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-13', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-14', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET call 404 soft-15', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

});

describe('leftovers voip GET call 200 soft flood after #159', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('GET call 200 soft-0', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV0', expires_ts: NOW + 60000 + 0, call_id: 'c0' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV0');
  });

  it('GET call 200 soft-1', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV1', expires_ts: NOW + 60000 + 1, call_id: 'c1' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV1');
  });

  it('GET call 200 soft-2', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV2', expires_ts: NOW + 60000 + 2, call_id: 'c2' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV2');
  });

  it('GET call 200 soft-3', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV3', expires_ts: NOW + 60000 + 3, call_id: 'c3' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV3');
  });

  it('GET call 200 soft-4', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV4', expires_ts: NOW + 60000 + 4, call_id: 'c4' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV4');
  });

  it('GET call 200 soft-5', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV5', expires_ts: NOW + 60000 + 5, call_id: 'c5' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV5');
  });

  it('GET call 200 soft-6', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV6', expires_ts: NOW + 60000 + 6, call_id: 'c6' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV6');
  });

  it('GET call 200 soft-7', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV7', expires_ts: NOW + 60000 + 7, call_id: 'c7' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV7');
  });

  it('GET call 200 soft-8', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV8', expires_ts: NOW + 60000 + 8, call_id: 'c8' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV8');
  });

  it('GET call 200 soft-9', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV9', expires_ts: NOW + 60000 + 9, call_id: 'c9' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV9');
  });

  it('GET call 200 soft-10', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV10', expires_ts: NOW + 60000 + 10, call_id: 'c10' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV10');
  });

  it('GET call 200 soft-11', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV11', expires_ts: NOW + 60000 + 11, call_id: 'c11' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV11');
  });

  it('GET call 200 soft-12', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV12', expires_ts: NOW + 60000 + 12, call_id: 'c12' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV12');
  });

  it('GET call 200 soft-13', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV13', expires_ts: NOW + 60000 + 13, call_id: 'c13' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV13');
  });

  it('GET call 200 soft-14', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV14', expires_ts: NOW + 60000 + 14, call_id: 'c14' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV14');
  });

  it('GET call 200 soft-15', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEV15', expires_ts: NOW + 60000 + 15, call_id: 'c15' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ device_id: string }> }).members[0].device_id).toBe('DEV15');
  });

});

describe('leftovers voip PUT call soft flood after #159', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('PUT call soft-0', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-0', expires_ts: NOW + 3600000 + 0 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-0');
  });

  it('PUT call soft-1', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-1', expires_ts: NOW + 3600000 + 1 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-1');
  });

  it('PUT call soft-2', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-2', expires_ts: NOW + 3600000 + 2 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-2');
  });

  it('PUT call soft-3', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-3', expires_ts: NOW + 3600000 + 3 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-3');
  });

  it('PUT call soft-4', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-4', expires_ts: NOW + 3600000 + 4 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-4');
  });

  it('PUT call soft-5', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-5', expires_ts: NOW + 3600000 + 5 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-5');
  });

  it('PUT call soft-6', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-6', expires_ts: NOW + 3600000 + 6 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-6');
  });

  it('PUT call soft-7', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-7', expires_ts: NOW + 3600000 + 7 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-7');
  });

  it('PUT call soft-8', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-8', expires_ts: NOW + 3600000 + 8 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-8');
  });

  it('PUT call soft-9', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-9', expires_ts: NOW + 3600000 + 9 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-9');
  });

  it('PUT call soft-10', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-10', expires_ts: NOW + 3600000 + 10 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-10');
  });

  it('PUT call soft-11', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-11', expires_ts: NOW + 3600000 + 11 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-11');
  });

  it('PUT call soft-12', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-12', expires_ts: NOW + 3600000 + 12 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-12');
  });

  it('PUT call soft-13', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-13', expires_ts: NOW + 3600000 + 13 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-13');
  });

  it('PUT call soft-14', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-14', expires_ts: NOW + 3600000 + 14 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-14');
  });

  it('PUT call soft-15', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'put-15', expires_ts: NOW + 3600000 + 15 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ call_id: string }> };
    expect(content.memberships[0].call_id).toBe('put-15');
  });

});

describe('leftovers voip DELETE call soft flood after #159', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('DELETE call soft-0', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-0' },
          { device_id: 'KEEP0', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP0']);
  });

  it('DELETE call soft-1', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-1' },
          { device_id: 'KEEP1', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP1']);
  });

  it('DELETE call soft-2', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-2' },
          { device_id: 'KEEP2', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP2']);
  });

  it('DELETE call soft-3', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-3' },
          { device_id: 'KEEP3', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP3']);
  });

  it('DELETE call soft-4', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-4' },
          { device_id: 'KEEP4', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP4']);
  });

  it('DELETE call soft-5', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-5' },
          { device_id: 'KEEP5', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP5']);
  });

  it('DELETE call soft-6', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-6' },
          { device_id: 'KEEP6', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP6']);
  });

  it('DELETE call soft-7', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-7' },
          { device_id: 'KEEP7', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP7']);
  });

  it('DELETE call soft-8', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-8' },
          { device_id: 'KEEP8', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP8']);
  });

  it('DELETE call soft-9', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-9' },
          { device_id: 'KEEP9', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP9']);
  });

  it('DELETE call soft-10', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-10' },
          { device_id: 'KEEP10', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP10']);
  });

  it('DELETE call soft-11', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-11' },
          { device_id: 'KEEP11', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP11']);
  });

  it('DELETE call soft-12', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-12' },
          { device_id: 'KEEP12', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP12']);
  });

  it('DELETE call soft-13', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-13' },
          { device_id: 'KEEP13', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP13']);
  });

  it('DELETE call soft-14', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-14' },
          { device_id: 'KEEP14', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP14']);
  });

  it('DELETE call soft-15', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'del-15' },
          { device_id: 'KEEP15', call_id: 'keep' },
        ]),
      ],
    });
    const res = await voipRequest(
      createVoipEnv({ db }),
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as { memberships: Array<{ device_id: string }> };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP15']);
  });

});

describe('leftovers voip wrong methods after #159', () => {

  it('turnServer POST returns 404', async () => {
    const res = await voipRequest(createVoipEnv({ db: createVoipDb({ memberships: [joinMember()] }) }), '/_matrix/client/v3/voip/turnServer', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });

  it('turnServer PUT returns 404', async () => {
    const res = await voipRequest(createVoipEnv({ db: createVoipDb({ memberships: [joinMember()] }) }), '/_matrix/client/v3/voip/turnServer', {
      method: 'PUT',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });

  it('turnServer DELETE returns 404', async () => {
    const res = await voipRequest(createVoipEnv({ db: createVoipDb({ memberships: [joinMember()] }) }), '/_matrix/client/v3/voip/turnServer', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });

  it('call GET wrong path returns 404', async () => {
    const res = await voipRequest(createVoipEnv({ db: createVoipDb({ memberships: [joinMember()] }) }), '/_matrix/client/v1/rooms/!room%3Aexample.com/call/extra', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });

  it('call POST returns 404', async () => {
    const res = await voipRequest(createVoipEnv({ db: createVoipDb({ memberships: [joinMember()] }) }), '/_matrix/client/v1/rooms/!room%3Aexample.com/call', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });

  it('call PATCH returns 404', async () => {
    const res = await voipRequest(createVoipEnv({ db: createVoipDb({ memberships: [joinMember()] }) }), '/_matrix/client/v1/rooms/!room%3Aexample.com/call', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });

  it('call start on voip returns 404', async () => {
    const res = await voipRequest(createVoipEnv({ db: createVoipDb({ memberships: [joinMember()] }) }), '/_matrix/client/v1/rooms/!room%3Aexample.com/call/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });

  it('call end on voip returns 404', async () => {
    const res = await voipRequest(createVoipEnv({ db: createVoipDb({ memberships: [joinMember()] }) }), '/_matrix/client/v1/rooms/!room%3Aexample.com/call/end', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });

});

describe('leftovers calls GET inactive soft flood after #159', () => {

  it('calls GET inactive soft-0', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-1', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-2', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-3', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-4', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-5', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-6', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-7', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-8', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-9', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-10', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-11', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-12', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-13', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-14', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('calls GET inactive soft-15', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await callsRequest(
      createCallsEnv({ db }),
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

});

describe('leftovers calls lifecycle soft flood after #159', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('calls lifecycle soft-0', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-1', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-2', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-3', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-4', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-5', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-6', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-7', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-8', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-9', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-10', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-11', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-12', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-13', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-14', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('calls lifecycle soft-15', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createCallsEnv({ db, callRoom });
    const base = '/_matrix/client/v3/rooms/!room%3Aexample.com/call';

    const start = await callsRequest(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ callId: CALL_ID });

    const get1 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await callsRequest(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await callsRequest(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

});

describe('leftovers calls wrong methods after #159', () => {

  it('call GET start path returns 404', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db);
    const res = await callsRequest(createCallsEnv({ db }), '/_matrix/client/v3/rooms/!room%3Aexample.com/call/start', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('call PUT returns 404', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db);
    const res = await callsRequest(createCallsEnv({ db }), '/_matrix/client/v3/rooms/!room%3Aexample.com/call', { method: 'PUT' });
    expect(res.status).toBe(404);
  });

  it('call DELETE returns 404', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db);
    const res = await callsRequest(createCallsEnv({ db }), '/_matrix/client/v3/rooms/!room%3Aexample.com/call', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('call start DELETE returns 404', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db);
    const res = await callsRequest(createCallsEnv({ db }), '/_matrix/client/v3/rooms/!room%3Aexample.com/call/start', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('call end GET returns 404', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db);
    const res = await callsRequest(createCallsEnv({ db }), '/_matrix/client/v3/rooms/!room%3Aexample.com/call/end', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('call end PUT returns 404', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db);
    const res = await callsRequest(createCallsEnv({ db }), '/_matrix/client/v3/rooms/!room%3Aexample.com/call/end', { method: 'PUT' });
    expect(res.status).toBe(404);
  });

  it('ws POST returns 404', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db);
    const res = await callsRequest(createCallsEnv({ db }), '/calls/leftover-call-id16/ws', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('ws DELETE returns 404', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db);
    const res = await callsRequest(createCallsEnv({ db }), '/calls/leftover-call-id16/ws', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('ws PUT returns 404', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db);
    const res = await callsRequest(createCallsEnv({ db }), '/calls/leftover-call-id16/ws', { method: 'PUT' });
    expect(res.status).toBe(404);
  });

  it('ws PATCH returns 404', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db);
    const res = await callsRequest(createCallsEnv({ db }), '/calls/leftover-call-id16/ws', { method: 'PATCH' });
    expect(res.status).toBe(404);
  });

});

describe('leftovers cross-module lifecycle after #159', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('cross lifecycle soft-0', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    if (false) {
      turnMocks.getMatrixTurnCredentials.mockResolvedValue({
        username: 'u',
        password: 'p',
        uris: ['turn:turn.example.com:3478'],
        ttl: 3600,
      });
    }
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);

    const voipDb = createVoipDb({ memberships: [joinMember()] });
    const voipEnv = createVoipEnv({ db: voipDb });
    const turn = await voipRequest(voipEnv, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(turn.status).toBe(200);

    const transports = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(transports.status).toBe(200);
    expect((transports.body as { transports: unknown[] }).transports).toHaveLength(1);

    await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'cross-0' })
    );
    const voipCall = await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(voipCall.status).toBe(200);

    const callsDb = createCallsDb({ memberships: [joinMember()] });
    const callsEnv = createCallsEnv({ db: callsDb, callRoom: createCallRoomStub() });
    const start = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call/start',
      jsonInit('POST', {})
    );
    expect(start.status).toBe(200);
    const status = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status.body).toMatchObject({ active: true });
  });

  it('cross lifecycle soft-1', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    if (true) {
      turnMocks.getMatrixTurnCredentials.mockResolvedValue({
        username: 'u',
        password: 'p',
        uris: ['turn:turn.example.com:3478'],
        ttl: 3600,
      });
    }
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);

    const voipDb = createVoipDb({ memberships: [joinMember()] });
    const voipEnv = createVoipEnv({ db: voipDb });
    const turn = await voipRequest(voipEnv, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(turn.status).toBe(200);

    const transports = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(transports.status).toBe(200);
    expect((transports.body as { transports: unknown[] }).transports).toHaveLength(1);

    await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'cross-1' })
    );
    const voipCall = await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(voipCall.status).toBe(200);

    const callsDb = createCallsDb({ memberships: [joinMember()] });
    const callsEnv = createCallsEnv({ db: callsDb, callRoom: createCallRoomStub() });
    const start = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call/start',
      jsonInit('POST', {})
    );
    expect(start.status).toBe(200);
    const status = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status.body).toMatchObject({ active: true });
  });

  it('cross lifecycle soft-2', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    if (false) {
      turnMocks.getMatrixTurnCredentials.mockResolvedValue({
        username: 'u',
        password: 'p',
        uris: ['turn:turn.example.com:3478'],
        ttl: 3600,
      });
    }
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);

    const voipDb = createVoipDb({ memberships: [joinMember()] });
    const voipEnv = createVoipEnv({ db: voipDb });
    const turn = await voipRequest(voipEnv, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(turn.status).toBe(200);

    const transports = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(transports.status).toBe(200);
    expect((transports.body as { transports: unknown[] }).transports).toHaveLength(1);

    await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'cross-2' })
    );
    const voipCall = await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(voipCall.status).toBe(200);

    const callsDb = createCallsDb({ memberships: [joinMember()] });
    const callsEnv = createCallsEnv({ db: callsDb, callRoom: createCallRoomStub() });
    const start = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call/start',
      jsonInit('POST', {})
    );
    expect(start.status).toBe(200);
    const status = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status.body).toMatchObject({ active: true });
  });

  it('cross lifecycle soft-3', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    if (true) {
      turnMocks.getMatrixTurnCredentials.mockResolvedValue({
        username: 'u',
        password: 'p',
        uris: ['turn:turn.example.com:3478'],
        ttl: 3600,
      });
    }
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);

    const voipDb = createVoipDb({ memberships: [joinMember()] });
    const voipEnv = createVoipEnv({ db: voipDb });
    const turn = await voipRequest(voipEnv, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(turn.status).toBe(200);

    const transports = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(transports.status).toBe(200);
    expect((transports.body as { transports: unknown[] }).transports).toHaveLength(1);

    await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'cross-3' })
    );
    const voipCall = await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(voipCall.status).toBe(200);

    const callsDb = createCallsDb({ memberships: [joinMember()] });
    const callsEnv = createCallsEnv({ db: callsDb, callRoom: createCallRoomStub() });
    const start = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call/start',
      jsonInit('POST', {})
    );
    expect(start.status).toBe(200);
    const status = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status.body).toMatchObject({ active: true });
  });

  it('cross lifecycle soft-4', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    if (false) {
      turnMocks.getMatrixTurnCredentials.mockResolvedValue({
        username: 'u',
        password: 'p',
        uris: ['turn:turn.example.com:3478'],
        ttl: 3600,
      });
    }
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);

    const voipDb = createVoipDb({ memberships: [joinMember()] });
    const voipEnv = createVoipEnv({ db: voipDb });
    const turn = await voipRequest(voipEnv, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(turn.status).toBe(200);

    const transports = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(transports.status).toBe(200);
    expect((transports.body as { transports: unknown[] }).transports).toHaveLength(1);

    await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'cross-4' })
    );
    const voipCall = await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(voipCall.status).toBe(200);

    const callsDb = createCallsDb({ memberships: [joinMember()] });
    const callsEnv = createCallsEnv({ db: callsDb, callRoom: createCallRoomStub() });
    const start = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call/start',
      jsonInit('POST', {})
    );
    expect(start.status).toBe(200);
    const status = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status.body).toMatchObject({ active: true });
  });

  it('cross lifecycle soft-5', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    if (true) {
      turnMocks.getMatrixTurnCredentials.mockResolvedValue({
        username: 'u',
        password: 'p',
        uris: ['turn:turn.example.com:3478'],
        ttl: 3600,
      });
    }
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);

    const voipDb = createVoipDb({ memberships: [joinMember()] });
    const voipEnv = createVoipEnv({ db: voipDb });
    const turn = await voipRequest(voipEnv, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(turn.status).toBe(200);

    const transports = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(transports.status).toBe(200);
    expect((transports.body as { transports: unknown[] }).transports).toHaveLength(1);

    await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'cross-5' })
    );
    const voipCall = await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(voipCall.status).toBe(200);

    const callsDb = createCallsDb({ memberships: [joinMember()] });
    const callsEnv = createCallsEnv({ db: callsDb, callRoom: createCallRoomStub() });
    const start = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call/start',
      jsonInit('POST', {})
    );
    expect(start.status).toBe(200);
    const status = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status.body).toMatchObject({ active: true });
  });

  it('cross lifecycle soft-6', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    if (false) {
      turnMocks.getMatrixTurnCredentials.mockResolvedValue({
        username: 'u',
        password: 'p',
        uris: ['turn:turn.example.com:3478'],
        ttl: 3600,
      });
    }
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);

    const voipDb = createVoipDb({ memberships: [joinMember()] });
    const voipEnv = createVoipEnv({ db: voipDb });
    const turn = await voipRequest(voipEnv, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(turn.status).toBe(200);

    const transports = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(transports.status).toBe(200);
    expect((transports.body as { transports: unknown[] }).transports).toHaveLength(1);

    await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'cross-6' })
    );
    const voipCall = await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(voipCall.status).toBe(200);

    const callsDb = createCallsDb({ memberships: [joinMember()] });
    const callsEnv = createCallsEnv({ db: callsDb, callRoom: createCallRoomStub() });
    const start = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call/start',
      jsonInit('POST', {})
    );
    expect(start.status).toBe(200);
    const status = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status.body).toMatchObject({ active: true });
  });

  it('cross lifecycle soft-7', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    if (true) {
      turnMocks.getMatrixTurnCredentials.mockResolvedValue({
        username: 'u',
        password: 'p',
        uris: ['turn:turn.example.com:3478'],
        ttl: 3600,
      });
    }
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);

    const voipDb = createVoipDb({ memberships: [joinMember()] });
    const voipEnv = createVoipEnv({ db: voipDb });
    const turn = await voipRequest(voipEnv, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(turn.status).toBe(200);

    const transports = await rtcRequest(
      createRtcEnv(),
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(transports.status).toBe(200);
    expect((transports.body as { transports: unknown[] }).transports).toHaveLength(1);

    await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      jsonInit('PUT', { call_id: 'cross-7' })
    );
    const voipCall = await voipRequest(
      voipEnv,
      '/_matrix/client/v1/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(voipCall.status).toBe(200);

    const callsDb = createCallsDb({ memberships: [joinMember()] });
    const callsEnv = createCallsEnv({ db: callsDb, callRoom: createCallRoomStub() });
    const start = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call/start',
      jsonInit('POST', {})
    );
    expect(start.status).toBe(200);
    const status = await callsRequest(
      callsEnv,
      '/_matrix/client/v3/rooms/!room%3Aexample.com/call',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status.body).toMatchObject({ active: true });
  });

});
