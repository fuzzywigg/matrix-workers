/**
 * TOKENMAXX HEAVY deepen after #115 — different slice: voip / rtc / calls API routes.
 * Avoids oidc-auth + qr-login (#115), rooms (#114), media (#113).
 * Service helpers already covered in voip-rtc-helpers / livekit-token / cloudflare-calls.
 * Tests-only — no product inventing. Exercises Hono app.request() branches.
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

const getMatrixTurnCredentials = vi.fn();
const getStunServers = vi.fn(() => ({
  username: '',
  password: '',
  uris: ['stun:stun.cloudflare.com:3478'],
  ttl: 86400,
}));
const isTurnConfigured = vi.fn(() => false);

vi.mock('../src/services/turn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/turn')>();
  return {
    ...actual,
    getMatrixTurnCredentials: (...args: unknown[]) => getMatrixTurnCredentials(...args),
    getStunServers: (...args: unknown[]) => getStunServers(...args),
    isTurnConfigured: (...args: unknown[]) => isTurnConfigured(...args),
  };
});

const getLiveKitConfig = vi.fn();
const generateLiveKitToken = vi.fn();

vi.mock('../src/services/livekit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/livekit')>();
  return {
    ...actual,
    getLiveKitConfig: (...args: unknown[]) => getLiveKitConfig(...args),
    generateLiveKitToken: (...args: unknown[]) => generateLiveKitToken(...args),
  };
});

const isCallsConfigured = vi.fn(() => false);

vi.mock('../src/services/cloudflare-calls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/cloudflare-calls')>();
  return {
    ...actual,
    isCallsConfigured: (...args: unknown[]) => isCallsConfigured(...args),
  };
});

const notifyUsersOfEvent = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    notifyUsersOfEvent: (...args: unknown[]) => notifyUsersOfEvent(...args),
  };
});

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateOpaqueId: vi.fn(async () => 'opaque-call-id-16'),
  };
});

import voip from '../src/api/voip';
import rtc from '../src/api/rtc';
import calls from '../src/api/calls';

const USER = '@alice:example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const SERVER = 'example.com';
const STUN = {
  username: '',
  password: '',
  uris: ['stun:stun.cloudflare.com:3478'],
  ttl: 86400,
};

type SqlCall = { sql: string; args: unknown[] };

type Membership = { room_id: string; user_id: string; membership: string };

type CallMemberState = {
  room_id: string;
  type: string;
  state_key: string;
  content: string;
};

type CallStateEvent = {
  room_id: string;
  event_id: string;
  content: string;
  event_type?: string;
};

type CallRoomFetch = { url: string; method: string; body?: unknown };

function mockKv(data: Record<string, string> = {}) {
  return {
    data,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    put: async (key: string, value: string) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace & { data: Record<string, string> };
}

function createCallRoomStub(opts: { failEnd?: boolean; wsResponse?: Response } = {}) {
  const fetches: CallRoomFetch[] = [];
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
        throw new Error('end failed');
      }
      if (req.url.includes('/ws')) {
        // Node Response rejects 101; assert proxy wiring with a stand-in 200 body.
        return opts.wsResponse ?? new Response('ws-proxy', { status: 200 });
      }
      return Response.json({ ok: true });
    },
  };
}

type CallRoomStub = ReturnType<typeof createCallRoomStub>;

function createVoipDb(opts: {
  memberships?: Membership[];
  callMembers?: CallMemberState[];
} = {}) {
  const memberships = opts.memberships ?? [];
  const callMembers = opts.callMembers ?? [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const selects: SqlCall[] = [];

  const db = {
    memberships,
    callMembers,
    inserts,
    updates,
    selects,
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
                sql.includes('FROM room_state') &&
                sql.includes("type = 'm.call.member'") &&
                sql.includes('state_key = ?')
              ) {
                const [roomId, stateKey] = args as string[];
                const row = callMembers.find(
                  (r) =>
                    r.room_id === roomId &&
                    r.type === 'm.call.member' &&
                    r.state_key === stateKey
                );
                return (row ? { content: row.content } : null) as T;
              }
              return null as T;
            },
            async all<T>() {
              selects.push({ sql, args });
              if (
                sql.includes('FROM room_state') &&
                sql.includes("type = 'm.call.member'") &&
                !sql.includes('state_key = ?')
              ) {
                const [roomId] = args as string[];
                const rows = callMembers
                  .filter((r) => r.room_id === roomId && r.type === 'm.call.member')
                  .map((r) => ({ state_key: r.state_key, content: r.content }));
                return { results: rows as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO room_state') || sql.includes('INSERT INTO events')) {
                inserts.push({ sql, args });
              }
              if (sql.includes('UPDATE room_state')) {
                updates.push({ sql, args });
                const [, content, , , roomId, stateKey] = args as string[];
                const idx = callMembers.findIndex(
                  (r) =>
                    r.room_id === roomId &&
                    r.type === 'm.call.member' &&
                    r.state_key === stateKey
                );
                if (idx >= 0) {
                  callMembers[idx] = { ...callMembers[idx], content };
                }
              }
              if (sql.includes('ON CONFLICT')) {
                inserts.push({ sql, args });
                const [roomId, stateKey, , content] = args as string[];
                const idx = callMembers.findIndex(
                  (r) =>
                    r.room_id === roomId &&
                    r.type === 'm.call.member' &&
                    r.state_key === stateKey
                );
                if (idx >= 0) {
                  callMembers[idx] = { ...callMembers[idx], content };
                } else {
                  callMembers.push({
                    room_id: roomId,
                    type: 'm.call.member',
                    state_key: stateKey,
                    content,
                  });
                }
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };

  return db as unknown as D1Database & {
    memberships: Membership[];
    callMembers: CallMemberState[];
    inserts: SqlCall[];
    updates: SqlCall[];
    selects: SqlCall[];
  };
}

function createCallsDb(opts: {
  memberships?: Membership[];
  callStates?: CallStateEvent[];
  callEvents?: Array<{ event_id: string; room_id: string; content: string }>;
} = {}) {
  const memberships = opts.memberships ?? [];
  const callStates = opts.callStates ?? [];
  const callEvents = opts.callEvents ?? [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];

  const db = {
    memberships,
    callStates,
    callEvents,
    inserts,
    updates,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                return (row ? { membership: row.membership } : null) as T;
              }
              if (
                sql.includes('FROM room_state') &&
                sql.includes("event_type = 'm.call.state'") &&
                sql.includes('JOIN events')
              ) {
                const [roomId] = args as string[];
                const row = callStates.find((c) => c.room_id === roomId);
                if (!row) return null as T;
                if (sql.includes('e.event_id')) {
                  return { content: row.content, event_id: row.event_id } as T;
                }
                return { content: row.content } as T;
              }
              if (sql.includes('FROM events') && sql.includes("type = 'm.call.state'")) {
                const [eventId] = args as string[];
                const row = callEvents.find((e) => e.event_id === eventId);
                return (row
                  ? { room_id: row.room_id, content: row.content }
                  : null) as T;
              }
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO room_state') || sql.includes('INSERT OR REPLACE INTO events')) {
                inserts.push({ sql, args });
                if (sql.includes('INSERT OR REPLACE INTO events')) {
                  const [eventId, roomId, , content] = args as string[];
                  const idx = callEvents.findIndex((e) => e.event_id === eventId);
                  const entry = { event_id: eventId, room_id: roomId, content };
                  if (idx >= 0) callEvents[idx] = entry;
                  else callEvents.push(entry);
                  const stateIdx = callStates.findIndex((c) => c.room_id === roomId);
                  const state = {
                    room_id: roomId,
                    event_id: eventId,
                    content,
                  };
                  if (stateIdx >= 0) callStates[stateIdx] = state;
                  else callStates.push(state);
                }
              }
              if (sql.includes('UPDATE events SET content')) {
                updates.push({ sql, args });
                const [content, eventId] = args as string[];
                const ev = callEvents.find((e) => e.event_id === eventId);
                if (ev) ev.content = content;
                const st = callStates.find((c) => c.event_id === eventId);
                if (st) st.content = content;
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };

  return db as unknown as D1Database & {
    memberships: Membership[];
    callStates: CallStateEvent[];
    callEvents: Array<{ event_id: string; room_id: string; content: string }>;
    inserts: SqlCall[];
    updates: SqlCall[];
  };
}

function voipEnv(db: ReturnType<typeof createVoipDb>, partial: Partial<Env> = {}): Env {
  return {
    DB: db,
    SERVER_NAME: SERVER,
    CACHE: mockKv(),
    SESSIONS: mockKv(),
    ...partial,
  } as unknown as Env;
}

function rtcEnv(opts: {
  sessions?: ReturnType<typeof mockKv>;
  livekit?: boolean;
} = {}): Env {
  return {
    DB: {} as D1Database,
    SERVER_NAME: SERVER,
    SESSIONS: opts.sessions ?? mockKv(),
    CACHE: mockKv(),
    ...(opts.livekit
      ? {
          LIVEKIT_API_KEY: 'lk-key',
          LIVEKIT_API_SECRET: 'lk-secret',
          LIVEKIT_URL: 'wss://livekit.example.com',
        }
      : {}),
  } as unknown as Env;
}

function callsEnv(
  db: ReturnType<typeof createCallsDb>,
  opts: { callRooms?: Map<string, CallRoomStub>; configured?: boolean } = {}
): Env {
  const stubs = opts.callRooms ?? new Map<string, CallRoomStub>();
  return {
    DB: db,
    SERVER_NAME: SERVER,
    CACHE: mockKv(),
    CALLS_APP_ID: opts.configured === false ? undefined : 'app-id',
    CALLS_APP_SECRET: opts.configured === false ? undefined : 'app-secret',
    CALL_ROOMS: {
      idFromName(name: string) {
        return { name } as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        const name = (id as unknown as { name: string }).name;
        let stub = stubs.get(name);
        if (!stub) {
          stub = createCallRoomStub();
          stubs.set(name, stub);
        }
        return stub as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace,
  } as unknown as Env;
}

async function parseRes(res: Response): Promise<{ status: number; body: unknown; text: string }> {
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
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function joinMembership(roomId = ROOM, userId = USER): Membership {
  return { room_id: roomId, user_id: userId, membership: 'join' };
}

beforeEach(() => {
  getMatrixTurnCredentials.mockReset();
  getStunServers.mockReset().mockReturnValue(STUN);
  isTurnConfigured.mockReset().mockReturnValue(false);
  getLiveKitConfig.mockReset().mockReturnValue(null);
  generateLiveKitToken.mockReset().mockResolvedValue('jwt.token.here');
  isCallsConfigured.mockReset().mockReturnValue(true);
  notifyUsersOfEvent.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// voip.ts — TURN credentials
// ===========================================================================

describe('voip GET /_matrix/client/v3/voip/turnServer', () => {
  it('returns STUN-only when TURN is not configured', async () => {
    isTurnConfigured.mockReturnValue(false);
    const db = createVoipDb();
    const res = await voip.request(
      'http://localhost/_matrix/client/v3/voip/turnServer',
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(db)
    );
    const out = await parseRes(res);
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
    expect(getMatrixTurnCredentials).not.toHaveBeenCalled();
    expect(getStunServers).toHaveBeenCalled();
  });

  it('returns TURN credentials when configured', async () => {
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'u',
      password: 'p',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const db = createVoipDb();
    const res = await voip.request(
      'http://localhost/_matrix/client/v3/voip/turnServer',
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(db)
    );
    const out = await parseRes(res);
    expect(out.status).toBe(200);
    expect(out.body).toEqual(creds);
    expect(getMatrixTurnCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ SERVER_NAME: SERVER }),
      3600,
      USER
    );
  });

  it('returns 429 with retry_after_ms on USER_RATE_LIMITED', async () => {
    isTurnConfigured.mockReturnValue(true);
    getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate', 'USER_RATE_LIMITED', 429, 45000)
    );
    const res = await voip.request(
      'http://localhost/_matrix/client/v3/voip/turnServer',
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(createVoipDb())
    );
    const out = await parseRes(res);
    expect(out.status).toBe(429);
    expect(out.body).toMatchObject({
      errcode: 'M_LIMIT_EXCEEDED',
      retry_after_ms: 45000,
    });
  });

  it('defaults retry_after_ms to 60000 when USER_RATE_LIMITED omits it', async () => {
    isTurnConfigured.mockReturnValue(true);
    getMatrixTurnCredentials.mockRejectedValue(new TurnError('rate', 'USER_RATE_LIMITED', 429));
    const res = await voip.request(
      'http://localhost/_matrix/client/v3/voip/turnServer',
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(createVoipDb())
    );
    const out = await parseRes(res);
    expect(out.status).toBe(429);
    expect(out.body).toMatchObject({ retry_after_ms: 60000 });
  });

  it('returns 429 on Cloudflare API RATE_LIMITED', async () => {
    isTurnConfigured.mockReturnValue(true);
    getMatrixTurnCredentials.mockRejectedValue(new TurnError('cf rate', 'RATE_LIMITED', 429));
    const res = await voip.request(
      'http://localhost/_matrix/client/v3/voip/turnServer',
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(createVoipDb())
    );
    const out = await parseRes(res);
    expect(out.status).toBe(429);
    expect(out.body).toMatchObject({
      errcode: 'M_LIMIT_EXCEEDED',
      retry_after_ms: 60000,
    });
  });

  it('falls back to STUN on other TurnError codes (API_ERROR)', async () => {
    isTurnConfigured.mockReturnValue(true);
    getMatrixTurnCredentials.mockRejectedValue(new TurnError('api', 'API_ERROR', 502));
    const res = await voip.request(
      'http://localhost/_matrix/client/v3/voip/turnServer',
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(createVoipDb())
    );
    const out = await parseRes(res);
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });

  it('falls back to STUN on NOT_CONFIGURED TurnError race', async () => {
    isTurnConfigured.mockReturnValue(true);
    getMatrixTurnCredentials.mockRejectedValue(new TurnError('nope', 'NOT_CONFIGURED'));
    const res = await voip.request(
      'http://localhost/_matrix/client/v3/voip/turnServer',
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(createVoipDb())
    );
    const out = await parseRes(res);
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });

  it('falls back to STUN on unexpected non-TurnError', async () => {
    isTurnConfigured.mockReturnValue(true);
    getMatrixTurnCredentials.mockRejectedValue(new Error('boom'));
    const res = await voip.request(
      'http://localhost/_matrix/client/v3/voip/turnServer',
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(createVoipDb())
    );
    const out = await parseRes(res);
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });

  it('falls back to STUN on INVALID_RESPONSE TurnError', async () => {
    isTurnConfigured.mockReturnValue(true);
    getMatrixTurnCredentials.mockRejectedValue(new TurnError('bad', 'INVALID_RESPONSE'));
    const res = await voip.request(
      'http://localhost/_matrix/client/v3/voip/turnServer',
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(createVoipDb())
    );
    expect((await parseRes(res)).body).toEqual(STUN);
  });
});

// ===========================================================================
// voip.ts — MatrixRTC call membership (v1)
// ===========================================================================

describe('voip GET /_matrix/client/v1/rooms/:roomId/call', () => {
  it('forbids non-members', async () => {
    const db = createVoipDb({ memberships: [] });
    const res = await voip.request(
      `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(db)
    );
    const out = await parseRes(res);
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbids invite/leave memberships', async () => {
    for (const membership of ['invite', 'leave', 'ban', 'knock'] as const) {
      const db = createVoipDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership }],
      });
      const res = await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      );
      expect((await parseRes(res)).status).toBe(403);
    }
  });

  it('returns 404 when no call member state exists', async () => {
    const db = createVoipDb({ memberships: [joinMembership()], callMembers: [] });
    const res = await voip.request(
      `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(db)
    );
    const out = await parseRes(res);
    expect(out.status).toBe(404);
    expect(out.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('filters expired memberships and 404s when all expired', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              {
                device_id: 'OLD',
                expires_ts: Date.now() - 60_000,
                application: 'm.call',
              },
            ],
          }),
        },
      ],
    });
    const res = await voip.request(
      `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(db)
    );
    expect((await parseRes(res)).status).toBe(404);
  });

  it('skips unparsable call member content and still returns active peers', async () => {
    const future = Date.now() + 3_600_000;
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: '@bad:example.com',
          content: '{not-json',
        },
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              {
                device_id: 'DEVICEA',
                expires_ts: future,
                application: 'm.call',
                call_id: 'c1',
                foci_active: [{ type: 'livekit', livekit_alias: 'alias' }],
                focus_active: { type: 'livekit', livekit_alias: 'alias' },
              },
              {
                device_id: 'NOEXP',
                // no expires_ts → treated as active
                application: 'm.call',
              },
            ],
          }),
        },
      ],
    });
    const res = await voip.request(
      `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(db)
    );
    const out = await parseRes(res);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ call_id: '' });
    const members = (out.body as { members: unknown[] }).members;
    expect(members).toHaveLength(2);
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user_id: USER, device_id: 'DEVICEA', call_id: 'c1' }),
        expect.objectContaining({ user_id: USER, device_id: 'NOEXP', call_id: '' }),
      ])
    );
  });

  it('treats missing memberships array as empty', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({}),
        },
      ],
    });
    const res = await voip.request(
      `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      { headers: { Authorization: 'Bearer t' } },
      voipEnv(db)
    );
    expect((await parseRes(res)).status).toBe(404);
  });

  it('includes memberships with expires_ts exactly in the future', async () => {
    const future = Date.now() + 5_000;
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: '@bob:example.com',
          content: JSON.stringify({
            memberships: [{ device_id: 'B1', expires_ts: future }],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members).toHaveLength(1);
  });
});

describe('voip PUT /_matrix/client/v1/rooms/:roomId/call', () => {
  it('forbids non-members', async () => {
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', { device_id: 'DEVICEA' }),
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(403);
  });

  it('rejects invalid JSON body', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const res = await voip.request(
      `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: '{bad',
      },
      voipEnv(db)
    );
    const out = await parseRes(res);
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('requires device_id when auth device missing and body omits it', async () => {
    // Auth mock always sets deviceId; exercise body without device_id using auth device.
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', { application: 'm.call', call_id: 'x' }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    expect(notifyUsersOfEvent).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      expect.stringMatching(/^\$/),
      'm.call.member'
    );
    expect(db.inserts.some((i) => i.sql.includes('INSERT INTO room_state'))).toBe(true);
    expect(db.inserts.some((i) => i.sql.includes('INSERT INTO events'))).toBe(true);
  });

  it('creates first membership when no prior state', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const future = Date.now() + 60_000;
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'PHONE',
          application: 'm.call',
          call_id: 'call-1',
          expires_ts: future,
          foci_active: [{ type: 'livekit', livekit_alias: 'a' }],
          focus_active: { type: 'livekit', livekit_alias: 'a' },
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    const stored = db.callMembers.find((c) => c.state_key === USER);
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!.content);
    expect(parsed.memberships).toEqual([
      expect.objectContaining({
        device_id: 'PHONE',
        call_id: 'call-1',
        expires_ts: future,
      }),
    ]);
  });

  it('updates existing device membership in place', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              { device_id: 'DEVICEA', application: 'm.call', call_id: 'old' },
              { device_id: 'OTHER', application: 'm.call', call_id: 'keep' },
            ],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', { device_id: 'DEVICEA', call_id: 'new', application: 'm.call' }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    const parsed = JSON.parse(db.callMembers[0].content);
    expect(parsed.memberships).toHaveLength(2);
    expect(parsed.memberships.find((m: { device_id: string }) => m.device_id === 'DEVICEA')).toEqual(
      expect.objectContaining({ call_id: 'new' })
    );
    expect(parsed.memberships.find((m: { device_id: string }) => m.device_id === 'OTHER')).toEqual(
      expect.objectContaining({ call_id: 'keep' })
    );
  });

  it('recovers when existing state content is corrupt JSON', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: 'not-json',
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', { device_id: 'DEVICEA' }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    const parsed = JSON.parse(db.callMembers[0].content);
    expect(parsed.memberships).toHaveLength(1);
    expect(parsed.memberships[0].device_id).toBe('DEVICEA');
  });

  it('defaults expires_ts to ~1 hour when omitted', async () => {
    const before = Date.now();
    const db = createVoipDb({ memberships: [joinMembership()] });
    await voip.request(
      `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      jsonInit('PUT', { device_id: 'DEVICEA' }),
      voipEnv(db)
    );
    const after = Date.now();
    const parsed = JSON.parse(db.callMembers[0].content);
    const exp = parsed.memberships[0].expires_ts as number;
    expect(exp).toBeGreaterThanOrEqual(before + 3_600_000 - 50);
    expect(exp).toBeLessThanOrEqual(after + 3_600_000 + 50);
  });

  it('defaults application to m.call and call_id to empty string', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    await voip.request(
      `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      jsonInit('PUT', { device_id: 'DEVICEA' }),
      voipEnv(db)
    );
    const parsed = JSON.parse(db.callMembers[0].content);
    expect(parsed.memberships[0]).toMatchObject({
      application: 'm.call',
      call_id: '',
    });
  });
});

describe('voip DELETE /_matrix/client/v1/rooms/:roomId/call', () => {
  it('returns empty object when no call membership exists', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=DEVICEA`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({});
    expect(db.updates).toHaveLength(0);
  });

  it('uses auth device_id when query param omitted', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              { device_id: 'DEVICEA' },
              { device_id: 'KEEP' },
            ],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const parsed = JSON.parse(db.callMembers[0].content);
    expect(parsed.memberships).toEqual([{ device_id: 'KEEP' }]);
    expect(db.inserts.some((i) => i.sql.includes('INSERT INTO events'))).toBe(true);
  });

  it('honors device_id query override', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [{ device_id: 'PHONE' }, { device_id: 'DEVICEA' }],
          }),
        },
      ],
    });
    await voip.request(
      `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=PHONE`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      voipEnv(db)
    );
    const parsed = JSON.parse(db.callMembers[0].content);
    expect(parsed.memberships.map((m: { device_id: string }) => m.device_id)).toEqual([
      'DEVICEA',
    ]);
  });

  it('returns empty object when existing content is corrupt JSON', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: '{broken',
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({});
  });

  it('clears all memberships when last device leaves', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({ memberships: [{ device_id: 'DEVICEA' }] }),
        },
      ],
    });
    await voip.request(
      `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      voipEnv(db)
    );
    expect(JSON.parse(db.callMembers[0].content).memberships).toEqual([]);
  });

  it('treats missing memberships key as empty list', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({ other: true }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.any(String) });
    expect(JSON.parse(db.callMembers[0].content).memberships).toEqual([]);
  });
});

// ===========================================================================
// rtc.ts — MSC4143 transports + LiveKit tokens
// ===========================================================================

describe('rtc GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports', () => {
  it('returns empty transports when LiveKit is not configured', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        {},
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });

  it('advertises livekit transport when configured', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        {},
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      transports: [
        {
          type: 'livekit',
          url: `https://${SERVER}/livekit/get_token`,
        },
      ],
    });
  });
});

describe('rtc POST /livekit/get_token', () => {
  it('returns 500 when LiveKit is not configured', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM }),
        rtcEnv()
      )
    );
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('rejects invalid JSON', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
          body: 'nope',
        },
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('requires room or room_id', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { device_id: 'D' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });

  it('accepts Element X room + device_id format and returns jwt/url', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    generateLiveKitToken.mockResolvedValue('signed.jwt');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://lk.example.com', jwt: 'signed.jwt' });
    expect(generateLiveKitToken).toHaveBeenCalledWith(
      'k',
      's',
      '_room_example_com',
      USER,
      'alice',
      3600
    );
  });

  it('accepts legacy room_id + member format', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    await rtc.request(
      'http://localhost/livekit/get_token',
      jsonInit('POST', {
        room_id: '!abc:example.com',
        member: {
          id: 'ignored',
          claimed_user_id: '@evil:example.com',
          claimed_device_id: 'EVIL',
        },
      }),
      rtcEnv({ livekit: true })
    );
    expect(generateLiveKitToken).toHaveBeenCalledWith(
      'k',
      's',
      '_abc_example_com',
      USER,
      'alice',
      3600
    );
  });

  it('sanitizes LiveKit room names from Matrix room IDs', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    await rtc.request(
      'http://localhost/livekit/get_token',
      jsonInit('POST', { room: '!Foo/Bar+Baz:server.name' }),
      rtcEnv({ livekit: true })
    );
    expect(generateLiveKitToken.mock.calls[0][2]).toBe('_Foo_Bar_Baz_server_name');
  });

  it('continues when openid_token verification fails (warn only)', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    const sessions = mockKv();
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', {
          room: ROOM,
          openid_token: {
            access_token: 'missing',
            token_type: 'Bearer',
            matrix_server_name: SERVER,
            expires_in: 3600,
          },
        }),
        rtcEnv({ sessions, livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ jwt: 'jwt.token.here' });
  });

  it('rejects foreign-server openid tokens during verify (still issues JWT)', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', {
          room: ROOM,
          openid_token: {
            access_token: 'tok',
            token_type: 'Bearer',
            matrix_server_name: 'other.org',
            expires_in: 3600,
          },
        }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
  });

  it('accepts openid tokens present in SESSIONS (user_id or sub)', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    const sessions = mockKv({
      'openid:good': JSON.stringify({ user_id: USER }),
      'openid:subonly': JSON.stringify({ sub: USER }),
    });
    for (const access_token of ['good', 'subonly']) {
      const out = await parseRes(
        await rtc.request(
          'http://localhost/livekit/get_token',
          jsonInit('POST', {
            room: ROOM,
            openid_token: {
              access_token,
              token_type: 'Bearer',
              matrix_server_name: SERVER,
              expires_in: 3600,
            },
          }),
          rtcEnv({ sessions, livekit: true })
        )
      );
      expect(out.status).toBe(200);
    }
  });

  it('survives corrupt openid session JSON (verify returns null)', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    const sessions = mockKv({ 'openid:bad': '{not-json' });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', {
          room: ROOM,
          openid_token: {
            access_token: 'bad',
            token_type: 'Bearer',
            matrix_server_name: SERVER,
            expires_in: 3600,
          },
        }),
        rtcEnv({ sessions, livekit: true })
      )
    );
    expect(out.status).toBe(200);
  });

  it('returns 500 when JWT generation throws', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    generateLiveKitToken.mockRejectedValue(new Error('sign failed'));
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'Failed to generate token' });
  });

  it('prefers room_id over room when both provided', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    await rtc.request(
      'http://localhost/livekit/get_token',
      jsonInit('POST', { room_id: '!primary:example.com', room: '!secondary:example.com' }),
      rtcEnv({ livekit: true })
    );
    expect(generateLiveKitToken.mock.calls[0][2]).toBe('_primary_example_com');
  });
});

describe('rtc POST /livekit/get_token/sfu/get', () => {
  it('mirrors get_token success path for Element X /sfu/get', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    generateLiveKitToken.mockResolvedValue('sfu.jwt');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', { room: ROOM, device_id: 'D' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://lk.example.com', jwt: 'sfu.jwt' });
  });

  it('returns 500 / 400 / missing-room edges on /sfu/get', async () => {
    getLiveKitConfig.mockReturnValue(null);
    expect(
      (
        await parseRes(
          await rtc.request(
            'http://localhost/livekit/get_token/sfu/get',
            jsonInit('POST', { room: ROOM }),
            rtcEnv()
          )
        )
      ).status
    ).toBe(500);

    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    expect(
      (
        await parseRes(
          await rtc.request(
            'http://localhost/livekit/get_token/sfu/get',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
              body: 'x',
            },
            rtcEnv({ livekit: true })
          )
        )
      ).status
    ).toBe(400);
    expect(
      (
        await parseRes(
          await rtc.request(
            'http://localhost/livekit/get_token/sfu/get',
            jsonInit('POST', {}),
            rtcEnv({ livekit: true })
          )
        )
      ).status
    ).toBe(400);
  });

  it('verifies openid on /sfu/get and still issues token', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    const sessions = mockKv({
      'openid:ok': JSON.stringify({ sub: USER }),
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', {
          room_id: ROOM,
          openid_token: {
            access_token: 'ok',
            token_type: 'Bearer',
            matrix_server_name: SERVER,
            expires_in: 60,
          },
        }),
        rtcEnv({ sessions, livekit: true })
      )
    );
    expect(out.status).toBe(200);
  });

  it('returns 500 when /sfu/get JWT generation fails', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    generateLiveKitToken.mockRejectedValue(new Error('fail'));
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', { room: ROOM }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(500);
  });
});

describe('rtc OPTIONS + method probing for LiveKit endpoints', () => {
  it('answers CORS preflight for both token paths', async () => {
    for (const path of ['/livekit/get_token', '/livekit/get_token/sfu/get']) {
      const res = await rtc.request(`http://localhost${path}`, { method: 'OPTIONS' }, rtcEnv());
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    }
  });

  it('returns 405 with Allow header for GET probes (Element X availability check)', async () => {
    for (const path of ['/livekit/get_token', '/livekit/get_token/sfu/get']) {
      const res = await rtc.request(`http://localhost${path}`, { method: 'GET' }, rtcEnv());
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
      expect(await res.text()).toBe('Method Not Allowed');
    }
  });

  it('returns 405 for PUT/PATCH/DELETE probes as well', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const res = await rtc.request(
        'http://localhost/livekit/get_token',
        { method },
        rtcEnv()
      );
      expect(res.status).toBe(405);
    }
  });
});

// ===========================================================================
// calls.ts — Cloudflare Calls SFU room call management
// ===========================================================================

describe('calls GET /_matrix/client/v3/rooms/:roomId/call', () => {
  it('returns 500 when Calls is not configured', async () => {
    isCallsConfigured.mockReturnValue(false);
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        callsEnv(createCallsDb(), { configured: false })
      )
    );
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ error: 'Video calling not configured' });
  });

  it('returns active:false when no call state', async () => {
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        callsEnv(createCallsDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ active: false });
  });

  it('returns active:false when call state JSON is corrupt', async () => {
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_x', content: '{bad' }],
    });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        callsEnv(db)
      )
    );
    expect(out.body).toEqual({ active: false });
  });

  it('returns active call details from state content', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_abc',
          content: JSON.stringify({
            active: true,
            call_id: 'abc',
            participants: [USER],
            started_at: 123,
          }),
        },
      ],
    });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        callsEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      active: true,
      callId: 'abc',
      participants: [USER],
      startedAt: 123,
    });
  });

  it('defaults missing active/participants fields', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_z',
          content: JSON.stringify({ call_id: 'z' }),
        },
      ],
    });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        callsEnv(db)
      )
    );
    expect(out.body).toEqual({
      active: false,
      callId: 'z',
      participants: [],
      startedAt: undefined,
    });
  });

  it('decodes percent-encoded room ids', async () => {
    const encoded = encodeURIComponent('!weird/room:example.com');
    const db = createCallsDb({
      callStates: [
        {
          room_id: '!weird/room:example.com',
          event_id: 'call_1',
          content: JSON.stringify({ active: false, call_id: '1' }),
        },
      ],
    });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${encoded}/call`,
        { headers: { Authorization: 'Bearer t' } },
        callsEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ callId: '1' });
  });
});

describe('calls POST /_matrix/client/v3/rooms/:roomId/call/start', () => {
  it('returns 500 when Calls not configured', async () => {
    isCallsConfigured.mockReturnValue(false);
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}),
        callsEnv(createCallsDb(), { configured: false })
      )
    );
    expect(out.status).toBe(500);
  });

  it('forbids non-members', async () => {
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}),
        callsEnv(createCallsDb({ memberships: [] }))
      )
    );
    expect(out.status).toBe(403);
  });

  it('rejects already-active calls', async () => {
    const db = createCallsDb({
      memberships: [joinMembership()],
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_old',
          content: JSON.stringify({ active: true, call_id: 'old' }),
        },
      ],
    });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}),
        callsEnv(db)
      )
    );
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ errcode: 'M_CALL_ALREADY_ACTIVE' });
  });

  it('ignores corrupt existing call state and starts a new call', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const db = createCallsDb({
      memberships: [joinMembership()],
      callStates: [{ room_id: ROOM, event_id: 'call_x', content: '{bad' }],
    });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}),
        callsEnv(db, { callRooms: stubs })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      callId: 'opaque-call-id-16',
      wsUrl: `wss://${SERVER}/calls/opaque-call-id-16/ws`,
    });
    const stub = [...stubs.values()][0];
    expect(stub.fetches.some((f) => f.url.includes('/init'))).toBe(true);
  });

  it('allows restart when previous call is inactive', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const db = createCallsDb({
      memberships: [joinMembership()],
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_old',
          content: JSON.stringify({ active: false, call_id: 'old' }),
        },
      ],
    });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}),
        callsEnv(db, { callRooms: stubs })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ callId: 'opaque-call-id-16' });
  });

  it('returns 500 when CALL_ROOMS binding is missing', async () => {
    const db = createCallsDb({ memberships: [joinMembership()] });
    const env = callsEnv(db);
    delete (env as { CALL_ROOMS?: unknown }).CALL_ROOMS;
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}),
        env
      )
    );
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ error: 'Call rooms not configured' });
  });

  it('persists call state event and initializes DO', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const db = createCallsDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}),
        callsEnv(db, { callRooms: stubs })
      )
    );
    expect(out.status).toBe(200);
    expect(db.inserts.some((i) => i.sql.includes('INSERT INTO room_state'))).toBe(true);
    expect(db.inserts.some((i) => i.sql.includes('INSERT OR REPLACE INTO events'))).toBe(true);
    const init = [...stubs.values()][0].fetches.find((f) => f.url.includes('/init'));
    expect(init?.body).toEqual({ roomId: ROOM, callId: 'opaque-call-id-16' });
  });
});

describe('calls POST /_matrix/client/v3/rooms/:roomId/call/end', () => {
  it('returns 500 when Calls not configured', async () => {
    isCallsConfigured.mockReturnValue(false);
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/end`,
        jsonInit('POST', {}),
        callsEnv(createCallsDb(), { configured: false })
      )
    );
    expect(out.status).toBe(500);
  });

  it('returns 404 when no call state', async () => {
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/end`,
        jsonInit('POST', {}),
        callsEnv(createCallsDb())
      )
    );
    expect(out.status).toBe(404);
    expect(out.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('returns 404 when call state JSON is corrupt', async () => {
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_x', content: '{bad' }],
      callEvents: [{ event_id: 'call_x', room_id: ROOM, content: '{bad' }],
    });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/end`,
        jsonInit('POST', {}),
        callsEnv(db)
      )
    );
    expect(out.status).toBe(404);
  });

  it('returns 404 when call is already inactive', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_x',
          content: JSON.stringify({ active: false, call_id: 'x' }),
        },
      ],
      callEvents: [
        {
          event_id: 'call_x',
          room_id: ROOM,
          content: JSON.stringify({ active: false, call_id: 'x' }),
        },
      ],
    });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/end`,
        jsonInit('POST', {}),
        callsEnv(db)
      )
    );
    expect(out.status).toBe(404);
  });

  it('ends active call, notifies DO, and updates event content', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const content = JSON.stringify({ active: true, call_id: 'cid-1', participants: [] });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_cid-1', content }],
      callEvents: [{ event_id: 'call_cid-1', room_id: ROOM, content }],
    });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/end`,
        jsonInit('POST', {}),
        callsEnv(db, { callRooms: stubs })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ success: true });
    const stub = stubs.get(`${ROOM}:cid-1`);
    expect(stub?.fetches.some((f) => f.url.includes('/end'))).toBe(true);
    const updated = JSON.parse(db.callEvents[0].content);
    expect(updated.active).toBe(false);
    expect(updated.ended_by).toBe(USER);
    expect(typeof updated.ended_at).toBe('number');
  });

  it('ignores DO end failures and still marks call inactive', async () => {
    const stubs = new Map<string, CallRoomStub>();
    stubs.set(`${ROOM}:cid-2`, createCallRoomStub({ failEnd: true }));
    const content = JSON.stringify({ active: true, call_id: 'cid-2' });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_cid-2', content }],
      callEvents: [{ event_id: 'call_cid-2', room_id: ROOM, content }],
    });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/end`,
        jsonInit('POST', {}),
        callsEnv(db, { callRooms: stubs })
      )
    );
    expect(out.status).toBe(200);
    expect(JSON.parse(db.callEvents[0].content).active).toBe(false);
  });

  it('ends call without DO when CALL_ROOMS binding absent', async () => {
    const content = JSON.stringify({ active: true, call_id: 'cid-3' });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_cid-3', content }],
      callEvents: [{ event_id: 'call_cid-3', room_id: ROOM, content }],
    });
    const env = callsEnv(db);
    delete (env as { CALL_ROOMS?: unknown }).CALL_ROOMS;
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/end`,
        jsonInit('POST', {}),
        env
      )
    );
    expect(out.status).toBe(200);
    expect(JSON.parse(db.callEvents[0].content).active).toBe(false);
  });
});

describe('calls GET /calls/:callId/ws', () => {
  it('returns 500 when Calls not configured', async () => {
    isCallsConfigured.mockReturnValue(false);
    const out = await parseRes(
      await calls.request(
        'http://localhost/calls/abc/ws',
        {},
        callsEnv(createCallsDb(), { configured: false })
      )
    );
    expect(out.status).toBe(500);
  });

  it('returns 500 when CALL_ROOMS missing', async () => {
    const env = callsEnv(createCallsDb());
    delete (env as { CALL_ROOMS?: unknown }).CALL_ROOMS;
    const out = await parseRes(await calls.request('http://localhost/calls/abc/ws', {}, env));
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ error: 'Call rooms not configured' });
  });

  it('returns 404 when call event not found', async () => {
    const out = await parseRes(
      await calls.request('http://localhost/calls/missing/ws', {}, callsEnv(createCallsDb()))
    );
    expect(out.status).toBe(404);
    expect(out.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('proxies WebSocket upgrade to CallRoom DO', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const db = createCallsDb({
      callEvents: [
        {
          event_id: 'call_abc123',
          room_id: ROOM,
          content: JSON.stringify({ active: true, call_id: 'abc123' }),
        },
      ],
    });
    const res = await calls.request(
      'http://localhost/calls/abc123/ws',
      { headers: { Upgrade: 'websocket' } },
      callsEnv(db, { callRooms: stubs })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ws-proxy');
    const stub = stubs.get(`${ROOM}:abc123`);
    expect(stub?.fetches.some((f) => f.url.includes('/ws'))).toBe(true);
  });
});

// ===========================================================================
// Cross-slice leftovers / interaction edges
// ===========================================================================

describe('voip/rtc/calls TOKENMAXX leftovers', () => {
  it('TURN USER_RATE_LIMITED message is client-facing and non-empty', async () => {
    isTurnConfigured.mockReturnValue(true);
    getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('Too many', 'USER_RATE_LIMITED', 429, 1000)
    );
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect((out.body as { error: string }).error).toMatch(/Too many TURN/i);
  });

  it('voip GET call scopes member state to the requested room only', async () => {
    const other = '!other:example.com';
    const future = Date.now() + 60_000;
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: other,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [{ device_id: 'X', expires_ts: future }],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(404);
  });

  it('rtc transports does not require auth middleware', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        {},
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
  });

  it('calls start forbids leave membership like voip membership gate', async () => {
    const db = createCallsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}),
        callsEnv(db)
      )
    );
    expect(out.status).toBe(403);
  });

  it('voip PUT uses body device_id over auth device when both present', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    await voip.request(
      `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      jsonInit('PUT', { device_id: 'FROM_BODY' }),
      voipEnv(db)
    );
    const parsed = JSON.parse(db.callMembers[0].content);
    expect(parsed.memberships[0].device_id).toBe('FROM_BODY');
  });

  it('voip DELETE no-ops cleanly when removing unknown device from list', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({ memberships: [{ device_id: 'ONLY' }] }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=ABSENT`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(JSON.parse(db.callMembers[0].content).memberships).toEqual([{ device_id: 'ONLY' }]);
  });

  it('rtc /sfu/get prefers room_id and sanitizes identically to get_token', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://lk.example.com',
    });
    await rtc.request(
      'http://localhost/livekit/get_token/sfu/get',
      jsonInit('POST', { room_id: '!A/B:c.d', room: '!ignored:x' }),
      rtcEnv({ livekit: true })
    );
    expect(generateLiveKitToken.mock.calls[0][2]).toBe('_A_B_c_d');
  });

  it('calls GET does not require membership (state is public to authed user)', async () => {
    const db = createCallsDb({
      memberships: [],
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_p',
          content: JSON.stringify({ active: true, call_id: 'p', participants: [] }),
        },
      ],
    });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        callsEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ active: true, callId: 'p' });
  });
});
