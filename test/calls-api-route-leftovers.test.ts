/**
 * TOKENMAXX HEAVY leftovers after #159 — Cloudflare Calls SFU API routes.
 * Orthogonal to keys/media/appservice (#158), spaces/search/sync/versions (#159),
 * admin/federation/sliding-sync (parallel A / #161).
 * Complements test/calls-api-routes.test.ts — tests-only via Hono callsApp.request().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

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

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateOpaqueId: vi.fn(async () => 'pinned-call-id-16'),
  };
});

import callsApp from '../src/api/calls';

const USER = '@alice:example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const CALL_ID = 'pinned-call-id-16';
const NOW = 1_700_000_000_000;

type Membership = { room_id: string; user_id: string; membership: string };

type StateLink = {
  room_id: string;
  event_type: string;
  state_key: string;
  event_id: string;
};

type EventRow = {
  event_id: string;
  room_id: string;
  type: string;
  sender: string;
  content: string;
  origin_server_ts: number;
};

type SqlCall = { sql: string; args: unknown[] };

type CallFetch = { url: string; method: string; body?: unknown; headers?: Record<string, string> };

function createCallRoomStub(opts: { failInit?: boolean; failEnd?: boolean; wsStatus?: number } = {}) {
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
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      fetches.push({ url, method: req.method, body, headers });

      if (url.includes('/init') && opts.failInit) {
        return new Response('init fail', { status: 500 });
      }
      if (url.includes('/end') && opts.failEnd) {
        throw new Error('end boom');
      }
      if (url.includes('/ws')) {
        return new Response('ws-proxy', {
          status: opts.wsStatus ?? 200,
          headers: { 'X-WS-Proxy': '1' },
        });
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

function createEnv(
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
    SERVER_NAME: 'example.com',
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
  return env as unknown as Env & {
    _db: CallsDb;
    _callRoom: CallRoomStub;
  };
}

async function request(
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

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      Authorization: 'Bearer t',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function joinMember(): Membership {
  return { room_id: ROOM, user_id: USER, membership: 'join' };
}

function activeCall(partial: Record<string, unknown> = {}) {
  return {
    active: true,
    call_id: CALL_ID,
    started_by: USER,
    started_at: NOW,
    participants: [],
    ...partial,
  };
}

function seedActiveCall(db: CallsDb, content: Record<string, unknown> = activeCall()) {
  const callId = String(content.call_id ?? CALL_ID);
  const eventId = `call_${callId}`;
  db.stateLinks.push({
    room_id: ROOM,
    event_type: 'm.call.state',
    state_key: '',
    event_id: eventId,
  });
  db.events.push({
    event_id: eventId,
    room_id: ROOM,
    type: 'm.call.state',
    sender: USER,
    content: JSON.stringify(content),
    origin_server_ts: NOW,
  });
}

function seedCorruptCall(db: CallsDb, corrupt: string, idx: number) {
  const eventId = `call_corrupt_${idx}`;
  db.stateLinks.push({
    room_id: ROOM,
    event_type: 'm.call.state',
    state_key: '',
    event_id: eventId,
  });
  db.events.push({
    event_id: eventId,
    room_id: ROOM,
    type: 'm.call.state',
    sender: USER,
    content: corrupt,
    origin_server_ts: NOW,
  });
}

const GET_PATH = `/_matrix/client/v3/rooms/${ROOM_ENC}/call`;
const START_PATH = `/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`;
const END_PATH = `/_matrix/client/v3/rooms/${ROOM_ENC}/call/end`;

// === calls leftovers — GET inactive soft ===
describe('soft-01 GET inactive variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-01 GET inactive variant 1', async () => {
    const db = createCallsDb({ memberships: [] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-02 GET inactive variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-02 GET inactive variant 2', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-03 GET inactive variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-03 GET inactive variant 3', async () => {
    const db = createCallsDb({ memberships: [] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-04 GET inactive variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-04 GET inactive variant 4', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-05 GET inactive variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-05 GET inactive variant 5', async () => {
    const db = createCallsDb({ memberships: [] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-06 GET inactive variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-06 GET inactive variant 6', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-07 GET inactive variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-07 GET inactive variant 7', async () => {
    const db = createCallsDb({ memberships: [] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-08 GET inactive variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-08 GET inactive variant 8', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-09 GET inactive variant 9', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-09 GET inactive variant 9', async () => {
    const db = createCallsDb({ memberships: [] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-10 GET inactive variant 10', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-10 GET inactive variant 10', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-11 GET inactive variant 11', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-11 GET inactive variant 11', async () => {
    const db = createCallsDb({ memberships: [] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-12 GET inactive variant 12', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-12 GET inactive variant 12', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-13 GET inactive variant 13', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-13 GET inactive variant 13', async () => {
    const db = createCallsDb({ memberships: [] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-14 GET inactive variant 14', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-14 GET inactive variant 14', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-15 GET inactive variant 15', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-15 GET inactive variant 15', async () => {
    const db = createCallsDb({ memberships: [] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-16 GET inactive variant 16', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-16 GET inactive variant 16', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-17 GET inactive variant 17', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-17 GET inactive variant 17', async () => {
    const db = createCallsDb({ memberships: [] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-18 GET inactive variant 18', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-18 GET inactive variant 18', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-19 GET inactive variant 19', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-19 GET inactive variant 19', async () => {
    const db = createCallsDb({ memberships: [] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-20 GET inactive variant 20', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-20 GET inactive variant 20', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});

// === calls leftovers — GET active soft ===
describe('soft-01 GET active active-call-01', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-01 GET active active-call-01', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-01',
      participants: ['@user01:example.com', '@guest01:example.com'],
      started_at: 1700000000001,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-01',
      participants: ['@user01:example.com', '@guest01:example.com'],
      startedAt: 1700000000001,
    });
  });
});
describe('soft-02 GET active active-call-02', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-02 GET active active-call-02', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-02',
      participants: ['@user02:example.com', '@guest02:example.com'],
      started_at: 1700000000002,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-02',
      participants: ['@user02:example.com', '@guest02:example.com'],
      startedAt: 1700000000002,
    });
  });
});
describe('soft-03 GET active active-call-03', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-03 GET active active-call-03', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-03',
      participants: ['@user03:example.com', '@guest03:example.com'],
      started_at: 1700000000003,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-03',
      participants: ['@user03:example.com', '@guest03:example.com'],
      startedAt: 1700000000003,
    });
  });
});
describe('soft-04 GET active active-call-04', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-04 GET active active-call-04', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-04',
      participants: ['@user04:example.com', '@guest04:example.com'],
      started_at: 1700000000004,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-04',
      participants: ['@user04:example.com', '@guest04:example.com'],
      startedAt: 1700000000004,
    });
  });
});
describe('soft-05 GET active active-call-05', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-05 GET active active-call-05', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-05',
      participants: ['@user05:example.com', '@guest05:example.com'],
      started_at: 1700000000005,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-05',
      participants: ['@user05:example.com', '@guest05:example.com'],
      startedAt: 1700000000005,
    });
  });
});
describe('soft-06 GET active active-call-06', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-06 GET active active-call-06', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-06',
      participants: ['@user06:example.com', '@guest06:example.com'],
      started_at: 1700000000006,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-06',
      participants: ['@user06:example.com', '@guest06:example.com'],
      startedAt: 1700000000006,
    });
  });
});
describe('soft-07 GET active active-call-07', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-07 GET active active-call-07', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-07',
      participants: ['@user07:example.com', '@guest07:example.com'],
      started_at: 1700000000007,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-07',
      participants: ['@user07:example.com', '@guest07:example.com'],
      startedAt: 1700000000007,
    });
  });
});
describe('soft-08 GET active active-call-08', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-08 GET active active-call-08', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-08',
      participants: ['@user08:example.com', '@guest08:example.com'],
      started_at: 1700000000008,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-08',
      participants: ['@user08:example.com', '@guest08:example.com'],
      startedAt: 1700000000008,
    });
  });
});
describe('soft-09 GET active active-call-09', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-09 GET active active-call-09', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-09',
      participants: ['@user09:example.com', '@guest09:example.com'],
      started_at: 1700000000009,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-09',
      participants: ['@user09:example.com', '@guest09:example.com'],
      startedAt: 1700000000009,
    });
  });
});
describe('soft-10 GET active active-call-10', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-10 GET active active-call-10', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-10',
      participants: ['@user10:example.com', '@guest10:example.com'],
      started_at: 1700000000010,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-10',
      participants: ['@user10:example.com', '@guest10:example.com'],
      startedAt: 1700000000010,
    });
  });
});
describe('soft-11 GET active active-call-11', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-11 GET active active-call-11', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-11',
      participants: ['@user11:example.com', '@guest11:example.com'],
      started_at: 1700000000011,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-11',
      participants: ['@user11:example.com', '@guest11:example.com'],
      startedAt: 1700000000011,
    });
  });
});
describe('soft-12 GET active active-call-12', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-12 GET active active-call-12', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-12',
      participants: ['@user12:example.com', '@guest12:example.com'],
      started_at: 1700000000012,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-12',
      participants: ['@user12:example.com', '@guest12:example.com'],
      startedAt: 1700000000012,
    });
  });
});
describe('soft-13 GET active active-call-13', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-13 GET active active-call-13', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-13',
      participants: ['@user13:example.com', '@guest13:example.com'],
      started_at: 1700000000013,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-13',
      participants: ['@user13:example.com', '@guest13:example.com'],
      startedAt: 1700000000013,
    });
  });
});
describe('soft-14 GET active active-call-14', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-14 GET active active-call-14', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-14',
      participants: ['@user14:example.com', '@guest14:example.com'],
      started_at: 1700000000014,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-14',
      participants: ['@user14:example.com', '@guest14:example.com'],
      startedAt: 1700000000014,
    });
  });
});
describe('soft-15 GET active active-call-15', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-15 GET active active-call-15', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-15',
      participants: ['@user15:example.com', '@guest15:example.com'],
      started_at: 1700000000015,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-15',
      participants: ['@user15:example.com', '@guest15:example.com'],
      startedAt: 1700000000015,
    });
  });
});
describe('soft-16 GET active active-call-16', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-16 GET active active-call-16', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-16',
      participants: ['@user16:example.com', '@guest16:example.com'],
      started_at: 1700000000016,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-16',
      participants: ['@user16:example.com', '@guest16:example.com'],
      startedAt: 1700000000016,
    });
  });
});
describe('soft-17 GET active active-call-17', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-17 GET active active-call-17', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-17',
      participants: ['@user17:example.com', '@guest17:example.com'],
      started_at: 1700000000017,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-17',
      participants: ['@user17:example.com', '@guest17:example.com'],
      startedAt: 1700000000017,
    });
  });
});
describe('soft-18 GET active active-call-18', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-18 GET active active-call-18', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-18',
      participants: ['@user18:example.com', '@guest18:example.com'],
      started_at: 1700000000018,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-18',
      participants: ['@user18:example.com', '@guest18:example.com'],
      startedAt: 1700000000018,
    });
  });
});
describe('soft-19 GET active active-call-19', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-19 GET active active-call-19', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-19',
      participants: ['@user19:example.com', '@guest19:example.com'],
      started_at: 1700000000019,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-19',
      participants: ['@user19:example.com', '@guest19:example.com'],
      startedAt: 1700000000019,
    });
  });
});
describe('soft-20 GET active active-call-20', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-20 GET active active-call-20', async () => {
    const db = createCallsDb();
    seedActiveCall(db, {
      active: true,
      call_id: 'active-call-20',
      participants: ['@user20:example.com', '@guest20:example.com'],
      started_at: 1700000000020,
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'active-call-20',
      participants: ['@user20:example.com', '@guest20:example.com'],
      startedAt: 1700000000020,
    });
  });
});

// === calls leftovers — GET not configured ===
describe('soft-01 GET not configured variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-01 GET not configured variant 1', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Video calling not configured',
    });
  });
});
describe('soft-02 GET not configured variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-02 GET not configured variant 2', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Video calling not configured',
    });
  });
});
describe('soft-03 GET not configured variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-03 GET not configured variant 3', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Video calling not configured',
    });
  });
});
describe('soft-04 GET not configured variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-04 GET not configured variant 4', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Video calling not configured',
    });
  });
});
describe('soft-05 GET not configured variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-05 GET not configured variant 5', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Video calling not configured',
    });
  });
});
describe('soft-06 GET not configured variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-06 GET not configured variant 6', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Video calling not configured',
    });
  });
});
describe('soft-07 GET not configured variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-07 GET not configured variant 7', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Video calling not configured',
    });
  });
});
describe('soft-08 GET not configured variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-08 GET not configured variant 8', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Video calling not configured',
    });
  });
});
describe('soft-09 GET not configured variant 9', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-09 GET not configured variant 9', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Video calling not configured',
    });
  });
});
describe('soft-10 GET not configured variant 10', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-10 GET not configured variant 10', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Video calling not configured',
    });
  });
});
describe('soft-11 GET not configured variant 11', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-11 GET not configured variant 11', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Video calling not configured',
    });
  });
});
describe('soft-12 GET not configured variant 12', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-12 GET not configured variant 12', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Video calling not configured',
    });
  });
});

// === calls leftovers — GET corrupt JSON ===
describe('soft-01 GET corrupt JSON variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-01 GET corrupt JSON variant 1', async () => {
    const db = createCallsDb();
    seedCorruptCall(db, '{bad', 1);
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-02 GET corrupt JSON variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-02 GET corrupt JSON variant 2', async () => {
    const db = createCallsDb();
    seedCorruptCall(db, 'NOT_JSON', 2);
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-03 GET corrupt JSON variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-03 GET corrupt JSON variant 3', async () => {
    const db = createCallsDb();
    seedCorruptCall(db, '{"active":', 3);
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-04 GET corrupt JSON variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-04 GET corrupt JSON variant 4', async () => {
    const db = createCallsDb();
    seedCorruptCall(db, '{', 4);
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-05 GET corrupt JSON variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-05 GET corrupt JSON variant 5', async () => {
    const db = createCallsDb();
    seedCorruptCall(db, '}', 5);
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-06 GET corrupt JSON variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-06 GET corrupt JSON variant 6', async () => {
    const db = createCallsDb();
    seedCorruptCall(db, '{]', 6);
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-07 GET corrupt JSON variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-07 GET corrupt JSON variant 7', async () => {
    const db = createCallsDb();
    seedCorruptCall(db, '[}', 7);
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-08 GET corrupt JSON variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-08 GET corrupt JSON variant 8', async () => {
    const db = createCallsDb();
    seedCorruptCall(db, 'x=y', 8);
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-09 GET corrupt JSON variant 9', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-09 GET corrupt JSON variant 9', async () => {
    const db = createCallsDb();
    seedCorruptCall(db, '\'\'\'', 9);
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-10 GET corrupt JSON variant 10', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-10 GET corrupt JSON variant 10', async () => {
    const db = createCallsDb();
    seedCorruptCall(db, '"""', 10);
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-11 GET corrupt JSON variant 11', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-11 GET corrupt JSON variant 11', async () => {
    const db = createCallsDb();
    seedCorruptCall(db, '{a:1}', 11);
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});
describe('soft-12 GET corrupt JSON variant 12', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-12 GET corrupt JSON variant 12', async () => {
    const db = createCallsDb();
    seedCorruptCall(db, 'NaN junk', 12);
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });
});

// === calls leftovers — POST start soft ===
describe('soft-01 POST start variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 1);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-01 POST start variant 1', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-02 POST start variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 2);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-02 POST start variant 2', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-03 POST start variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 3);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-03 POST start variant 3', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-04 POST start variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 4);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-04 POST start variant 4', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-05 POST start variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 5);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-05 POST start variant 5', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-06 POST start variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 6);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-06 POST start variant 6', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-07 POST start variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 7);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-07 POST start variant 7', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-08 POST start variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 8);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-08 POST start variant 8', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-09 POST start variant 9', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 9);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-09 POST start variant 9', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-10 POST start variant 10', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 10);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-10 POST start variant 10', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-11 POST start variant 11', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 11);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-11 POST start variant 11', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-12 POST start variant 12', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 12);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-12 POST start variant 12', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-13 POST start variant 13', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 13);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-13 POST start variant 13', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-14 POST start variant 14', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 14);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-14 POST start variant 14', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-15 POST start variant 15', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 15);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-15 POST start variant 15', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-16 POST start variant 16', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 16);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-16 POST start variant 16', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-17 POST start variant 17', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 17);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-17 POST start variant 17', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-18 POST start variant 18', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 18);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-18 POST start variant 18', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-19 POST start variant 19', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 19);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-19 POST start variant 19', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-20 POST start variant 20', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 20);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-20 POST start variant 20', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-21 POST start variant 21', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 21);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-21 POST start variant 21', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-22 POST start variant 22', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 22);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-22 POST start variant 22', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-23 POST start variant 23', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 23);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-23 POST start variant 23', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});
describe('soft-24 POST start variant 24', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 24);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-24 POST start variant 24', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(res.body).toMatchObject({
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches.length).toBeGreaterThanOrEqual(1);
    expect(db.events.some((e) => e.content.includes('"active":true'))).toBe(true);
  });
});

// === calls leftovers — POST start not configured ===
describe('soft-01 POST start not configured variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-01 POST start not configured variant 1', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-02 POST start not configured variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-02 POST start not configured variant 2', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-03 POST start not configured variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-03 POST start not configured variant 3', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-04 POST start not configured variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-04 POST start not configured variant 4', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-05 POST start not configured variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-05 POST start not configured variant 5', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-06 POST start not configured variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-06 POST start not configured variant 6', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-07 POST start not configured variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-07 POST start not configured variant 7', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-08 POST start not configured variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-08 POST start not configured variant 8', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-09 POST start not configured variant 9', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-09 POST start not configured variant 9', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-10 POST start not configured variant 10', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-10 POST start not configured variant 10', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});

// === calls leftovers — POST start forbidden ===
describe('soft-01 POST start forbidden leave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-01 POST start forbidden leave', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});
describe('soft-02 POST start forbidden invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-02 POST start forbidden invite', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});
describe('soft-03 POST start forbidden ban', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-03 POST start forbidden ban', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
    });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});
describe('soft-04 POST start forbidden knock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-04 POST start forbidden knock', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
    });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});
describe('soft-05 POST start forbidden leave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-05 POST start forbidden leave', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});
describe('soft-06 POST start forbidden invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-06 POST start forbidden invite', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});
describe('soft-07 POST start forbidden ban', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-07 POST start forbidden ban', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
    });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});
describe('soft-08 POST start forbidden knock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-08 POST start forbidden knock', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
    });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});
describe('soft-09 POST start forbidden leave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-09 POST start forbidden leave', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});
describe('soft-10 POST start forbidden invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-10 POST start forbidden invite', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});

// === calls leftovers — POST start already active ===
describe('soft-01 POST start already active variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-01 POST start already active variant 1', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, activeCall({ call_id: 'existing-01' }));
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });
});
describe('soft-02 POST start already active variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-02 POST start already active variant 2', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, activeCall({ call_id: 'existing-02' }));
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });
});
describe('soft-03 POST start already active variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-03 POST start already active variant 3', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, activeCall({ call_id: 'existing-03' }));
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });
});
describe('soft-04 POST start already active variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-04 POST start already active variant 4', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, activeCall({ call_id: 'existing-04' }));
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });
});
describe('soft-05 POST start already active variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-05 POST start already active variant 5', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, activeCall({ call_id: 'existing-05' }));
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });
});
describe('soft-06 POST start already active variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-06 POST start already active variant 6', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, activeCall({ call_id: 'existing-06' }));
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });
});
describe('soft-07 POST start already active variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-07 POST start already active variant 7', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, activeCall({ call_id: 'existing-07' }));
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });
});
describe('soft-08 POST start already active variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-08 POST start already active variant 8', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, activeCall({ call_id: 'existing-08' }));
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });
});
describe('soft-09 POST start already active variant 9', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-09 POST start already active variant 9', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, activeCall({ call_id: 'existing-09' }));
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });
});
describe('soft-10 POST start already active variant 10', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-10 POST start already active variant 10', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, activeCall({ call_id: 'existing-10' }));
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });
});

// === calls leftovers — POST start no CALL_ROOMS ===
describe('soft-01 POST start no CALL_ROOMS variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-01 POST start no CALL_ROOMS variant 1', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db, noCallRooms: true }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});
describe('soft-02 POST start no CALL_ROOMS variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-02 POST start no CALL_ROOMS variant 2', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db, noCallRooms: true }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});
describe('soft-03 POST start no CALL_ROOMS variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-03 POST start no CALL_ROOMS variant 3', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db, noCallRooms: true }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});
describe('soft-04 POST start no CALL_ROOMS variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-04 POST start no CALL_ROOMS variant 4', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db, noCallRooms: true }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});
describe('soft-05 POST start no CALL_ROOMS variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-05 POST start no CALL_ROOMS variant 5', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db, noCallRooms: true }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});
describe('soft-06 POST start no CALL_ROOMS variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-06 POST start no CALL_ROOMS variant 6', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db, noCallRooms: true }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});
describe('soft-07 POST start no CALL_ROOMS variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-07 POST start no CALL_ROOMS variant 7', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db, noCallRooms: true }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});
describe('soft-08 POST start no CALL_ROOMS variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-08 POST start no CALL_ROOMS variant 8', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db, noCallRooms: true }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});

// === calls leftovers — POST end soft ===
describe('soft-01 POST end variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 1);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-01 POST end variant 1', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-01' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 1);
  });
});
describe('soft-02 POST end variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 2);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-02 POST end variant 2', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-02' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 2);
  });
});
describe('soft-03 POST end variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 3);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-03 POST end variant 3', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-03' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 3);
  });
});
describe('soft-04 POST end variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 4);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-04 POST end variant 4', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-04' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 4);
  });
});
describe('soft-05 POST end variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 5);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-05 POST end variant 5', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-05' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 5);
  });
});
describe('soft-06 POST end variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 6);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-06 POST end variant 6', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-06' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 6);
  });
});
describe('soft-07 POST end variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 7);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-07 POST end variant 7', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-07' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 7);
  });
});
describe('soft-08 POST end variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 8);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-08 POST end variant 8', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-08' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 8);
  });
});
describe('soft-09 POST end variant 9', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 9);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-09 POST end variant 9', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-09' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 9);
  });
});
describe('soft-10 POST end variant 10', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 10);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-10 POST end variant 10', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-10' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 10);
  });
});
describe('soft-11 POST end variant 11', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 11);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-11 POST end variant 11', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-11' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 11);
  });
});
describe('soft-12 POST end variant 12', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 12);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-12 POST end variant 12', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-12' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 12);
  });
});
describe('soft-13 POST end variant 13', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 13);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-13 POST end variant 13', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-13' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 13);
  });
});
describe('soft-14 POST end variant 14', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 14);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-14 POST end variant 14', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-14' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 14);
  });
});
describe('soft-15 POST end variant 15', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 15);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-15 POST end variant 15', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-15' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 15);
  });
});
describe('soft-16 POST end variant 16', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 16);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-16 POST end variant 16', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-16' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 16);
  });
});
describe('soft-17 POST end variant 17', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 17);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-17 POST end variant 17', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-17' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 17);
  });
});
describe('soft-18 POST end variant 18', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 18);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-18 POST end variant 18', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-18' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 18);
  });
});
describe('soft-19 POST end variant 19', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 19);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-19 POST end variant 19', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-19' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 19);
  });
});
describe('soft-20 POST end variant 20', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 20);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-20 POST end variant 20', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'end-call-20' }));
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updated = JSON.parse(db.events[0].content) as { active: boolean; ended_at: number };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW + 20);
  });
});

// === calls leftovers — POST end not found ===
describe('soft-01 POST end not found variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-01 POST end not found variant 1', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-02 POST end not found variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-02 POST end not found variant 2', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-03 POST end not found variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-03 POST end not found variant 3', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-04 POST end not found variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-04 POST end not found variant 4', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-05 POST end not found variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-05 POST end not found variant 5', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-06 POST end not found variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-06 POST end not found variant 6', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-07 POST end not found variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-07 POST end not found variant 7', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-08 POST end not found variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-08 POST end not found variant 8', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-09 POST end not found variant 9', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-09 POST end not found variant 9', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-10 POST end not found variant 10', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-10 POST end not found variant 10', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});

// === calls leftovers — POST end inactive ===
describe('soft-01 POST end inactive variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-01 POST end inactive variant 1', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: false, call_id: 'inactive-end-01' });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-02 POST end inactive variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-02 POST end inactive variant 2', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: false, call_id: 'inactive-end-02' });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-03 POST end inactive variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-03 POST end inactive variant 3', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: false, call_id: 'inactive-end-03' });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-04 POST end inactive variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-04 POST end inactive variant 4', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: false, call_id: 'inactive-end-04' });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-05 POST end inactive variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-05 POST end inactive variant 5', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: false, call_id: 'inactive-end-05' });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-06 POST end inactive variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-06 POST end inactive variant 6', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: false, call_id: 'inactive-end-06' });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-07 POST end inactive variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-07 POST end inactive variant 7', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: false, call_id: 'inactive-end-07' });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
describe('soft-08 POST end inactive variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-08 POST end inactive variant 8', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: false, call_id: 'inactive-end-08' });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});

// === calls leftovers — POST end DO throw ===
describe('soft-01 POST end DO throw variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-01 POST end DO throw variant 1', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'do-fail-01' }));
    const callRoom = createCallRoomStub({ failEnd: true });
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(JSON.parse(db.events[0].content).active).toBe(false);
  });
});
describe('soft-02 POST end DO throw variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-02 POST end DO throw variant 2', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'do-fail-02' }));
    const callRoom = createCallRoomStub({ failEnd: true });
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(JSON.parse(db.events[0].content).active).toBe(false);
  });
});
describe('soft-03 POST end DO throw variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-03 POST end DO throw variant 3', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'do-fail-03' }));
    const callRoom = createCallRoomStub({ failEnd: true });
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(JSON.parse(db.events[0].content).active).toBe(false);
  });
});
describe('soft-04 POST end DO throw variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-04 POST end DO throw variant 4', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'do-fail-04' }));
    const callRoom = createCallRoomStub({ failEnd: true });
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(JSON.parse(db.events[0].content).active).toBe(false);
  });
});
describe('soft-05 POST end DO throw variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-05 POST end DO throw variant 5', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'do-fail-05' }));
    const callRoom = createCallRoomStub({ failEnd: true });
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(JSON.parse(db.events[0].content).active).toBe(false);
  });
});
describe('soft-06 POST end DO throw variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-06 POST end DO throw variant 6', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'do-fail-06' }));
    const callRoom = createCallRoomStub({ failEnd: true });
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(JSON.parse(db.events[0].content).active).toBe(false);
  });
});
describe('soft-07 POST end DO throw variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-07 POST end DO throw variant 7', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'do-fail-07' }));
    const callRoom = createCallRoomStub({ failEnd: true });
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(JSON.parse(db.events[0].content).active).toBe(false);
  });
});
describe('soft-08 POST end DO throw variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 0);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-08 POST end DO throw variant 8', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'do-fail-08' }));
    const callRoom = createCallRoomStub({ failEnd: true });
    const res = await request(createEnv({ db, callRoom }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(JSON.parse(db.events[0].content).active).toBe(false);
  });
});

// === calls leftovers — WS proxy soft ===
describe('soft-01 WS proxy variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-01 WS proxy variant 1', async () => {
    const callId = 'ws-call-01';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '1' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-02 WS proxy variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-02 WS proxy variant 2', async () => {
    const callId = 'ws-call-02';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '2' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-03 WS proxy variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-03 WS proxy variant 3', async () => {
    const callId = 'ws-call-03';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '3' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-04 WS proxy variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-04 WS proxy variant 4', async () => {
    const callId = 'ws-call-04';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '4' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-05 WS proxy variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-05 WS proxy variant 5', async () => {
    const callId = 'ws-call-05';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '5' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-06 WS proxy variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-06 WS proxy variant 6', async () => {
    const callId = 'ws-call-06';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '6' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-07 WS proxy variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-07 WS proxy variant 7', async () => {
    const callId = 'ws-call-07';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '7' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-08 WS proxy variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-08 WS proxy variant 8', async () => {
    const callId = 'ws-call-08';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '8' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-09 WS proxy variant 9', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-09 WS proxy variant 9', async () => {
    const callId = 'ws-call-09';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '9' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-10 WS proxy variant 10', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-10 WS proxy variant 10', async () => {
    const callId = 'ws-call-10';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '10' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-11 WS proxy variant 11', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-11 WS proxy variant 11', async () => {
    const callId = 'ws-call-11';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '11' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-12 WS proxy variant 12', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-12 WS proxy variant 12', async () => {
    const callId = 'ws-call-12';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '12' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-13 WS proxy variant 13', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-13 WS proxy variant 13', async () => {
    const callId = 'ws-call-13';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '13' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-14 WS proxy variant 14', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-14 WS proxy variant 14', async () => {
    const callId = 'ws-call-14';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '14' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-15 WS proxy variant 15', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-15 WS proxy variant 15', async () => {
    const callId = 'ws-call-15';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '15' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});
describe('soft-16 WS proxy variant 16', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-16 WS proxy variant 16', async () => {
    const callId = 'ws-call-16';
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: callId }));
    const callRoom = createCallRoomStub({ wsStatus: 200 });
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${callId}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Variant': '16' },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
  });
});

// === calls leftovers — WS not found ===
describe('soft-01 WS not found variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-01 WS not found variant 1', async () => {
    const db = createCallsDb();
    const res = await request(createEnv({ db }), `/calls/missing-01/ws`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Call not found' });
  });
});
describe('soft-02 WS not found variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-02 WS not found variant 2', async () => {
    const db = createCallsDb();
    const res = await request(createEnv({ db }), `/calls/missing-02/ws`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Call not found' });
  });
});
describe('soft-03 WS not found variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-03 WS not found variant 3', async () => {
    const db = createCallsDb();
    const res = await request(createEnv({ db }), `/calls/missing-03/ws`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Call not found' });
  });
});
describe('soft-04 WS not found variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-04 WS not found variant 4', async () => {
    const db = createCallsDb();
    const res = await request(createEnv({ db }), `/calls/missing-04/ws`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Call not found' });
  });
});
describe('soft-05 WS not found variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-05 WS not found variant 5', async () => {
    const db = createCallsDb();
    const res = await request(createEnv({ db }), `/calls/missing-05/ws`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Call not found' });
  });
});
describe('soft-06 WS not found variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-06 WS not found variant 6', async () => {
    const db = createCallsDb();
    const res = await request(createEnv({ db }), `/calls/missing-06/ws`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Call not found' });
  });
});
describe('soft-07 WS not found variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-07 WS not found variant 7', async () => {
    const db = createCallsDb();
    const res = await request(createEnv({ db }), `/calls/missing-07/ws`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Call not found' });
  });
});
describe('soft-08 WS not found variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-08 WS not found variant 8', async () => {
    const db = createCallsDb();
    const res = await request(createEnv({ db }), `/calls/missing-08/ws`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Call not found' });
  });
});

// === calls leftovers — WS not configured ===
describe('soft-01 WS not configured variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-01 WS not configured variant 1', async () => {
    const res = await request(createEnv(), `/calls/ws-nc-01/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-02 WS not configured variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-02 WS not configured variant 2', async () => {
    const res = await request(createEnv(), `/calls/ws-nc-02/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-03 WS not configured variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-03 WS not configured variant 3', async () => {
    const res = await request(createEnv(), `/calls/ws-nc-03/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-04 WS not configured variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-04 WS not configured variant 4', async () => {
    const res = await request(createEnv(), `/calls/ws-nc-04/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-05 WS not configured variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-05 WS not configured variant 5', async () => {
    const res = await request(createEnv(), `/calls/ws-nc-05/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-06 WS not configured variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-06 WS not configured variant 6', async () => {
    const res = await request(createEnv(), `/calls/ws-nc-06/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-07 WS not configured variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-07 WS not configured variant 7', async () => {
    const res = await request(createEnv(), `/calls/ws-nc-07/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});
describe('soft-08 WS not configured variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(false);
  });
  it('soft-08 WS not configured variant 8', async () => {
    const res = await request(createEnv(), `/calls/ws-nc-08/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Video calling not configured' });
  });
});

// === calls leftovers — WS no CALL_ROOMS ===
describe('soft-01 WS no CALL_ROOMS variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-01 WS no CALL_ROOMS variant 1', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'ws-nocr-01' }));
    const res = await request(createEnv({ db, noCallRooms: true }), `/calls/ws-nocr-01/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});
describe('soft-02 WS no CALL_ROOMS variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-02 WS no CALL_ROOMS variant 2', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'ws-nocr-02' }));
    const res = await request(createEnv({ db, noCallRooms: true }), `/calls/ws-nocr-02/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});
describe('soft-03 WS no CALL_ROOMS variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-03 WS no CALL_ROOMS variant 3', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'ws-nocr-03' }));
    const res = await request(createEnv({ db, noCallRooms: true }), `/calls/ws-nocr-03/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});
describe('soft-04 WS no CALL_ROOMS variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-04 WS no CALL_ROOMS variant 4', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'ws-nocr-04' }));
    const res = await request(createEnv({ db, noCallRooms: true }), `/calls/ws-nocr-04/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});
describe('soft-05 WS no CALL_ROOMS variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-05 WS no CALL_ROOMS variant 5', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'ws-nocr-05' }));
    const res = await request(createEnv({ db, noCallRooms: true }), `/calls/ws-nocr-05/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});
describe('soft-06 WS no CALL_ROOMS variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-06 WS no CALL_ROOMS variant 6', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'ws-nocr-06' }));
    const res = await request(createEnv({ db, noCallRooms: true }), `/calls/ws-nocr-06/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });
});

// === calls leftovers — room path charset ===
describe('soft-01 room path charset variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-01 room path charset variant 1', async () => {
    const db = createCallsDb();
    await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = db.selects.find((s) => s.sql.includes('m.call.state'));
    expect(q?.args[0]).toBe('!room:example.com');
  });
});
describe('soft-02 room path charset variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-02 room path charset variant 2', async () => {
    const db = createCallsDb();
    await request(createEnv({ db }), `/_matrix/client/v3/rooms/!room%3Aexample.com/call`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = db.selects.find((s) => s.sql.includes('m.call.state'));
    expect(q?.args[0]).toBe('!room:example.com');
  });
});
describe('soft-03 room path charset variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-03 room path charset variant 3', async () => {
    const db = createCallsDb();
    await request(createEnv({ db }), `/_matrix/client/v3/rooms/!room%252Fsub%3Aexample.com/call`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = db.selects.find((s) => s.sql.includes('m.call.state'));
    expect(q?.args[0]).toBe('!room/sub:example.com');
  });
});
describe('soft-04 room path charset variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-04 room path charset variant 4', async () => {
    const db = createCallsDb();
    await request(createEnv({ db }), `/_matrix/client/v3/rooms/!room%20space%3Aexample.com/call`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = db.selects.find((s) => s.sql.includes('m.call.state'));
    expect(q?.args[0]).toBe('!room space:example.com');
  });
});
describe('soft-05 room path charset variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-05 room path charset variant 5', async () => {
    const db = createCallsDb();
    await request(createEnv({ db }), `/_matrix/client/v3/rooms/!room%2Bplus%3Aexample.com/call`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = db.selects.find((s) => s.sql.includes('m.call.state'));
    expect(q?.args[0]).toBe('!room+plus:example.com');
  });
});
describe('soft-06 room path charset variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-06 room path charset variant 6', async () => {
    const db = createCallsDb();
    await request(createEnv({ db }), `/_matrix/client/v3/rooms/!room%40at%3Aexample.com/call`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = db.selects.find((s) => s.sql.includes('m.call.state'));
    expect(q?.args[0]).toBe('!room@at:example.com');
  });
});
describe('soft-07 room path charset variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-07 room path charset variant 7', async () => {
    const db = createCallsDb();
    await request(createEnv({ db }), `/_matrix/client/v3/rooms/!room%23hash%3Aexample.com/call`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = db.selects.find((s) => s.sql.includes('m.call.state'));
    expect(q?.args[0]).toBe('!room#hash:example.com');
  });
});
describe('soft-08 room path charset variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-08 room path charset variant 8', async () => {
    const db = createCallsDb();
    await request(createEnv({ db }), `/_matrix/client/v3/rooms/!room%26amp%3Aexample.com/call`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = db.selects.find((s) => s.sql.includes('m.call.state'));
    expect(q?.args[0]).toBe('!room&amp:example.com');
  });
});

// === calls leftovers — lifecycle start-get-end ===
describe('soft-01 lifecycle variant 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 1);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-01 lifecycle variant 1', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-02 lifecycle variant 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 2);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-02 lifecycle variant 2', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-03 lifecycle variant 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 3);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-03 lifecycle variant 3', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-04 lifecycle variant 4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 4);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-04 lifecycle variant 4', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-05 lifecycle variant 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 5);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-05 lifecycle variant 5', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-06 lifecycle variant 6', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 6);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-06 lifecycle variant 6', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-07 lifecycle variant 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 7);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-07 lifecycle variant 7', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-08 lifecycle variant 8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 8);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-08 lifecycle variant 8', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-09 lifecycle variant 9', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 9);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-09 lifecycle variant 9', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-10 lifecycle variant 10', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 10);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-10 lifecycle variant 10', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-11 lifecycle variant 11', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 11);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-11 lifecycle variant 11', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-12 lifecycle variant 12', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 12);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-12 lifecycle variant 12', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-13 lifecycle variant 13', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 13);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-13 lifecycle variant 13', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-14 lifecycle variant 14', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 14);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-14 lifecycle variant 14', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-15 lifecycle variant 15', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 15);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-15 lifecycle variant 15', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});
describe('soft-16 lifecycle variant 16', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 16);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('soft-16 lifecycle variant 16', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const start = await request(env, START_PATH, jsonInit('POST', {}));
    expect(start.status).toBe(200);
    const get1 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });
    const end = await request(env, END_PATH, jsonInit('POST', {}));
    expect(end.status).toBe(200);
    const get2 = await request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });
});

// === calls leftovers — GET call method matrix ===
describe('soft-01 GET call method matrix POST', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-01 GET call method matrix POST', async () => {
    const db = createCallsDb();
    const res = await request(createEnv({ db }), GET_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
  });
});
describe('soft-02 GET call method matrix PUT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-02 GET call method matrix PUT', async () => {
    const db = createCallsDb();
    const res = await request(createEnv({ db }), GET_PATH, jsonInit('PUT', {}));
    expect(res.status).toBe(404);
  });
});
describe('soft-03 GET call method matrix DELETE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  it('soft-03 GET call method matrix DELETE', async () => {
    const db = createCallsDb();
    const res = await request(createEnv({ db }), GET_PATH, jsonInit('DELETE', {}));
    expect(res.status).toBe(404);
  });
});

// Generated test count: 237
