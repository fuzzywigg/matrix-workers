/**
 * TOKENMAXX HEAVY deepen after #117 — different slice: Cloudflare Calls SFU API routes.
 * Avoids sync (#117), rooms (#114), oidc/media (#115/#113), voip/rtc siblings tested separately.
 * Tests-only — no product inventing.
 * Exercises call get/start/end + /calls/:callId/ws Durable Object proxy via Hono app.request().
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
        // Node Response rejects 101; use 200 stand-in to prove DO proxy wiring.
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
              // JOIN room_state + events for m.call.state
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
              // WS lookup: events by event_id
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

// =============================================================================
// GET /_matrix/client/v3/rooms/:roomId/call
// =============================================================================

describe('calls GET /rooms/:roomId/call', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });

  const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/call`;

  it('returns 500 when Calls not configured', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const res = await request(createEnv(), path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Video calling not configured',
    });
  });

  it('returns active:false when no call state', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('returns active call fields from state content', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, {
      active: true,
      call_id: 'c1',
      participants: ['@bob:example.com'],
      started_at: 123,
    });
    const res = await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      callId: 'c1',
      participants: ['@bob:example.com'],
      startedAt: 123,
    });
  });

  it('defaults active/participants when content omits them', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { call_id: 'x' });
    const res = await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toEqual({
      active: false,
      callId: 'x',
      participants: [],
      startedAt: undefined,
    });
  });

  it('returns active:false when content JSON is corrupt', async () => {
    const db = createCallsDb();
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: 'call_bad',
    });
    db.events.push({
      event_id: 'call_bad',
      room_id: ROOM,
      type: 'm.call.state',
      sender: USER,
      content: '{bad',
      origin_server_ts: NOW,
    });
    const res = await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('decodes percent-encoded roomId for DB lookup', async () => {
    const db = createCallsDb();
    await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = db.selects.find((s) => s.sql.includes('m.call.state'));
    expect(q?.args[0]).toBe(ROOM);
  });
});

// =============================================================================
// POST /_matrix/client/v3/rooms/:roomId/call/start
// =============================================================================

describe('calls POST /rooms/:roomId/call/start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`;

  it('returns 500 when Calls not configured', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const res = await request(createEnv(), path, jsonInit('POST', {}));
    expect(res.status).toBe(500);
  });

  it('forbids non-join members', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const res = await request(createEnv({ db }), path, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbids when membership missing', async () => {
    const db = createCallsDb({ memberships: [] });
    const res = await request(createEnv({ db }), path, jsonInit('POST', {}));
    expect(res.status).toBe(403);
  });

  it('returns M_CALL_ALREADY_ACTIVE when existing active call', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, activeCall());
    const res = await request(createEnv({ db }), path, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });

  it('ignores corrupt existing call content and proceeds to start', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: 'call_old',
    });
    db.events.push({
      event_id: 'call_old',
      room_id: ROOM,
      type: 'm.call.state',
      sender: USER,
      content: 'NOT_JSON',
      origin_server_ts: NOW,
    });
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), path, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
  });

  it('allows start when existing call is inactive', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db, { ...activeCall(), active: false });
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), path, jsonInit('POST', {}));
    expect(res.status).toBe(200);
  });

  it('returns 500 when CALL_ROOMS binding missing', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db, noCallRooms: true }), path, jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });

  it('inits CallRoom DO and stores state + returns wsUrl', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, path, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      callId: CALL_ID,
      wsUrl: `wss://example.com/calls/${CALL_ID}/ws`,
    });
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0]).toMatchObject({
      url: 'http://internal/init',
      method: 'POST',
      body: { roomId: ROOM, callId: CALL_ID },
    });
    expect(db.stateLinks[0].event_id).toBe(`call_${CALL_ID}`);
    expect(db.events[0].content).toContain('"active":true');
    expect(JSON.parse(db.events[0].content)).toMatchObject({
      active: true,
      call_id: CALL_ID,
      started_by: USER,
      started_at: NOW,
      participants: [],
    });
  });

  it('uses idFromName roomId:callId for DO addressing', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const names: string[] = [];
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    (env as { CALL_ROOMS: { idFromName: (n: string) => { name: string }; get: () => CallRoomStub } }).CALL_ROOMS.idFromName =
      (n) => {
        names.push(n);
        return { name: n };
      };
    await request(env, path, jsonInit('POST', {}));
    expect(names).toEqual([`${ROOM}:${CALL_ID}`]);
  });
});

// =============================================================================
// POST /_matrix/client/v3/rooms/:roomId/call/end
// =============================================================================

describe('calls POST /rooms/:roomId/call/end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/call/end`;

  it('returns 500 when Calls not configured', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const res = await request(createEnv(), path, jsonInit('POST', {}));
    expect(res.status).toBe(500);
  });

  it('returns 404 when no call state', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), path, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('returns 404 when call content is corrupt JSON', async () => {
    const db = createCallsDb();
    db.stateLinks.push({
      room_id: ROOM,
      event_type: 'm.call.state',
      state_key: '',
      event_id: 'call_x',
    });
    db.events.push({
      event_id: 'call_x',
      room_id: ROOM,
      type: 'm.call.state',
      sender: USER,
      content: '{',
      origin_server_ts: NOW,
    });
    const res = await request(createEnv({ db }), path, jsonInit('POST', {}));
    expect(res.status).toBe(404);
  });

  it('returns 404 when call exists but active=false', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { ...activeCall(), active: false });
    const res = await request(createEnv({ db }), path, jsonInit('POST', {}));
    expect(res.status).toBe(404);
  });

  it('ends DO call, updates event content, returns success', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall());
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, path, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(callRoom.fetches.some((f) => f.url.includes('/end'))).toBe(true);
    const updated = JSON.parse(db.events[0].content) as {
      active: boolean;
      ended_at: number;
      ended_by: string;
    };
    expect(updated.active).toBe(false);
    expect(updated.ended_at).toBe(NOW);
    expect(updated.ended_by).toBe(USER);
  });

  it('ignores DO end failures and still marks inactive', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall());
    const callRoom = createCallRoomStub({ failEnd: true });
    const res = await request(createEnv({ db, callRoom }), path, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(JSON.parse(db.events[0].content).active).toBe(false);
  });

  it('skips DO end when CALL_ROOMS missing but still updates DB', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall());
    const res = await request(
      createEnv({ db, noCallRooms: true }),
      path,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.events[0].content).active).toBe(false);
  });
});

// =============================================================================
// GET /calls/:callId/ws
// =============================================================================

describe('calls GET /calls/:callId/ws', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });

  it('returns 500 when Calls not configured', async () => {
    callsMocks.isCallsConfigured.mockReturnValue(false);
    const res = await request(createEnv(), `/calls/${CALL_ID}/ws`);
    expect(res.status).toBe(500);
  });

  it('returns 500 when CALL_ROOMS missing', async () => {
    const res = await request(createEnv({ noCallRooms: true }), `/calls/${CALL_ID}/ws`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Call rooms not configured' });
  });

  it('returns 404 when call event not found', async () => {
    const db = createCallsDb();
    const res = await request(createEnv({ db }), `/calls/${CALL_ID}/ws`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('proxies WebSocket request to CallRoom DO', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall());
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const res = await request(env, `/calls/${CALL_ID}/ws`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'X-Test': '1',
      },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
    expect(callRoom.fetches).toHaveLength(1);
    expect(callRoom.fetches[0].url).toBe('http://internal/ws');
    expect(
      callRoom.fetches[0].headers?.['upgrade']?.toLowerCase() ||
        callRoom.fetches[0].headers?.['Upgrade']
    ).toBeTruthy();
  });

  it('looks up event_id as call_${callId}', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall({ call_id: 'abc123' }));
    // seed uses call_${call_id} — request ws with matching id
    const callRoom = createCallRoomStub();
    await request(createEnv({ db, callRoom }), `/calls/abc123/ws`);
    const q = db.selects.find((s) => s.sql.includes('FROM events') && s.sql.includes('event_id'));
    expect(q?.args[0]).toBe('call_abc123');
  });

  it('does not require auth on ws endpoint', async () => {
    const db = createCallsDb();
    seedActiveCall(db, activeCall());
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), `/calls/${CALL_ID}/ws`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('ws-proxy');
  });
});

// =============================================================================
// TOKENMAXX leftovers — lifecycle + edges
// =============================================================================

describe('calls TOKENMAXX leftover edges after #117', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start → get → end → get lifecycle', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const base = `/_matrix/client/v3/rooms/${ROOM_ENC}/call`;

    const start = await request(env, `${base}/start`, jsonInit('POST', {}));
    expect(start.status).toBe(200);

    const get1 = await request(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get1.body).toMatchObject({ active: true, callId: CALL_ID });

    const end = await request(env, `${base}/end`, jsonInit('POST', {}));
    expect(end.status).toBe(200);

    const get2 = await request(env, base, { headers: { Authorization: 'Bearer t' } });
    expect(get2.body).toMatchObject({ active: false, callId: CALL_ID });
  });

  it('second start after end succeeds (inactive cleared)', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    const base = `/_matrix/client/v3/rooms/${ROOM_ENC}/call`;
    await request(env, `${base}/start`, jsonInit('POST', {}));
    await request(env, `${base}/end`, jsonInit('POST', {}));
    const again = await request(env, `${base}/start`, jsonInit('POST', {}));
    expect(again.status).toBe(200);
  });

  it('start rejects invite membership', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const res = await request(
      createEnv({ db }),
      `/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(403);
  });

  it('GET call does not check membership (open read of room call state)', async () => {
    // Implementation does not check membership on GET — only config + state
    const db = createCallsDb({ memberships: [] });
    seedActiveCall(db, activeCall());
    const res = await request(
      createEnv({ db }),
      `/_matrix/client/v3/rooms/${ROOM_ENC}/call`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: true });
  });

  it('ws after start proxies to same DO name room:callId', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    const names: string[] = [];
    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });
    (env as { CALL_ROOMS: { idFromName: (n: string) => { name: string }; get: () => CallRoomStub } }).CALL_ROOMS =
      {
        idFromName: (n) => {
          names.push(n);
          return { name: n };
        },
        get: () => callRoom,
      };
    await request(env, `/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`, jsonInit('POST', {}));
    await request(env, `/calls/${CALL_ID}/ws`);
    expect(names).toEqual([`${ROOM}:${CALL_ID}`, `${ROOM}:${CALL_ID}`]);
  });

  it('end with truthy active but missing call_id still updates DB (DO name uses undefined)', async () => {
    const db = createCallsDb();
    seedActiveCall(db, { active: true, participants: [] });
    // overwrite content without call_id
    db.events[0].content = JSON.stringify({ active: true });
    const callRoom = createCallRoomStub();
    const res = await request(createEnv({ db, callRoom }), `/_matrix/client/v3/rooms/${ROOM_ENC}/call/end`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(JSON.parse(db.events[0].content).active).toBe(false);
  });
});
