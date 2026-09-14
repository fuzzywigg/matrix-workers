/**
 * TOKENMAXX HEAVY leftovers after #226 — Cloudflare Calls SFU Matrix routes.
 * Complements test/calls-api-routes.test.ts + test/calls-api-route-leftovers.test.ts
 * (soft floods) and voip-rtc-calls-concurrent-race (dual cold start / start∥end).
 *
 * This slice: unused failInit stub, dangling room_state without event row,
 * truthy/falsy active JSON, membership case/empty, init throw vs 500-continue,
 * WS type filter, header forward, ON CONFLICT restart after inactive.
 *
 * Tests-only via Hono callsApp.request(). Fixtures use example.com only.
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
const GET_PATH = `/_matrix/client/v3/rooms/${ROOM_ENC}/call`;
const START_PATH = `${GET_PATH}/start`;
const END_PATH = `${GET_PATH}/end`;

type Membership = { room_id: string; user_id: string; membership: string };
type StateLink = { room_id: string; event_type: string; state_key: string; event_id: string };
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

function createCallRoomStub(
  opts: { failInit?: boolean; throwInit?: boolean; failEnd?: boolean; wsStatus?: number } = {}
) {
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

      if (url.includes('/init') && opts.throwInit) {
        throw new Error('init boom');
      }
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

function createCallsDb(
  opts: { memberships?: Membership[]; stateLinks?: StateLink[]; events?: EventRow[] } = {}
) {
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
                const row = memberships.find((m) => m.room_id === roomId && m.user_id === userId);
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
                return (ev ? { room_id: ev.room_id, content: ev.content } : null) as T;
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
                    s.room_id === roomId && s.event_type === 'm.call.state' && s.state_key === ''
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
  opts: { db?: CallsDb; callRoom?: CallRoomStub; noCallRooms?: boolean; serverName?: string } = {}
) {
  const db = opts.db ?? createCallsDb();
  const callRoom = opts.callRoom ?? createCallRoomStub();
  const env: Record<string, unknown> = {
    DB: db as unknown as D1Database,
    SERVER_NAME: opts.serverName ?? 'example.com',
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

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
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
  return { status: res.status, body, text, headers: res.headers };
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
  const eventId = `call_${content.call_id ?? CALL_ID}`;
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

describe('calls leftovers deepen after #226 — failInit / dangling state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('GET returns active:false when room_state link exists but event row is missing', async () => {
    const db = createCallsDb();
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: 'call_orphan',
    });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('POST start proceeds when dangling state link has no event (treated as no existing call)', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: 'call_orphan',
    });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
  });

  it('POST end 404 when dangling state link has no event', async () => {
    const db = createCallsDb();
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: 'call_orphan',
    });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('POST start continues when DO /init returns 500 (status is not checked)', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub({ failInit: true });
    const res = await request(createEnv({ db, callRoom }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
    expect(callRoom.fetches[0].url).toBe('http://internal/init');
    expect(db.events).toHaveLength(1);
  });

  it('POST start returns Hono 500 when DO /init throws (no state written)', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub({ throwInit: true });
    const res = await request(createEnv({ db, callRoom }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.text).toBe('Internal Server Error');
    expect(db.events).toHaveLength(0);
    expect(db.stateLinks).toHaveLength(0);
  });
});

describe('calls leftovers deepen after #226 — JSON active / participants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });

  it('GET does not coerce numeric active:1 to boolean (content.active || false)', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: 1, call_id: 'c-num', participants: ['@bob:example.com'] });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toEqual({
      active: 1,
      callId: 'c-num',
      participants: ['@bob:example.com'],
      startedAt: undefined,
    });
  });

  it('GET treats active:0 as falsy false but still returns callId', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: 0, call_id: 'c-zero' });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toEqual({
      active: false,
      callId: 'c-zero',
      participants: [],
      startedAt: undefined,
    });
  });

  it('GET treats participants:null as [] via || default', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: true, call_id: 'c-null', participants: null });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toMatchObject({ participants: [] });
  });

  it('GET pins startedAt:0 (zero is kept, not defaulted)', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: true, call_id: 'c-ts0', started_at: 0 });
    const res = await request(createEnv({ db }), GET_PATH, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toMatchObject({ startedAt: 0 });
  });

  it('POST end treats active:1 as truthy and ends the call', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: 1, call_id: CALL_ID });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(JSON.parse(db.events[0].content).active).toBe(false);
  });

  it('POST end 404 when active is empty string (falsy)', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: '', call_id: CALL_ID });
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
  });

  it('POST start treats existing active:1 as already active', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, { active: 1, call_id: 'existing' });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });
});

describe('calls leftovers deepen after #226 — membership / ws / restart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('POST start forbids empty-string membership (not === join)', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: '' }],
    });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(403);
  });

  it('POST start forbids JOIN (case-sensitive, must be join)', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'JOIN' }],
    });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(403);
  });

  it('WS 404 when event_id matches but type is not m.call.state', async () => {
    const db = createCallsDb();
    db.events.push({
      event_id: `call_${CALL_ID}`,
      room_id: ROOM,
      type: 'm.room.message',
      sender: USER,
      content: '{}',
      origin_server_ts: NOW,
    });
    const res = await request(createEnv({ db }), `/calls/${CALL_ID}/ws`);
    expect(res.status).toBe(404);
  });

  it('WS forwards Upgrade/Connection headers to the DO', async () => {
    const db = createCallsDb();
    seedActiveCall(db);
    const callRoom = createCallRoomStub();
    await request(createEnv({ db, callRoom }), `/calls/${CALL_ID}/ws`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'X-Forward-Me': 'yes',
      },
    });
    const hdrs = callRoom.fetches[0].headers ?? {};
    expect(hdrs['upgrade'] ?? hdrs['Upgrade']).toMatch(/websocket/i);
    expect(hdrs['x-forward-me'] ?? hdrs['X-Forward-Me']).toBe('yes');
  });

  it('WS still proxies when call content is inactive (no active check on ws)', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { ...activeCall(), active: false });
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), `/calls/${CALL_ID}/ws`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
  });

  it('start after inactive overwrites room_state event_id via ON CONFLICT', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, { ...activeCall(), active: false, call_id: 'old-call' });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(db.stateLinks).toHaveLength(1);
    expect(db.stateLinks[0].event_id).toBe(`call_${CALL_ID}`);
    expect(db.events.some((e) => e.event_id === `call_${CALL_ID}`)).toBe(true);
  });

  it('wsUrl uses SERVER_NAME from env (example.com fixture)', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(
      createEnv({ db, serverName: 'example.com' }),
      START_PATH,
      jsonInit('POST', {})
    );
    expect(res.body).toEqual({
      callId: CALL_ID,
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
  });

  it('GET∥end concurrent: GET status stays 200; end succeeds', async () => {
    const db = createCallsDb();
    seedActiveCall(db);
    const env = createEnv({ db });
    const [getRes, endRes] = await Promise.all([
      request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } }),
      request(env, END_PATH, jsonInit('POST', {})),
    ]);
    expect(getRes.status).toBe(200);
    expect(endRes.status).toBe(200);
    expect(JSON.parse(db.events[0].content).active).toBe(false);
  });

  it('failInit∥GET concurrent: start still 200 and GET may see the new call', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub({ failInit: true });
    const env = createEnv({ db, callRoom });
    const [startRes, getRes] = await Promise.all([
      request(env, START_PATH, jsonInit('POST', {})),
      request(env, GET_PATH, { headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(startRes.status).toBe(200);
    expect(getRes.status).toBe(200);
    expect(typeof (getRes.body as { active?: boolean }).active).toBe('boolean');
  });

  it('wrong methods on start/end/ws remain 404 (Hono unmatched)', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    expect((await request(env, START_PATH, jsonInit('GET'))).status).toBe(404);
    expect((await request(env, END_PATH, jsonInit('GET'))).status).toBe(404);
    expect((await request(env, `/calls/${CALL_ID}/ws`, jsonInit('POST', {}))).status).toBe(404);
  });
});
