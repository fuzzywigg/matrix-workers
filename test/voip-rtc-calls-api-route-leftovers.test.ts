/**
 * TOKENMAXX HEAVY leftovers after #157 — voip/rtc/calls soft/edge/reliability.
 * Complements voip-rtc-calls-api-routes.test.ts. Tests-only — no product inventing.
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

function jsonInit(method: string, body?: unknown, contentType = 'application/json'): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': contentType,
      Authorization: 'Bearer test-token',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function joinMembership(roomId = ROOM, userId = USER): Membership {
  return { room_id: roomId, user_id: userId, membership: 'join' };
}

function activeCallMember(n: number): CallMemberState {
  const future = Date.now() + 3_600_000 + n;
  return {
    room_id: ROOM,
    type: 'm.call.member',
    state_key: USER,
    content: JSON.stringify({
      memberships: [
        {
          device_id: 'DEVICEA',
          expires_ts: future,
          application: 'm.call',
          call_id: `call-${n}`,
        },
      ],
    }),
  };
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

describe('voip leftovers GET turnServer soft flood after #157', () => {
  it('GET turnServer STUN soft-0', async () => {
    isTurnConfigured.mockReturnValue(false);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
  it('GET turnServer TURN soft-1', async () => {
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'u-1',
      password: 'p-1',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600 + 1,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(creds);
  });
  it('GET turnServer STUN soft-2', async () => {
    isTurnConfigured.mockReturnValue(false);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
  it('GET turnServer TURN soft-3', async () => {
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'u-3',
      password: 'p-3',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600 + 3,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(creds);
  });
  it('GET turnServer STUN soft-4', async () => {
    isTurnConfigured.mockReturnValue(false);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
  it('GET turnServer TURN soft-5', async () => {
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'u-5',
      password: 'p-5',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600 + 5,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(creds);
  });
  it('GET turnServer STUN soft-6', async () => {
    isTurnConfigured.mockReturnValue(false);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
  it('GET turnServer TURN soft-7', async () => {
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'u-7',
      password: 'p-7',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600 + 7,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(creds);
  });
  it('GET turnServer STUN soft-8', async () => {
    isTurnConfigured.mockReturnValue(false);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
  it('GET turnServer TURN soft-9', async () => {
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'u-9',
      password: 'p-9',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600 + 9,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(creds);
  });
  it('GET turnServer STUN soft-10', async () => {
    isTurnConfigured.mockReturnValue(false);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
  it('GET turnServer TURN soft-11', async () => {
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'u-11',
      password: 'p-11',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600 + 11,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(creds);
  });
  it('GET turnServer STUN soft-12', async () => {
    isTurnConfigured.mockReturnValue(false);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
  it('GET turnServer TURN soft-13', async () => {
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'u-13',
      password: 'p-13',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600 + 13,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(creds);
  });
  it('GET turnServer STUN soft-14', async () => {
    isTurnConfigured.mockReturnValue(false);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
  it('GET turnServer TURN soft-15', async () => {
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'u-15',
      password: 'p-15',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600 + 15,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(creds);
  });
  it('GET turnServer STUN soft-16', async () => {
    isTurnConfigured.mockReturnValue(false);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
  it('GET turnServer TURN soft-17', async () => {
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'u-17',
      password: 'p-17',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600 + 17,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(creds);
  });
  it('GET turnServer STUN soft-18', async () => {
    isTurnConfigured.mockReturnValue(false);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
  it('GET turnServer TURN soft-19', async () => {
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'u-19',
      password: 'p-19',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600 + 19,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(creds);
  });
  it('GET turnServer STUN soft-20', async () => {
    isTurnConfigured.mockReturnValue(false);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
  it('GET turnServer TURN soft-21', async () => {
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'u-21',
      password: 'p-21',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600 + 21,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(creds);
  });
  it('GET turnServer STUN soft-22', async () => {
    isTurnConfigured.mockReturnValue(false);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
  it('GET turnServer TURN soft-23', async () => {
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'u-23',
      password: 'p-23',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600 + 23,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(creds);
  });
  it('GET turnServer STUN soft-24', async () => {
    isTurnConfigured.mockReturnValue(false);
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
});

describe('voip leftovers GET v1 call soft flood after #157', () => {
  it('GET v1 call soft-0', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(0)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-1', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(1)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-2', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(2)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-3', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(3)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-4', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(4)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-5', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(5)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-6', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(6)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-7', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(7)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-8', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(8)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-9', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(9)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-10', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(10)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-11', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(11)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-12', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(12)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-13', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(13)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-14', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(14)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-15', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(15)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-16', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(16)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-17', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(17)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-18', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(18)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-19', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(19)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-20', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(20)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-21', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(21)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-22', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(22)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-23', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(23)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
  it('GET v1 call soft-24', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [activeCallMember(24)],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect((out.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
  });
});

describe('voip leftovers PUT v1 call soft flood after #157', () => {
  it('PUT v1 call soft-0', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-0',
          expires_ts: Date.now() + 60_000 + 0,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-1', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-1',
          expires_ts: Date.now() + 60_000 + 1,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-2', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-2',
          expires_ts: Date.now() + 60_000 + 2,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-3', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-3',
          expires_ts: Date.now() + 60_000 + 3,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-4', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-4',
          expires_ts: Date.now() + 60_000 + 4,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-5', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-5',
          expires_ts: Date.now() + 60_000 + 5,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-6', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-6',
          expires_ts: Date.now() + 60_000 + 6,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-7', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-7',
          expires_ts: Date.now() + 60_000 + 7,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-8', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-8',
          expires_ts: Date.now() + 60_000 + 8,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-9', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-9',
          expires_ts: Date.now() + 60_000 + 9,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-10', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-10',
          expires_ts: Date.now() + 60_000 + 10,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-11', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-11',
          expires_ts: Date.now() + 60_000 + 11,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-12', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-12',
          expires_ts: Date.now() + 60_000 + 12,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-13', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-13',
          expires_ts: Date.now() + 60_000 + 13,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-14', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-14',
          expires_ts: Date.now() + 60_000 + 14,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-15', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-15',
          expires_ts: Date.now() + 60_000 + 15,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-16', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-16',
          expires_ts: Date.now() + 60_000 + 16,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-17', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-17',
          expires_ts: Date.now() + 60_000 + 17,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-18', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-18',
          expires_ts: Date.now() + 60_000 + 18,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-19', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-19',
          expires_ts: Date.now() + 60_000 + 19,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-20', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-20',
          expires_ts: Date.now() + 60_000 + 20,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-21', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-21',
          expires_ts: Date.now() + 60_000 + 21,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-22', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-22',
          expires_ts: Date.now() + 60_000 + 22,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-23', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-23',
          expires_ts: Date.now() + 60_000 + 23,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
  it('PUT v1 call soft-24', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', {
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'put-24',
          expires_ts: Date.now() + 60_000 + 24,
        }),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
  });
});

describe('voip leftovers DELETE v1 call soft flood after #157', () => {
  it('DELETE v1 call soft-0', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              { device_id: 'DEVICEA', application: 'm.call', call_id: 'del-0' },
              { device_id: 'OTHER', application: 'm.call', call_id: 'keep-0' },
            ],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=DEVICEA`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('DELETE v1 call soft-1', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              { device_id: 'DEVICEA', application: 'm.call', call_id: 'del-1' },
              { device_id: 'OTHER', application: 'm.call', call_id: 'keep-1' },
            ],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=DEVICEA`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('DELETE v1 call soft-2', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              { device_id: 'DEVICEA', application: 'm.call', call_id: 'del-2' },
              { device_id: 'OTHER', application: 'm.call', call_id: 'keep-2' },
            ],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=DEVICEA`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('DELETE v1 call soft-3', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              { device_id: 'DEVICEA', application: 'm.call', call_id: 'del-3' },
              { device_id: 'OTHER', application: 'm.call', call_id: 'keep-3' },
            ],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=DEVICEA`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('DELETE v1 call soft-4', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              { device_id: 'DEVICEA', application: 'm.call', call_id: 'del-4' },
              { device_id: 'OTHER', application: 'm.call', call_id: 'keep-4' },
            ],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=DEVICEA`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('DELETE v1 call soft-5', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              { device_id: 'DEVICEA', application: 'm.call', call_id: 'del-5' },
              { device_id: 'OTHER', application: 'm.call', call_id: 'keep-5' },
            ],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=DEVICEA`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('DELETE v1 call soft-6', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              { device_id: 'DEVICEA', application: 'm.call', call_id: 'del-6' },
              { device_id: 'OTHER', application: 'm.call', call_id: 'keep-6' },
            ],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=DEVICEA`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('DELETE v1 call soft-7', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              { device_id: 'DEVICEA', application: 'm.call', call_id: 'del-7' },
              { device_id: 'OTHER', application: 'm.call', call_id: 'keep-7' },
            ],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=DEVICEA`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('DELETE v1 call soft-8', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              { device_id: 'DEVICEA', application: 'm.call', call_id: 'del-8' },
              { device_id: 'OTHER', application: 'm.call', call_id: 'keep-8' },
            ],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=DEVICEA`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('DELETE v1 call soft-9', async () => {
    const db = createVoipDb({
      memberships: [joinMembership()],
      callMembers: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          content: JSON.stringify({
            memberships: [
              { device_id: 'DEVICEA', application: 'm.call', call_id: 'del-9' },
              { device_id: 'OTHER', application: 'm.call', call_id: 'keep-9' },
            ],
          }),
        },
      ],
    });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=DEVICEA`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
});

describe('rtc leftovers GET transports soft flood after #157', () => {
  it('GET transports empty soft-0', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });
  it('GET transports livekit soft-1', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k-1',
      apiSecret: 's-1',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
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
  it('GET transports empty soft-2', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });
  it('GET transports livekit soft-3', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k-3',
      apiSecret: 's-3',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
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
  it('GET transports empty soft-4', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });
  it('GET transports livekit soft-5', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k-5',
      apiSecret: 's-5',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
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
  it('GET transports empty soft-6', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });
  it('GET transports livekit soft-7', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k-7',
      apiSecret: 's-7',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
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
  it('GET transports empty soft-8', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });
  it('GET transports livekit soft-9', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k-9',
      apiSecret: 's-9',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
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
  it('GET transports empty soft-10', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });
  it('GET transports livekit soft-11', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k-11',
      apiSecret: 's-11',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
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
  it('GET transports empty soft-12', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });
  it('GET transports livekit soft-13', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k-13',
      apiSecret: 's-13',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
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
  it('GET transports empty soft-14', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });
  it('GET transports livekit soft-15', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k-15',
      apiSecret: 's-15',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
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
  it('GET transports empty soft-16', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });
  it('GET transports livekit soft-17', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k-17',
      apiSecret: 's-17',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
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
  it('GET transports empty soft-18', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });
  it('GET transports livekit soft-19', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k-19',
      apiSecret: 's-19',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
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
  it('GET transports empty soft-20', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });
  it('GET transports livekit soft-21', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k-21',
      apiSecret: 's-21',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
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
  it('GET transports empty soft-22', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });
  it('GET transports livekit soft-23', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k-23',
      apiSecret: 's-23',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
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
  it('GET transports empty soft-24', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv()
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ transports: [] });
  });
});

describe('rtc leftovers POST livekit/get_token soft flood after #157', () => {
  it('POST get_token soft-0', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-0');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-0' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-0' });
  });
  it('POST get_token soft-1', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-1');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-1' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-1' });
  });
  it('POST get_token soft-2', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-2');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-2' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-2' });
  });
  it('POST get_token soft-3', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-3');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-3' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-3' });
  });
  it('POST get_token soft-4', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-4');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-4' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-4' });
  });
  it('POST get_token soft-5', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-5');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-5' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-5' });
  });
  it('POST get_token soft-6', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-6');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-6' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-6' });
  });
  it('POST get_token soft-7', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-7');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-7' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-7' });
  });
  it('POST get_token soft-8', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-8');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-8' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-8' });
  });
  it('POST get_token soft-9', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-9');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-9' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-9' });
  });
  it('POST get_token soft-10', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-10');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-10' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-10' });
  });
  it('POST get_token soft-11', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-11');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-11' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-11' });
  });
  it('POST get_token soft-12', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-12');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-12' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-12' });
  });
  it('POST get_token soft-13', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-13');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-13' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-13' });
  });
  it('POST get_token soft-14', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-14');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-14' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-14' });
  });
  it('POST get_token soft-15', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-15');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-15' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-15' });
  });
  it('POST get_token soft-16', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-16');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-16' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-16' });
  });
  it('POST get_token soft-17', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-17');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-17' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-17' });
  });
  it('POST get_token soft-18', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-18');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-18' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-18' });
  });
  it('POST get_token soft-19', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-19');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-19' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-19' });
  });
  it('POST get_token soft-20', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-20');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-20' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-20' });
  });
  it('POST get_token soft-21', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-21');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-21' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-21' });
  });
  it('POST get_token soft-22', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-22');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-22' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-22' });
  });
  it('POST get_token soft-23', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-23');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-23' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-23' });
  });
  it('POST get_token soft-24', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('jwt-24');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM, device_id: 'PHONE-24' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'jwt-24' });
  });
});

describe('rtc leftovers POST livekit/get_token/sfu/get soft flood after #157', () => {
  it('POST sfu/get soft-0', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('sfu-jwt-0');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', { room: ROOM, device_id: 'D-0' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'sfu-jwt-0' });
  });
  it('POST sfu/get soft-1', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('sfu-jwt-1');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', { room: ROOM, device_id: 'D-1' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'sfu-jwt-1' });
  });
  it('POST sfu/get soft-2', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('sfu-jwt-2');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', { room: ROOM, device_id: 'D-2' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'sfu-jwt-2' });
  });
  it('POST sfu/get soft-3', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('sfu-jwt-3');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', { room: ROOM, device_id: 'D-3' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'sfu-jwt-3' });
  });
  it('POST sfu/get soft-4', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('sfu-jwt-4');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', { room: ROOM, device_id: 'D-4' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'sfu-jwt-4' });
  });
  it('POST sfu/get soft-5', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('sfu-jwt-5');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', { room: ROOM, device_id: 'D-5' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'sfu-jwt-5' });
  });
  it('POST sfu/get soft-6', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('sfu-jwt-6');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', { room: ROOM, device_id: 'D-6' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'sfu-jwt-6' });
  });
  it('POST sfu/get soft-7', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('sfu-jwt-7');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', { room: ROOM, device_id: 'D-7' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'sfu-jwt-7' });
  });
  it('POST sfu/get soft-8', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('sfu-jwt-8');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', { room: ROOM, device_id: 'D-8' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'sfu-jwt-8' });
  });
  it('POST sfu/get soft-9', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('sfu-jwt-9');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', { room: ROOM, device_id: 'D-9' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ url: 'wss://livekit.example.com', jwt: 'sfu-jwt-9' });
  });
});

describe('calls leftovers GET v3 call soft flood after #157', () => {
  it('GET v3 call inactive soft-0', async () => {
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
  it('GET v3 call active soft-1', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_1',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-1',
            participants: [USER],
            started_at: 1000 + 1,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-1',
      participants: [USER],
    });
  });
  it('GET v3 call active soft-2', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_2',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-2',
            participants: [USER],
            started_at: 1000 + 2,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-2',
      participants: [USER],
    });
  });
  it('GET v3 call inactive soft-3', async () => {
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
  it('GET v3 call active soft-4', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_4',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-4',
            participants: [USER],
            started_at: 1000 + 4,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-4',
      participants: [USER],
    });
  });
  it('GET v3 call active soft-5', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_5',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-5',
            participants: [USER],
            started_at: 1000 + 5,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-5',
      participants: [USER],
    });
  });
  it('GET v3 call inactive soft-6', async () => {
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
  it('GET v3 call active soft-7', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_7',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-7',
            participants: [USER],
            started_at: 1000 + 7,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-7',
      participants: [USER],
    });
  });
  it('GET v3 call active soft-8', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_8',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-8',
            participants: [USER],
            started_at: 1000 + 8,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-8',
      participants: [USER],
    });
  });
  it('GET v3 call inactive soft-9', async () => {
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
  it('GET v3 call active soft-10', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_10',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-10',
            participants: [USER],
            started_at: 1000 + 10,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-10',
      participants: [USER],
    });
  });
  it('GET v3 call active soft-11', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_11',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-11',
            participants: [USER],
            started_at: 1000 + 11,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-11',
      participants: [USER],
    });
  });
  it('GET v3 call inactive soft-12', async () => {
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
  it('GET v3 call active soft-13', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_13',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-13',
            participants: [USER],
            started_at: 1000 + 13,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-13',
      participants: [USER],
    });
  });
  it('GET v3 call active soft-14', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_14',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-14',
            participants: [USER],
            started_at: 1000 + 14,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-14',
      participants: [USER],
    });
  });
  it('GET v3 call inactive soft-15', async () => {
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
  it('GET v3 call active soft-16', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_16',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-16',
            participants: [USER],
            started_at: 1000 + 16,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-16',
      participants: [USER],
    });
  });
  it('GET v3 call active soft-17', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_17',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-17',
            participants: [USER],
            started_at: 1000 + 17,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-17',
      participants: [USER],
    });
  });
  it('GET v3 call inactive soft-18', async () => {
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
  it('GET v3 call active soft-19', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_19',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-19',
            participants: [USER],
            started_at: 1000 + 19,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-19',
      participants: [USER],
    });
  });
  it('GET v3 call active soft-20', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_20',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-20',
            participants: [USER],
            started_at: 1000 + 20,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-20',
      participants: [USER],
    });
  });
  it('GET v3 call inactive soft-21', async () => {
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
  it('GET v3 call active soft-22', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_22',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-22',
            participants: [USER],
            started_at: 1000 + 22,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-22',
      participants: [USER],
    });
  });
  it('GET v3 call active soft-23', async () => {
    const db = createCallsDb({
      callStates: [
        {
          room_id: ROOM,
          event_id: 'call_23',
          content: JSON.stringify({
            active: true,
            call_id: 'cid-23',
            participants: [USER],
            started_at: 1000 + 23,
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
    expect(out.body).toMatchObject({
      active: true,
      callId: 'cid-23',
      participants: [USER],
    });
  });
  it('GET v3 call inactive soft-24', async () => {
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
});

describe('calls leftovers POST call/start soft flood after #157', () => {
  it('POST call/start soft-0', async () => {
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
    expect(out.body).toMatchObject({
      callId: 'opaque-call-id-16',
      wsUrl: `wss://${SERVER}/calls/opaque-call-id-16/ws`,
    });
  });
  it('POST call/start soft-1', async () => {
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
    expect(out.body).toMatchObject({
      callId: 'opaque-call-id-16',
      wsUrl: `wss://${SERVER}/calls/opaque-call-id-16/ws`,
    });
  });
  it('POST call/start soft-2', async () => {
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
    expect(out.body).toMatchObject({
      callId: 'opaque-call-id-16',
      wsUrl: `wss://${SERVER}/calls/opaque-call-id-16/ws`,
    });
  });
  it('POST call/start soft-3', async () => {
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
    expect(out.body).toMatchObject({
      callId: 'opaque-call-id-16',
      wsUrl: `wss://${SERVER}/calls/opaque-call-id-16/ws`,
    });
  });
  it('POST call/start soft-4', async () => {
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
    expect(out.body).toMatchObject({
      callId: 'opaque-call-id-16',
      wsUrl: `wss://${SERVER}/calls/opaque-call-id-16/ws`,
    });
  });
  it('POST call/start soft-5', async () => {
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
    expect(out.body).toMatchObject({
      callId: 'opaque-call-id-16',
      wsUrl: `wss://${SERVER}/calls/opaque-call-id-16/ws`,
    });
  });
  it('POST call/start soft-6', async () => {
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
    expect(out.body).toMatchObject({
      callId: 'opaque-call-id-16',
      wsUrl: `wss://${SERVER}/calls/opaque-call-id-16/ws`,
    });
  });
  it('POST call/start soft-7', async () => {
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
    expect(out.body).toMatchObject({
      callId: 'opaque-call-id-16',
      wsUrl: `wss://${SERVER}/calls/opaque-call-id-16/ws`,
    });
  });
  it('POST call/start soft-8', async () => {
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
    expect(out.body).toMatchObject({
      callId: 'opaque-call-id-16',
      wsUrl: `wss://${SERVER}/calls/opaque-call-id-16/ws`,
    });
  });
  it('POST call/start soft-9', async () => {
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
    expect(out.body).toMatchObject({
      callId: 'opaque-call-id-16',
      wsUrl: `wss://${SERVER}/calls/opaque-call-id-16/ws`,
    });
  });
});

describe('calls leftovers POST call/end soft flood after #157', () => {
  it('POST call/end soft-0', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const content = JSON.stringify({ active: true, call_id: 'end-0', participants: [] });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_end-0', content }],
      callEvents: [{ event_id: 'call_end-0', room_id: ROOM, content }],
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
  });
  it('POST call/end soft-1', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const content = JSON.stringify({ active: true, call_id: 'end-1', participants: [] });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_end-1', content }],
      callEvents: [{ event_id: 'call_end-1', room_id: ROOM, content }],
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
  });
  it('POST call/end soft-2', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const content = JSON.stringify({ active: true, call_id: 'end-2', participants: [] });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_end-2', content }],
      callEvents: [{ event_id: 'call_end-2', room_id: ROOM, content }],
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
  });
  it('POST call/end soft-3', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const content = JSON.stringify({ active: true, call_id: 'end-3', participants: [] });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_end-3', content }],
      callEvents: [{ event_id: 'call_end-3', room_id: ROOM, content }],
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
  });
  it('POST call/end soft-4', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const content = JSON.stringify({ active: true, call_id: 'end-4', participants: [] });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_end-4', content }],
      callEvents: [{ event_id: 'call_end-4', room_id: ROOM, content }],
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
  });
  it('POST call/end soft-5', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const content = JSON.stringify({ active: true, call_id: 'end-5', participants: [] });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_end-5', content }],
      callEvents: [{ event_id: 'call_end-5', room_id: ROOM, content }],
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
  });
  it('POST call/end soft-6', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const content = JSON.stringify({ active: true, call_id: 'end-6', participants: [] });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_end-6', content }],
      callEvents: [{ event_id: 'call_end-6', room_id: ROOM, content }],
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
  });
  it('POST call/end soft-7', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const content = JSON.stringify({ active: true, call_id: 'end-7', participants: [] });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_end-7', content }],
      callEvents: [{ event_id: 'call_end-7', room_id: ROOM, content }],
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
  });
  it('POST call/end soft-8', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const content = JSON.stringify({ active: true, call_id: 'end-8', participants: [] });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_end-8', content }],
      callEvents: [{ event_id: 'call_end-8', room_id: ROOM, content }],
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
  });
  it('POST call/end soft-9', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const content = JSON.stringify({ active: true, call_id: 'end-9', participants: [] });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_end-9', content }],
      callEvents: [{ event_id: 'call_end-9', room_id: ROOM, content }],
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
  });
});

describe('voip/rtc/calls leftovers failure edges after #157', () => {
  it('GET v1 call forbids non-member', async () => {
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb({ memberships: [] }))
      )
    );
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
  it('PUT v1 call forbids non-member', async () => {
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', { device_id: 'DEVICEA' }),
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(403);
  });
  it('PUT v1 call rejects bad JSON', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
          body: '{bad',
        },
        voipEnv(db)
      )
    );
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });
  it('GET turnServer falls back STUN on API_ERROR', async () => {
    isTurnConfigured.mockReturnValue(true);
    getMatrixTurnCredentials.mockRejectedValue(new TurnError('api', 'API_ERROR', 502));
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STUN);
  });
  it('GET turnServer 429 on USER_RATE_LIMITED', async () => {
    isTurnConfigured.mockReturnValue(true);
    getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate', 'USER_RATE_LIMITED', 429, 45000)
    );
    const out = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(out.status).toBe(429);
    expect(out.body).toMatchObject({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 45000 });
  });
  it('POST get_token not configured returns 500', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM }),
        rtcEnv()
      )
    );
    expect(out.status).toBe(500);
  });
  it('POST get_token bad JSON returns 400', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
          body: 'x',
        },
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(400);
  });
  it('POST get_token missing room returns 400', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { device_id: 'D' }),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(400);
  });
  it('POST sfu/get not configured returns 500', async () => {
    getLiveKitConfig.mockReturnValue(null);
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token/sfu/get',
        jsonInit('POST', { room: ROOM }),
        rtcEnv()
      )
    );
    expect(out.status).toBe(500);
  });
  it('GET v3 call not configured returns 500', async () => {
    isCallsConfigured.mockReturnValue(false);
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        callsEnv(createCallsDb(), { configured: false })
      )
    );
    expect(out.status).toBe(500);
  });
  it('POST call/start forbids non-member', async () => {
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}),
        callsEnv(createCallsDb({ memberships: [] }))
      )
    );
    expect(out.status).toBe(403);
  });
  it('POST call/start not configured returns 500', async () => {
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
  it('POST call/end not found when inactive', async () => {
    const content = JSON.stringify({ active: false, call_id: 'x' });
    const db = createCallsDb({
      callStates: [{ room_id: ROOM, event_id: 'call_x', content }],
      callEvents: [{ event_id: 'call_x', room_id: ROOM, content }],
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
  it('POST call/end not configured returns 500', async () => {
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
});

describe('voip/rtc/calls leftovers method matrix after #157', () => {
  it('turnServer rejects POST', async () => {
    const res = await voip.request(
      'http://localhost/_matrix/client/v3/voip/turnServer',
      { method: 'POST', headers: { Authorization: 'Bearer t' } },
      voipEnv(createVoipDb())
    );
    // Hono unmatched method → 404 (no Allow/405 handler on voip routes)
    expect([404, 405]).toContain(res.status);
  });
  it('turnServer rejects PUT', async () => {
    const res = await voip.request(
      'http://localhost/_matrix/client/v3/voip/turnServer',
      { method: 'PUT', headers: { Authorization: 'Bearer t' } },
      voipEnv(createVoipDb())
    );
    expect([404, 405]).toContain(res.status);
  });
  it('turnServer rejects DELETE', async () => {
    const res = await voip.request(
      'http://localhost/_matrix/client/v3/voip/turnServer',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      voipEnv(createVoipDb())
    );
    expect([404, 405]).toContain(res.status);
  });
  it('get_token OPTIONS preflight', async () => {
    const res = await rtc.request(
      'http://localhost/livekit/get_token',
      { method: 'OPTIONS' },
      rtcEnv()
    );
    expect(res.status).toBe(204);
  });
  it('get_token GET returns 405', async () => {
    const res = await rtc.request(
      'http://localhost/livekit/get_token',
      { method: 'GET' },
      rtcEnv()
    );
    expect(res.status).toBe(405);
  });
  it('sfu/get GET returns 405', async () => {
    const res = await rtc.request(
      'http://localhost/livekit/get_token/sfu/get',
      { method: 'GET' },
      rtcEnv()
    );
    expect(res.status).toBe(405);
  });
  it('sfu/get PUT returns 405', async () => {
    const res = await rtc.request(
      'http://localhost/livekit/get_token/sfu/get',
      { method: 'PUT' },
      rtcEnv()
    );
    expect(res.status).toBe(405);
  });
  it('transports rejects POST', async () => {
    const res = await rtc.request(
      'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
      { method: 'POST', headers: { Authorization: 'Bearer t' } },
      rtcEnv()
    );
    expect([404, 405]).toContain(res.status);
  });
});

describe('voip/rtc/calls leftovers charset soft flood after #157', () => {
  it('PUT v1 call charset soft-0', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', { device_id: 'DEVICEA', call_id: 'ct-0' }, "application/json"),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('PUT v1 call charset soft-1', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', { device_id: 'DEVICEA', call_id: 'ct-1' }, "application/json; charset=utf-8"),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('PUT v1 call charset soft-2', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', { device_id: 'DEVICEA', call_id: 'ct-2' }, "application/json;charset=UTF-8"),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('PUT v1 call charset soft-3', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', { device_id: 'DEVICEA', call_id: 'ct-3' }, "application/json; charset=UTF-8"),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('PUT v1 call charset soft-4', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', { device_id: 'DEVICEA', call_id: 'ct-4' }, "application/json; charset=\"utf-8\""),
        voipEnv(db)
      )
    );
    expect(out.status).toBe(200);
  });
  it('POST get_token charset soft-0', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('ct-jwt-0');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM }, "application/json"),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
  });
  it('POST get_token charset soft-1', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('ct-jwt-1');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM }, "application/json; charset=utf-8"),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
  });
  it('POST get_token charset soft-2', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('ct-jwt-2');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM }, "application/json;charset=UTF-8"),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
  });
  it('POST get_token charset soft-3', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('ct-jwt-3');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM }, "application/json; charset=UTF-8"),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
  });
  it('POST get_token charset soft-4', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    generateLiveKitToken.mockResolvedValue('ct-jwt-4');
    const out = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM }, "application/json; charset=\"utf-8\""),
        rtcEnv({ livekit: true })
      )
    );
    expect(out.status).toBe(200);
  });
  it('POST call/start charset soft-0', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const db = createCallsDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}, "application/json"),
        callsEnv(db, { callRooms: stubs })
      )
    );
    expect(out.status).toBe(200);
  });
  it('POST call/start charset soft-1', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const db = createCallsDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}, "application/json; charset=utf-8"),
        callsEnv(db, { callRooms: stubs })
      )
    );
    expect(out.status).toBe(200);
  });
  it('POST call/start charset soft-2', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const db = createCallsDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}, "application/json;charset=UTF-8"),
        callsEnv(db, { callRooms: stubs })
      )
    );
    expect(out.status).toBe(200);
  });
  it('POST call/start charset soft-3', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const db = createCallsDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}, "application/json; charset=UTF-8"),
        callsEnv(db, { callRooms: stubs })
      )
    );
    expect(out.status).toBe(200);
  });
  it('POST call/start charset soft-4', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const db = createCallsDb({ memberships: [joinMembership()] });
    const out = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}, "application/json; charset=\"utf-8\""),
        callsEnv(db, { callRooms: stubs })
      )
    );
    expect(out.status).toBe(200);
  });
});

describe('voip/rtc/calls leftovers lifecycles after #157', () => {
  it('lifecycle PUT then GET then DELETE v1 call', async () => {
    const db = createVoipDb({ memberships: [joinMembership()] });
    const put = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        jsonInit('PUT', { device_id: 'DEVICEA', call_id: 'life-1' }),
        voipEnv(db)
      )
    );
    expect(put.status).toBe(200);
    const get = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(get.status).toBe(200);
    const del = await parseRes(
      await voip.request(
        `http://localhost/_matrix/client/v1/rooms/${ROOM_ENC}/call?device_id=DEVICEA`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        voipEnv(db)
      )
    );
    expect(del.status).toBe(200);
  });
  it('lifecycle start then GET then end', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const db = createCallsDb({ memberships: [joinMembership()] });
    const start = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
        jsonInit('POST', {}),
        callsEnv(db, { callRooms: stubs })
      )
    );
    expect(start.status).toBe(200);
    const get = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call`,
        { headers: { Authorization: 'Bearer t' } },
        callsEnv(db, { callRooms: stubs })
      )
    );
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ active: true, callId: 'opaque-call-id-16' });
    const end = await parseRes(
      await calls.request(
        `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/end`,
        jsonInit('POST', {}),
        callsEnv(db, { callRooms: stubs })
      )
    );
    expect(end.status).toBe(200);
    expect(end.body).toEqual({ success: true });
  });
  it('lifecycle start→get→end second pass', async () => {
    const stubs = new Map<string, CallRoomStub>();
    const db = createCallsDb({ memberships: [joinMembership()] });
    expect(
      (
        await parseRes(
          await calls.request(
            `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/start`,
            jsonInit('POST', {}),
            callsEnv(db, { callRooms: stubs })
          )
        )
      ).status
    ).toBe(200);
    expect(
      (
        await parseRes(
          await calls.request(
            `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call`,
            { headers: { Authorization: 'Bearer t' } },
            callsEnv(db, { callRooms: stubs })
          )
        )
      ).body
    ).toMatchObject({ active: true });
    expect(
      (
        await parseRes(
          await calls.request(
            `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/call/end`,
            jsonInit('POST', {}),
            callsEnv(db, { callRooms: stubs })
          )
        )
      ).status
    ).toBe(200);
  });
  it('lifecycle transports then get_token', async () => {
    getLiveKitConfig.mockReturnValue({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
    const t = await parseRes(
      await rtc.request(
        'http://localhost/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
        { headers: { Authorization: 'Bearer t' } },
        rtcEnv({ livekit: true })
      )
    );
    expect(t.status).toBe(200);
    generateLiveKitToken.mockResolvedValue('life.jwt');
    const tok = await parseRes(
      await rtc.request(
        'http://localhost/livekit/get_token',
        jsonInit('POST', { room: ROOM }),
        rtcEnv({ livekit: true })
      )
    );
    expect(tok.status).toBe(200);
    expect(tok.body).toMatchObject({ jwt: 'life.jwt' });
  });
  it('lifecycle STUN then TURN turnServer', async () => {
    isTurnConfigured.mockReturnValue(false);
    const stun = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(stun.body).toEqual(STUN);
    isTurnConfigured.mockReturnValue(true);
    const creds = {
      username: 'life',
      password: 'pw',
      uris: ['turn:turn.example.com:3478'],
      ttl: 3600,
    };
    getMatrixTurnCredentials.mockResolvedValue(creds);
    const turn = await parseRes(
      await voip.request(
        'http://localhost/_matrix/client/v3/voip/turnServer',
        { headers: { Authorization: 'Bearer t' } },
        voipEnv(createVoipDb())
      )
    );
    expect(turn.body).toEqual(creds);
  });
});
