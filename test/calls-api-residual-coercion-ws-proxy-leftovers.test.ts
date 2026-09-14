/**
 * TOKENMAXX HEAVY residual leftovers after #261 — Cloudflare Calls Matrix
 * routes *coercion / WS proxy* edges not covered by:
 *   - test/calls-api-residual-typed-json-leftovers.test.ts (#261):
 *     participants:false/0/'' → []; content null/true/42/[]; active string/"yes"
 *   - test/calls-api-leftovers-deepen.test.ts (#227): active:1/0/'' / participants:null
 *   - voip-rtc-calls-concurrent-race (#201) soft floods (wsStatus always 200)
 *
 * Source pins (src/api/calls.ts):
 *   GET:  participants || [] — truthy non-arrays pass through
 *   GET:  JSON string root → .active undefined or catch
 *   start: content.active truthiness; catch on null/primitive root
 *   end:  !callContent.active when key omitted → 404
 *   WS:   return callRoom.fetch(...) status/body passthrough
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
const WS_PATH = `/calls/${CALL_ID}/ws`;

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

function seedCall(
  db: CallsDb,
  content: unknown,
  opts: { eventId?: string; rawContent?: string } = {}
) {
  const eventId =
    opts.eventId ??
    `call_${
      content && typeof content === 'object' && 'call_id' in content
        ? String((content as { call_id?: unknown }).call_id ?? CALL_ID)
        : CALL_ID
    }`;
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
    content: opts.rawContent ?? JSON.stringify(content),
    origin_server_ts: NOW,
  });
  return eventId;
}

describe('calls residual coercion GET leftovers after #261', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET participants:{} / true / 5 kept as-is (truthy non-array || left side)', async () => {
    for (const participants of [{}, true, 5] as const) {
      const db = createCallsDb();
      seedCall(db, activeCall({ participants }));
      const res = await request(createEnv({ db }), GET_PATH);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ participants, active: true, callId: CALL_ID });
    }
  });

  it('GET content JSON string "hello" → active false via undefined || false', async () => {
    const db = createCallsDb();
    seedCall(db, 'hello', { eventId: `call_${CALL_ID}`, rawContent: '"hello"' });
    const res = await request(createEnv({ db }), GET_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: false });
  });

  it('GET content JSON stringified object root → active false (string has no .active)', async () => {
    const db = createCallsDb();
    // Stored value is a JSON string whose parse result is itself a string (double-encoded shape)
    seedCall(db, '{"active":true}', {
      eventId: `call_${CALL_ID}`,
      rawContent: JSON.stringify('{"active":true}'),
    });
    const res = await request(createEnv({ db }), GET_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: false });
  });

  it('GET content JSON false (boolean) → active false via undefined || false', async () => {
    const db = createCallsDb();
    seedCall(db, false, { eventId: `call_${CALL_ID}`, rawContent: 'false' });
    const res = await request(createEnv({ db }), GET_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: false });
  });
});

describe('calls residual coercion start/end leftovers after #261', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POST start when existing row is JSON null — catch ignore → start proceeds', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedCall(db, null, { eventId: `call_${CALL_ID}`, rawContent: 'null' });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
  });

  it('POST start when existing row is JSON true — .active undefined → proceeds', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedCall(db, true, { eventId: `call_${CALL_ID}`, rawContent: 'true' });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
  });

  it('POST start when existing row is JSON 42 — .active undefined → proceeds', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedCall(db, 42, { eventId: `call_${CALL_ID}`, rawContent: '42' });
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: CALL_ID });
  });

  it('POST start treats active:"false" as already active (non-empty string truthy)', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedCall(db, activeCall({ active: 'false' }));
    const res = await request(createEnv({ db }), START_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });

  it('POST end with active key omitted → 404 (!undefined)', async () => {
    const db = createCallsDb();
    const { active: _a, ...rest } = activeCall();
    seedCall(db, rest);
    const res = await request(createEnv({ db }), END_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('POST end with call_id:0 / false / "" → DO idFromName stringification', async () => {
    for (const [callId, expectedSuffix] of [
      [0, '0'],
      [false, 'false'],
      ['', ''],
    ] as const) {
      const db = createCallsDb();
      seedCall(db, activeCall({ call_id: callId }), { eventId: `call_${CALL_ID}` });
      const callRoom = createCallRoomStub();
      const names: string[] = [];
      const env = createEnv({ db, callRoom });
      (
        env as unknown as {
          CALL_ROOMS: { idFromName: (n: string) => unknown; get: () => unknown };
        }
      ).CALL_ROOMS = {
        idFromName: (name: string) => {
          names.push(name);
          return { name, toString: () => name };
        },
        get: () => callRoom,
      };

      const res = await request(env, END_PATH, jsonInit('POST', {}));
      expect(res.status).toBe(200);
      expect(names).toEqual([`${ROOM}:${expectedSuffix}`]);
    }
  });
});

describe('calls residual WS proxy status leftovers after #261', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callsMocks.isCallsConfigured.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('WS proxies DO non-200 status 426 with body passthrough', async () => {
    const db = createCallsDb();
    seedCall(db, activeCall());
    const callRoom = createCallRoomStub({ wsStatus: 426 });
    const res = await request(createEnv({ db, callRoom }), WS_PATH, {
      method: 'GET',
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    expect(res.status).toBe(426);
    expect(res.body).toBe('ws-proxy');
    expect(res.headers.get('X-WS-Proxy')).toBe('1');
  });

  it('WS proxies DO status 500 with body passthrough', async () => {
    const db = createCallsDb();
    seedCall(db, activeCall());
    const callRoom = createCallRoomStub({ wsStatus: 500 });
    const res = await request(createEnv({ db, callRoom }), WS_PATH, {
      method: 'GET',
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toBe('ws-proxy');
  });
});
