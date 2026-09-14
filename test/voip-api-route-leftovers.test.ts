/**
 * TOKENMAXX HEAVY leftovers after #159 — voip API soft/edge/reliability.
 * Complements test/voip-api-routes.test.ts. Orthogonal to keys/media/appservice (#158),
 * spaces/search/sync/versions (#159), admin/federation/sliding-sync (parallel A / #161).
 * Tests-only — no product inventing. Fixtures use example.com only.
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

const USER = '@alice:example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const NOW = 1_700_000_000_000;
const AUTH = { Authorization: 'Bearer test-token' };

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

type SqlCall = { sql: string; args: unknown[] };

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

function createEnv(opts: { db?: VoipDb } = {}) {
  const db = opts.db ?? createVoipDb();
  const env = {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
    TURN_KEY_ID: 'turnkey',
    TURN_API_TOKEN: 'token',
    _db: db,
  };
  return env as unknown as Env & typeof env;
}

async function request(
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
    event_id: `$call_${userId.replace(/[^a-z0-9]/gi, '_')}`,
    content: JSON.stringify({ memberships }),
    sender: userId,
    origin_server_ts: NOW,
  };
}

const TURN_PATH = '/_matrix/client/v3/voip/turnServer';
const CALL_PATH = `/_matrix/client/v1/rooms/${ROOM_ENC}/call`;



describe('voip leftovers turnServer STUN soft flood after #157', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    turnMocks.isTurnConfigured.mockReturnValue(false);
  });

  it('STUN-only soft-0', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 86400,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 86400,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-1', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3479'],
      ttl: 86500,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3479'],
      ttl: 86500,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-2', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3480'],
      ttl: 86600,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3480'],
      ttl: 86600,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-3', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3481'],
      ttl: 86700,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3481'],
      ttl: 86700,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-4', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3482'],
      ttl: 86800,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3482'],
      ttl: 86800,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-5', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 86900,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 86900,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-6', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3479'],
      ttl: 87000,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3479'],
      ttl: 87000,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-7', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3480'],
      ttl: 87100,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3480'],
      ttl: 87100,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-8', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3481'],
      ttl: 87200,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3481'],
      ttl: 87200,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-9', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3482'],
      ttl: 87300,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3482'],
      ttl: 87300,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-10', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 87400,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 87400,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-11', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3479'],
      ttl: 87500,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3479'],
      ttl: 87500,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-12', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3480'],
      ttl: 87600,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3480'],
      ttl: 87600,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-13', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3481'],
      ttl: 87700,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3481'],
      ttl: 87700,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-14', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3482'],
      ttl: 87800,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3482'],
      ttl: 87800,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-15', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 87900,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 87900,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-16', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3479'],
      ttl: 88000,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3479'],
      ttl: 88000,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-17', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3480'],
      ttl: 88100,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3480'],
      ttl: 88100,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-18', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3481'],
      ttl: 88200,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3481'],
      ttl: 88200,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-19', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3482'],
      ttl: 88300,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3482'],
      ttl: 88300,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-20', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 88400,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 88400,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-21', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3479'],
      ttl: 88500,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3479'],
      ttl: 88500,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-22', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3480'],
      ttl: 88600,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3480'],
      ttl: 88600,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('STUN-only soft-23', async () => {
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3481'],
      ttl: 88700,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3481'],
      ttl: 88700,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

});

describe('voip leftovers turnServer TURN soft flood after #157', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    turnMocks.isTurnConfigured.mockReturnValue(true);
  });

  it('TURN credentials soft-0', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user0',
      password: 'pass0',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user0',
      password: 'pass0',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 3600,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-1', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user1',
      password: 'pass1',
      uris: ['turn:turn.example.com:3479?transport=udp'],
      ttl: 3660,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user1',
      password: 'pass1',
      uris: ['turn:turn.example.com:3479?transport=udp'],
      ttl: 3660,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-2', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user2',
      password: 'pass2',
      uris: ['turn:turn.example.com:3480?transport=udp'],
      ttl: 3720,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user2',
      password: 'pass2',
      uris: ['turn:turn.example.com:3480?transport=udp'],
      ttl: 3720,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-3', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user3',
      password: 'pass3',
      uris: ['turn:turn.example.com:3481?transport=udp'],
      ttl: 3780,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user3',
      password: 'pass3',
      uris: ['turn:turn.example.com:3481?transport=udp'],
      ttl: 3780,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-4', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user4',
      password: 'pass4',
      uris: ['turn:turn.example.com:3482?transport=udp'],
      ttl: 3840,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user4',
      password: 'pass4',
      uris: ['turn:turn.example.com:3482?transport=udp'],
      ttl: 3840,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-5', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user5',
      password: 'pass5',
      uris: ['turn:turn.example.com:3483?transport=udp'],
      ttl: 3900,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user5',
      password: 'pass5',
      uris: ['turn:turn.example.com:3483?transport=udp'],
      ttl: 3900,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-6', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user6',
      password: 'pass6',
      uris: ['turn:turn.example.com:3484?transport=udp'],
      ttl: 3960,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user6',
      password: 'pass6',
      uris: ['turn:turn.example.com:3484?transport=udp'],
      ttl: 3960,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-7', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user7',
      password: 'pass7',
      uris: ['turn:turn.example.com:3485?transport=udp'],
      ttl: 4020,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user7',
      password: 'pass7',
      uris: ['turn:turn.example.com:3485?transport=udp'],
      ttl: 4020,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-8', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user8',
      password: 'pass8',
      uris: ['turn:turn.example.com:3486?transport=udp'],
      ttl: 4080,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user8',
      password: 'pass8',
      uris: ['turn:turn.example.com:3486?transport=udp'],
      ttl: 4080,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-9', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user9',
      password: 'pass9',
      uris: ['turn:turn.example.com:3487?transport=udp'],
      ttl: 4140,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user9',
      password: 'pass9',
      uris: ['turn:turn.example.com:3487?transport=udp'],
      ttl: 4140,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-10', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user10',
      password: 'pass10',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 4200,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user10',
      password: 'pass10',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 4200,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-11', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user11',
      password: 'pass11',
      uris: ['turn:turn.example.com:3479?transport=udp'],
      ttl: 4260,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user11',
      password: 'pass11',
      uris: ['turn:turn.example.com:3479?transport=udp'],
      ttl: 4260,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-12', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user12',
      password: 'pass12',
      uris: ['turn:turn.example.com:3480?transport=udp'],
      ttl: 4320,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user12',
      password: 'pass12',
      uris: ['turn:turn.example.com:3480?transport=udp'],
      ttl: 4320,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-13', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user13',
      password: 'pass13',
      uris: ['turn:turn.example.com:3481?transport=udp'],
      ttl: 4380,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user13',
      password: 'pass13',
      uris: ['turn:turn.example.com:3481?transport=udp'],
      ttl: 4380,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-14', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user14',
      password: 'pass14',
      uris: ['turn:turn.example.com:3482?transport=udp'],
      ttl: 4440,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user14',
      password: 'pass14',
      uris: ['turn:turn.example.com:3482?transport=udp'],
      ttl: 4440,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-15', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user15',
      password: 'pass15',
      uris: ['turn:turn.example.com:3483?transport=udp'],
      ttl: 4500,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user15',
      password: 'pass15',
      uris: ['turn:turn.example.com:3483?transport=udp'],
      ttl: 4500,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-16', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user16',
      password: 'pass16',
      uris: ['turn:turn.example.com:3484?transport=udp'],
      ttl: 4560,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user16',
      password: 'pass16',
      uris: ['turn:turn.example.com:3484?transport=udp'],
      ttl: 4560,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-17', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user17',
      password: 'pass17',
      uris: ['turn:turn.example.com:3485?transport=udp'],
      ttl: 4620,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user17',
      password: 'pass17',
      uris: ['turn:turn.example.com:3485?transport=udp'],
      ttl: 4620,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-18', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user18',
      password: 'pass18',
      uris: ['turn:turn.example.com:3486?transport=udp'],
      ttl: 4680,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user18',
      password: 'pass18',
      uris: ['turn:turn.example.com:3486?transport=udp'],
      ttl: 4680,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-19', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user19',
      password: 'pass19',
      uris: ['turn:turn.example.com:3487?transport=udp'],
      ttl: 4740,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user19',
      password: 'pass19',
      uris: ['turn:turn.example.com:3487?transport=udp'],
      ttl: 4740,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-20', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user20',
      password: 'pass20',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 4800,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user20',
      password: 'pass20',
      uris: ['turn:turn.example.com:3478?transport=udp'],
      ttl: 4800,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-21', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user21',
      password: 'pass21',
      uris: ['turn:turn.example.com:3479?transport=udp'],
      ttl: 4860,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user21',
      password: 'pass21',
      uris: ['turn:turn.example.com:3479?transport=udp'],
      ttl: 4860,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-22', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user22',
      password: 'pass22',
      uris: ['turn:turn.example.com:3480?transport=udp'],
      ttl: 4920,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user22',
      password: 'pass22',
      uris: ['turn:turn.example.com:3480?transport=udp'],
      ttl: 4920,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('TURN credentials soft-23', async () => {
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'user23',
      password: 'pass23',
      uris: ['turn:turn.example.com:3481?transport=udp'],
      ttl: 4980,
    });
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'user23',
      password: 'pass23',
      uris: ['turn:turn.example.com:3481?transport=udp'],
      ttl: 4980,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

});

describe('voip leftovers turnServer USER_RATE_LIMITED soft flood after #157', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    turnMocks.isTurnConfigured.mockReturnValue(true);
  });

  it('USER_RATE_LIMITED retry=1000 soft-0', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 1000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 1000,
    });
  });

  it('USER_RATE_LIMITED retry=5000 soft-1', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 5000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 5000,
    });
  });

  it('USER_RATE_LIMITED retry=10000 soft-2', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 10000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 10000,
    });
  });

  it('USER_RATE_LIMITED retry=15000 soft-3', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 15000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 15000,
    });
  });

  it('USER_RATE_LIMITED retry=20000 soft-4', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 20000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 20000,
    });
  });

  it('USER_RATE_LIMITED retry=30000 soft-5', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 30000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 30000,
    });
  });

  it('USER_RATE_LIMITED retry=45000 soft-6', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 45000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 45000,
    });
  });

  it('USER_RATE_LIMITED retry=60000 soft-7', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 60000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('USER_RATE_LIMITED retry=75000 soft-8', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 75000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 75000,
    });
  });

  it('USER_RATE_LIMITED retry=90000 soft-9', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 90000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 90000,
    });
  });

  it('USER_RATE_LIMITED retry=120000 soft-10', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 120000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 120000,
    });
  });

  it('USER_RATE_LIMITED retry=180000 soft-11', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 180000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 180000,
    });
  });

  it('USER_RATE_LIMITED retry=240000 soft-12', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 240000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 240000,
    });
  });

  it('USER_RATE_LIMITED retry=300000 soft-13', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 300000)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 300000,
    });
  });

  it('USER_RATE_LIMITED retry=0 soft-14', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429, 0)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('USER_RATE_LIMITED omit retry soft-15', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate limit', 'USER_RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 60000,
    });
  });

});

describe('voip leftovers turnServer RATE_LIMITED soft flood after #157', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    turnMocks.isTurnConfigured.mockReturnValue(true);
  });

  it('RATE_LIMITED soft-0', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('cf rate 0', 'RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'TURN credential requests are rate limited. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('RATE_LIMITED soft-1', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('cf rate 1', 'RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'TURN credential requests are rate limited. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('RATE_LIMITED soft-2', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('cf rate 2', 'RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'TURN credential requests are rate limited. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('RATE_LIMITED soft-3', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('cf rate 3', 'RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'TURN credential requests are rate limited. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('RATE_LIMITED soft-4', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('cf rate 4', 'RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'TURN credential requests are rate limited. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('RATE_LIMITED soft-5', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('cf rate 5', 'RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'TURN credential requests are rate limited. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('RATE_LIMITED soft-6', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('cf rate 6', 'RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'TURN credential requests are rate limited. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('RATE_LIMITED soft-7', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('cf rate 7', 'RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'TURN credential requests are rate limited. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('RATE_LIMITED soft-8', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('cf rate 8', 'RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'TURN credential requests are rate limited. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('RATE_LIMITED soft-9', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('cf rate 9', 'RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'TURN credential requests are rate limited. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('RATE_LIMITED soft-10', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('cf rate 10', 'RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'TURN credential requests are rate limited. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('RATE_LIMITED soft-11', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('cf rate 11', 'RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'TURN credential requests are rate limited. Please try again later.',
      retry_after_ms: 60000,
    });
  });

});

describe('voip leftovers turnServer TurnError STUN degrade soft flood after #157', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getStunServers.mockReturnValue({
      username: '', password: '', uris: ['stun:stun.cloudflare.com:3478'], ttl: 86400,
    });
  });

  it('TurnError NOT_CONFIGURED degrade soft-0', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('err 0', 'NOT_CONFIGURED', 500)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uris: ['stun:stun.cloudflare.com:3478'] });
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TurnError API_ERROR degrade soft-1', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('err 1', 'API_ERROR', 500)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uris: ['stun:stun.cloudflare.com:3478'] });
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TurnError INVALID_RESPONSE degrade soft-2', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('err 2', 'INVALID_RESPONSE', 500)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uris: ['stun:stun.cloudflare.com:3478'] });
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TurnError NOT_CONFIGURED degrade soft-3', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('err 3', 'NOT_CONFIGURED', 500)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uris: ['stun:stun.cloudflare.com:3478'] });
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TurnError API_ERROR degrade soft-4', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('err 4', 'API_ERROR', 500)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uris: ['stun:stun.cloudflare.com:3478'] });
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TurnError INVALID_RESPONSE degrade soft-5', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('err 5', 'INVALID_RESPONSE', 500)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uris: ['stun:stun.cloudflare.com:3478'] });
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TurnError NOT_CONFIGURED degrade soft-6', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('err 6', 'NOT_CONFIGURED', 500)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uris: ['stun:stun.cloudflare.com:3478'] });
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TurnError API_ERROR degrade soft-7', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('err 7', 'API_ERROR', 500)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uris: ['stun:stun.cloudflare.com:3478'] });
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TurnError INVALID_RESPONSE degrade soft-8', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('err 8', 'INVALID_RESPONSE', 500)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uris: ['stun:stun.cloudflare.com:3478'] });
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TurnError NOT_CONFIGURED degrade soft-9', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('err 9', 'NOT_CONFIGURED', 500)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uris: ['stun:stun.cloudflare.com:3478'] });
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TurnError API_ERROR degrade soft-10', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('err 10', 'API_ERROR', 500)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uris: ['stun:stun.cloudflare.com:3478'] });
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('TurnError INVALID_RESPONSE degrade soft-11', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('err 11', 'INVALID_RESPONSE', 500)
    );
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uris: ['stun:stun.cloudflare.com:3478'] });
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

});

describe('voip leftovers turnServer unexpected throw STUN degrade after #157', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getStunServers.mockReturnValue({
      username: '', password: '', uris: ['stun:stun.cloudflare.com:3478'], ttl: 86400,
    });
  });

  it('unexpected throw soft-0', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new Error('network'));
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: '', password: '' });
  });

  it('unexpected throw soft-1', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new TypeError('bad type'));
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: '', password: '' });
  });

  it('unexpected throw soft-2', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new RangeError('out of range'));
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: '', password: '' });
  });

  it('unexpected throw soft-3', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(Object.assign(new Error('custom'), { code: 'ECONNREFUSED' }));
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: '', password: '' });
  });

  it('unexpected throw soft-4', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new Error('string reject'));
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: '', password: '' });
  });

  it('unexpected throw soft-5', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new Error('plain object reject'));
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: '', password: '' });
  });

  it('unexpected throw soft-6', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new Error('timeout'));
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: '', password: '' });
  });

  it('unexpected throw soft-7', async () => {
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new Error('dns failure'));
    const env = createEnv();
    const res = await request(env, TURN_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: '', password: '' });
  });

});

describe('voip leftovers GET call active soft flood after #157', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('GET active call soft-0', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV0', call_id: 'call-0', expires_ts: NOW + 1000 }]),
        callMemberState('@bob0:example.com', [{ device_id: 'BOB0', expires_ts: NOW + 1000 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV0'
    );
    expect(alice?.call_id).toBe('call-0');
  });

  it('GET active call soft-1', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV1', call_id: 'call-1', expires_ts: NOW + 1500 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV1'
    );
    expect(alice?.call_id).toBe('call-1');
  });

  it('GET active call soft-2', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV2', call_id: 'call-2', expires_ts: NOW + 2000 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV2'
    );
    expect(alice?.call_id).toBe('call-2');
  });

  it('GET active call soft-3', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV3', call_id: 'call-3', expires_ts: NOW + 2500 }]),
        callMemberState('@bob3:example.com', [{ device_id: 'BOB3', expires_ts: NOW + 2500 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV3'
    );
    expect(alice?.call_id).toBe('call-3');
  });

  it('GET active call soft-4', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV4', call_id: 'call-4', expires_ts: NOW + 3000 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV4'
    );
    expect(alice?.call_id).toBe('call-4');
  });

  it('GET active call soft-5', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV0', call_id: 'call-5', expires_ts: NOW + 3500 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV0'
    );
    expect(alice?.call_id).toBe('call-5');
  });

  it('GET active call soft-6', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV1', call_id: 'call-6', expires_ts: NOW + 4000 }]),
        callMemberState('@bob6:example.com', [{ device_id: 'BOB6', expires_ts: NOW + 4000 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV1'
    );
    expect(alice?.call_id).toBe('call-6');
  });

  it('GET active call soft-7', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV2', call_id: 'call-7', expires_ts: NOW + 4500 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV2'
    );
    expect(alice?.call_id).toBe('call-7');
  });

  it('GET active call soft-8', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV3', call_id: 'call-8', expires_ts: NOW + 5000 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV3'
    );
    expect(alice?.call_id).toBe('call-8');
  });

  it('GET active call soft-9', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV4', call_id: 'call-9', expires_ts: NOW + 5500 }]),
        callMemberState('@bob9:example.com', [{ device_id: 'BOB9', expires_ts: NOW + 5500 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV4'
    );
    expect(alice?.call_id).toBe('call-9');
  });

  it('GET active call soft-10', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV0', call_id: 'call-10', expires_ts: NOW + 6000 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV0'
    );
    expect(alice?.call_id).toBe('call-10');
  });

  it('GET active call soft-11', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV1', call_id: 'call-11', expires_ts: NOW + 6500 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV1'
    );
    expect(alice?.call_id).toBe('call-11');
  });

  it('GET active call soft-12', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV2', call_id: 'call-12', expires_ts: NOW + 7000 }]),
        callMemberState('@bob12:example.com', [{ device_id: 'BOB12', expires_ts: NOW + 7000 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV2'
    );
    expect(alice?.call_id).toBe('call-12');
  });

  it('GET active call soft-13', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV3', call_id: 'call-13', expires_ts: NOW + 7500 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV3'
    );
    expect(alice?.call_id).toBe('call-13');
  });

  it('GET active call soft-14', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV4', call_id: 'call-14', expires_ts: NOW + 8000 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV4'
    );
    expect(alice?.call_id).toBe('call-14');
  });

  it('GET active call soft-15', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV0', call_id: 'call-15', expires_ts: NOW + 8500 }]),
        callMemberState('@bob15:example.com', [{ device_id: 'BOB15', expires_ts: NOW + 8500 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV0'
    );
    expect(alice?.call_id).toBe('call-15');
  });

  it('GET active call soft-16', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV1', call_id: 'call-16', expires_ts: NOW + 9000 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV1'
    );
    expect(alice?.call_id).toBe('call-16');
  });

  it('GET active call soft-17', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV2', call_id: 'call-17', expires_ts: NOW + 9500 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV2'
    );
    expect(alice?.call_id).toBe('call-17');
  });

  it('GET active call soft-18', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV3', call_id: 'call-18', expires_ts: NOW + 10000 }]),
        callMemberState('@bob18:example.com', [{ device_id: 'BOB18', expires_ts: NOW + 10000 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV3'
    );
    expect(alice?.call_id).toBe('call-18');
  });

  it('GET active call soft-19', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'DEV4', call_id: 'call-19', expires_ts: NOW + 10500 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members.length).toBeGreaterThan(0);
    const alice = (res.body as { members: Array<{ device_id: string; call_id: string }> }).members.find(
      (m) => m.device_id === 'DEV4'
    );
    expect(alice?.call_id).toBe('call-19');
  });

});

describe('voip leftovers GET call membership gate soft flood after #157', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('GET forbids membership=invite soft-0', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=leave soft-1', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=ban soft-2', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=knock soft-3', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=invite soft-4', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=leave soft-5', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=ban soft-6', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=knock soft-7', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=invite soft-8', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=leave soft-9', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=ban soft-10', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=knock soft-11', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=invite soft-12', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=leave soft-13', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=ban soft-14', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=knock soft-15', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=invite soft-16', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=leave soft-17', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=ban soft-18', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids membership=knock soft-19', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids missing membership soft-0', async () => {
    const db = createVoipDb({ memberships: [], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids missing membership soft-1', async () => {
    const db = createVoipDb({ memberships: [], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids missing membership soft-2', async () => {
    const db = createVoipDb({ memberships: [], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids missing membership soft-3', async () => {
    const db = createVoipDb({ memberships: [], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids missing membership soft-4', async () => {
    const db = createVoipDb({ memberships: [], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids missing membership soft-5', async () => {
    const db = createVoipDb({ memberships: [], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids missing membership soft-6', async () => {
    const db = createVoipDb({ memberships: [], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('GET forbids missing membership soft-7', async () => {
    const db = createVoipDb({ memberships: [], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

});

describe('voip leftovers GET call empty/expired/corrupt after #157', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('GET 404 no call state soft-0', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET 404 no call state soft-1', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET 404 no call state soft-2', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET 404 no call state soft-3', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET 404 no call state soft-4', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET 404 no call state soft-5', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET 404 no call state soft-6', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET 404 no call state soft-7', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET 404 no call state soft-8', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET 404 no call state soft-9', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET 404 no call state soft-10', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET 404 no call state soft-11', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET 404 all expired soft-0', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'D0', expires_ts: NOW - 1 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('GET 404 all expired soft-1', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'D1', expires_ts: NOW - 2 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('GET 404 all expired soft-2', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'D2', expires_ts: NOW - 3 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('GET 404 all expired soft-3', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'D3', expires_ts: NOW - 4 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('GET 404 all expired soft-4', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'D4', expires_ts: NOW - 5 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('GET 404 all expired soft-5', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'D5', expires_ts: NOW - 6 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('GET 404 all expired soft-6', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'D6', expires_ts: NOW - 7 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('GET 404 all expired soft-7', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'D7', expires_ts: NOW - 8 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('GET 404 all expired soft-8', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'D8', expires_ts: NOW - 9 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('GET 404 all expired soft-9', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'D9', expires_ts: NOW - 10 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('GET 404 all expired soft-10', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'D10', expires_ts: NOW - 11 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('GET 404 all expired soft-11', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'D11', expires_ts: NOW - 12 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('GET skips corrupt JSON soft-0', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        {
          room_id: ROOM, type: 'm.call.member', state_key: '@bad0:example.com',
          event_id: '$bad0', content: '{not-json', sender: '@bad0:example.com',
          origin_server_ts: NOW,
        },
        callMemberState(USER, [{ device_id: 'GOOD', expires_ts: NOW + 1 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('GET skips corrupt JSON soft-1', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        {
          room_id: ROOM, type: 'm.call.member', state_key: '@bad1:example.com',
          event_id: '$bad1', content: '{{', sender: '@bad1:example.com',
          origin_server_ts: NOW,
        },
        callMemberState(USER, [{ device_id: 'GOOD', expires_ts: NOW + 1 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('GET skips corrupt JSON soft-2', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        {
          room_id: ROOM, type: 'm.call.member', state_key: '@bad2:example.com',
          event_id: '$bad2', content: 'null', sender: '@bad2:example.com',
          origin_server_ts: NOW,
        },
        callMemberState(USER, [{ device_id: 'GOOD', expires_ts: NOW + 1 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('GET skips corrupt JSON soft-3', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        {
          room_id: ROOM, type: 'm.call.member', state_key: '@bad3:example.com',
          event_id: '$bad3', content: '[]', sender: '@bad3:example.com',
          origin_server_ts: NOW,
        },
        callMemberState(USER, [{ device_id: 'GOOD', expires_ts: NOW + 1 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('GET skips corrupt JSON soft-4', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        {
          room_id: ROOM, type: 'm.call.member', state_key: '@bad4:example.com',
          event_id: '$bad4', content: '"string"', sender: '@bad4:example.com',
          origin_server_ts: NOW,
        },
        callMemberState(USER, [{ device_id: 'GOOD', expires_ts: NOW + 1 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('GET skips corrupt JSON soft-5', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        {
          room_id: ROOM, type: 'm.call.member', state_key: '@bad5:example.com',
          event_id: '$bad5', content: '12345', sender: '@bad5:example.com',
          origin_server_ts: NOW,
        },
        callMemberState(USER, [{ device_id: 'GOOD', expires_ts: NOW + 1 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('GET skips corrupt JSON soft-6', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        {
          room_id: ROOM, type: 'm.call.member', state_key: '@bad6:example.com',
          event_id: '$bad6', content: '{broken:', sender: '@bad6:example.com',
          origin_server_ts: NOW,
        },
        callMemberState(USER, [{ device_id: 'GOOD', expires_ts: NOW + 1 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('GET skips corrupt JSON soft-7', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        {
          room_id: ROOM, type: 'm.call.member', state_key: '@bad7:example.com',
          event_id: '$bad7', content: '{memberships:', sender: '@bad7:example.com',
          origin_server_ts: NOW,
        },
        callMemberState(USER, [{ device_id: 'GOOD', expires_ts: NOW + 1 }]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members).toHaveLength(1);
  });

});

describe('voip leftovers PUT call join soft flood after #157', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('PUT join call soft-0', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'm.call',
      call_id: 'join-call-0',
      expires_ts: NOW + 3600000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-0');
    expect(content.memberships[0].application).toBe('m.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-1', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'org.matrix.msc3401.call',
      call_id: 'join-call-1',
      expires_ts: NOW + 3601000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-1');
    expect(content.memberships[0].application).toBe('org.matrix.msc3401.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-2', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'm.call',
      call_id: 'join-call-2',
      expires_ts: NOW + 3602000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-2');
    expect(content.memberships[0].application).toBe('m.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-3', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'org.matrix.msc3401.call',
      call_id: 'join-call-3',
      expires_ts: NOW + 3603000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-3');
    expect(content.memberships[0].application).toBe('org.matrix.msc3401.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-4', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'm.call',
      call_id: 'join-call-4',
      expires_ts: NOW + 3604000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-4');
    expect(content.memberships[0].application).toBe('m.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-5', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'org.matrix.msc3401.call',
      call_id: 'join-call-5',
      expires_ts: NOW + 3605000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-5');
    expect(content.memberships[0].application).toBe('org.matrix.msc3401.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-6', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'm.call',
      call_id: 'join-call-6',
      expires_ts: NOW + 3606000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-6');
    expect(content.memberships[0].application).toBe('m.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-7', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'org.matrix.msc3401.call',
      call_id: 'join-call-7',
      expires_ts: NOW + 3607000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-7');
    expect(content.memberships[0].application).toBe('org.matrix.msc3401.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-8', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'm.call',
      call_id: 'join-call-8',
      expires_ts: NOW + 3608000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-8');
    expect(content.memberships[0].application).toBe('m.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-9', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'org.matrix.msc3401.call',
      call_id: 'join-call-9',
      expires_ts: NOW + 3609000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-9');
    expect(content.memberships[0].application).toBe('org.matrix.msc3401.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-10', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'm.call',
      call_id: 'join-call-10',
      expires_ts: NOW + 3610000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-10');
    expect(content.memberships[0].application).toBe('m.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-11', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'org.matrix.msc3401.call',
      call_id: 'join-call-11',
      expires_ts: NOW + 3611000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-11');
    expect(content.memberships[0].application).toBe('org.matrix.msc3401.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-12', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'm.call',
      call_id: 'join-call-12',
      expires_ts: NOW + 3612000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-12');
    expect(content.memberships[0].application).toBe('m.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-13', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'org.matrix.msc3401.call',
      call_id: 'join-call-13',
      expires_ts: NOW + 3613000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-13');
    expect(content.memberships[0].application).toBe('org.matrix.msc3401.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-14', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'm.call',
      call_id: 'join-call-14',
      expires_ts: NOW + 3614000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-14');
    expect(content.memberships[0].application).toBe('m.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-15', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'org.matrix.msc3401.call',
      call_id: 'join-call-15',
      expires_ts: NOW + 3615000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-15');
    expect(content.memberships[0].application).toBe('org.matrix.msc3401.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-16', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'm.call',
      call_id: 'join-call-16',
      expires_ts: NOW + 3616000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-16');
    expect(content.memberships[0].application).toBe('m.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-17', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'org.matrix.msc3401.call',
      call_id: 'join-call-17',
      expires_ts: NOW + 3617000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-17');
    expect(content.memberships[0].application).toBe('org.matrix.msc3401.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-18', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'm.call',
      call_id: 'join-call-18',
      expires_ts: NOW + 3618000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-18');
    expect(content.memberships[0].application).toBe('m.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-19', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'org.matrix.msc3401.call',
      call_id: 'join-call-19',
      expires_ts: NOW + 3619000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-19');
    expect(content.memberships[0].application).toBe('org.matrix.msc3401.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-20', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'm.call',
      call_id: 'join-call-20',
      expires_ts: NOW + 3620000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-20');
    expect(content.memberships[0].application).toBe('m.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-21', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'org.matrix.msc3401.call',
      call_id: 'join-call-21',
      expires_ts: NOW + 3621000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-21');
    expect(content.memberships[0].application).toBe('org.matrix.msc3401.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-22', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'm.call',
      call_id: 'join-call-22',
      expires_ts: NOW + 3622000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-22');
    expect(content.memberships[0].application).toBe('m.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('PUT join call soft-23', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(env, CALL_PATH, jsonInit('PUT', {
      application: 'org.matrix.msc3401.call',
      call_id: 'join-call-23',
      expires_ts: NOW + 3623000,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ call_id: string; application: string }>;
    };
    expect(content.memberships[0].call_id).toBe('join-call-23');
    expect(content.memberships[0].application).toBe('org.matrix.msc3401.call');
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalled();
  });

});

describe('voip leftovers PUT call edges after #157', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('PUT M_NOT_JSON soft-0', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('PUT M_NOT_JSON soft-1', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('PUT M_NOT_JSON soft-2', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('PUT M_NOT_JSON soft-3', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'undefined',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('PUT M_NOT_JSON soft-4', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{device_id:',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('PUT M_NOT_JSON soft-5', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{,}',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('PUT M_NOT_JSON soft-6', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{a:1}',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('PUT M_NOT_JSON soft-7', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'NaN',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('PUT M_NOT_JSON soft-8', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{broken:',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('PUT M_NOT_JSON soft-9', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'trailing',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('PUT M_NOT_JSON soft-10', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{unclosed',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('PUT M_NOT_JSON soft-11', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('PUT forbidden membership=leave soft-0', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const res = await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('PUT forbidden membership=invite soft-1', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const res = await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('PUT forbidden membership=ban soft-2', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
    });
    const res = await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('PUT forbidden membership=knock soft-3', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
    });
    const res = await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('PUT forbidden membership=leave soft-4', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const res = await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('PUT forbidden membership=invite soft-5', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const res = await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('PUT forbidden membership=ban soft-6', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
    });
    const res = await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('PUT forbidden membership=knock soft-7', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
    });
    const res = await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('PUT update existing device soft-0', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'old-0', expires_ts: NOW + 1 },
          { device_id: 'KEEP0', call_id: 'keep', expires_ts: NOW + 1 },
        ]),
      ],
    });
    await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {
      call_id: 'new-0', expires_ts: NOW + 999,
    }));
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string; call_id: string }>;
    };
    expect(content.memberships).toHaveLength(2);
    expect(content.memberships.find((m) => m.device_id === 'DEVICEA')?.call_id).toBe('new-0');
    expect(content.memberships.find((m) => m.device_id === 'KEEP0')?.call_id).toBe('keep');
  });

  it('PUT update existing device soft-1', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'old-1', expires_ts: NOW + 1 },
          { device_id: 'KEEP1', call_id: 'keep', expires_ts: NOW + 1 },
        ]),
      ],
    });
    await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {
      call_id: 'new-1', expires_ts: NOW + 1000,
    }));
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string; call_id: string }>;
    };
    expect(content.memberships).toHaveLength(2);
    expect(content.memberships.find((m) => m.device_id === 'DEVICEA')?.call_id).toBe('new-1');
    expect(content.memberships.find((m) => m.device_id === 'KEEP1')?.call_id).toBe('keep');
  });

  it('PUT update existing device soft-2', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'old-2', expires_ts: NOW + 1 },
          { device_id: 'KEEP2', call_id: 'keep', expires_ts: NOW + 1 },
        ]),
      ],
    });
    await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {
      call_id: 'new-2', expires_ts: NOW + 1001,
    }));
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string; call_id: string }>;
    };
    expect(content.memberships).toHaveLength(2);
    expect(content.memberships.find((m) => m.device_id === 'DEVICEA')?.call_id).toBe('new-2');
    expect(content.memberships.find((m) => m.device_id === 'KEEP2')?.call_id).toBe('keep');
  });

  it('PUT update existing device soft-3', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'old-3', expires_ts: NOW + 1 },
          { device_id: 'KEEP3', call_id: 'keep', expires_ts: NOW + 1 },
        ]),
      ],
    });
    await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {
      call_id: 'new-3', expires_ts: NOW + 1002,
    }));
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string; call_id: string }>;
    };
    expect(content.memberships).toHaveLength(2);
    expect(content.memberships.find((m) => m.device_id === 'DEVICEA')?.call_id).toBe('new-3');
    expect(content.memberships.find((m) => m.device_id === 'KEEP3')?.call_id).toBe('keep');
  });

  it('PUT update existing device soft-4', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'old-4', expires_ts: NOW + 1 },
          { device_id: 'KEEP4', call_id: 'keep', expires_ts: NOW + 1 },
        ]),
      ],
    });
    await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {
      call_id: 'new-4', expires_ts: NOW + 1003,
    }));
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string; call_id: string }>;
    };
    expect(content.memberships).toHaveLength(2);
    expect(content.memberships.find((m) => m.device_id === 'DEVICEA')?.call_id).toBe('new-4');
    expect(content.memberships.find((m) => m.device_id === 'KEEP4')?.call_id).toBe('keep');
  });

  it('PUT update existing device soft-5', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'old-5', expires_ts: NOW + 1 },
          { device_id: 'KEEP5', call_id: 'keep', expires_ts: NOW + 1 },
        ]),
      ],
    });
    await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {
      call_id: 'new-5', expires_ts: NOW + 1004,
    }));
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string; call_id: string }>;
    };
    expect(content.memberships).toHaveLength(2);
    expect(content.memberships.find((m) => m.device_id === 'DEVICEA')?.call_id).toBe('new-5');
    expect(content.memberships.find((m) => m.device_id === 'KEEP5')?.call_id).toBe('keep');
  });

  it('PUT update existing device soft-6', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'old-6', expires_ts: NOW + 1 },
          { device_id: 'KEEP6', call_id: 'keep', expires_ts: NOW + 1 },
        ]),
      ],
    });
    await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {
      call_id: 'new-6', expires_ts: NOW + 1005,
    }));
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string; call_id: string }>;
    };
    expect(content.memberships).toHaveLength(2);
    expect(content.memberships.find((m) => m.device_id === 'DEVICEA')?.call_id).toBe('new-6');
    expect(content.memberships.find((m) => m.device_id === 'KEEP6')?.call_id).toBe('keep');
  });

  it('PUT update existing device soft-7', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'old-7', expires_ts: NOW + 1 },
          { device_id: 'KEEP7', call_id: 'keep', expires_ts: NOW + 1 },
        ]),
      ],
    });
    await request(createEnv({ db }), CALL_PATH, jsonInit('PUT', {
      call_id: 'new-7', expires_ts: NOW + 1006,
    }));
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string; call_id: string }>;
    };
    expect(content.memberships).toHaveLength(2);
    expect(content.memberships.find((m) => m.device_id === 'DEVICEA')?.call_id).toBe('new-7');
    expect(content.memberships.find((m) => m.device_id === 'KEEP7')?.call_id).toBe('keep');
  });

});

describe('voip leftovers DELETE call soft flood after #157', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('DELETE leave device soft-0', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a0' },
          { device_id: 'KEEP0', call_id: 'b0' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP0']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-1', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a1' },
          { device_id: 'KEEP1', call_id: 'b1' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP1']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-2', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a2' },
          { device_id: 'KEEP2', call_id: 'b2' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP2']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-3', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a3' },
          { device_id: 'KEEP3', call_id: 'b3' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP3']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-4', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a4' },
          { device_id: 'KEEP4', call_id: 'b4' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP4']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-5', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a5' },
          { device_id: 'KEEP5', call_id: 'b5' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP5']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-6', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a6' },
          { device_id: 'KEEP6', call_id: 'b6' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP6']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-7', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a7' },
          { device_id: 'KEEP7', call_id: 'b7' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP7']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-8', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a8' },
          { device_id: 'KEEP8', call_id: 'b8' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP8']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-9', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a9' },
          { device_id: 'KEEP9', call_id: 'b9' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP9']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-10', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a10' },
          { device_id: 'KEEP10', call_id: 'b10' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP10']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-11', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a11' },
          { device_id: 'KEEP11', call_id: 'b11' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP11']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-12', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a12' },
          { device_id: 'KEEP12', call_id: 'b12' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP12']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-13', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a13' },
          { device_id: 'KEEP13', call_id: 'b13' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP13']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-14', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a14' },
          { device_id: 'KEEP14', call_id: 'b14' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP14']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-15', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a15' },
          { device_id: 'KEEP15', call_id: 'b15' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP15']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-16', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a16' },
          { device_id: 'KEEP16', call_id: 'b16' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP16']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-17', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a17' },
          { device_id: 'KEEP17', call_id: 'b17' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP17']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-18', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a18' },
          { device_id: 'KEEP18', call_id: 'b18' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP18']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE leave device soft-19', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a19' },
          { device_id: 'KEEP19', call_id: 'b19' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['KEEP19']);
    expect(db.events).toHaveLength(1);
  });

  it('DELETE noop no state soft-0', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.events).toHaveLength(0);
  });

  it('DELETE noop no state soft-1', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.events).toHaveLength(0);
  });

  it('DELETE noop no state soft-2', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.events).toHaveLength(0);
  });

  it('DELETE noop no state soft-3', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.events).toHaveLength(0);
  });

  it('DELETE noop no state soft-4', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.events).toHaveLength(0);
  });

  it('DELETE noop no state soft-5', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.events).toHaveLength(0);
  });

  it('DELETE noop no state soft-6', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.events).toHaveLength(0);
  });

  it('DELETE noop no state soft-7', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.events).toHaveLength(0);
  });

  it('DELETE noop no state soft-8', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.events).toHaveLength(0);
  });

  it('DELETE noop no state soft-9', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), CALL_PATH, {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.events).toHaveLength(0);
  });

  it('DELETE device_id query soft-0', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a' },
          { device_id: 'ALT0', call_id: 'b' },
        ]),
      ],
    });
    await request(createEnv({ db }), `${CALL_PATH}?device_id=ALT0`, {
      method: 'DELETE', headers: AUTH,
    });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['DEVICEA']);
  });

  it('DELETE device_id query soft-1', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a' },
          { device_id: 'ALT1', call_id: 'b' },
        ]),
      ],
    });
    await request(createEnv({ db }), `${CALL_PATH}?device_id=ALT1`, {
      method: 'DELETE', headers: AUTH,
    });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['DEVICEA']);
  });

  it('DELETE device_id query soft-2', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a' },
          { device_id: 'ALT2', call_id: 'b' },
        ]),
      ],
    });
    await request(createEnv({ db }), `${CALL_PATH}?device_id=ALT2`, {
      method: 'DELETE', headers: AUTH,
    });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['DEVICEA']);
  });

  it('DELETE device_id query soft-3', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a' },
          { device_id: 'ALT3', call_id: 'b' },
        ]),
      ],
    });
    await request(createEnv({ db }), `${CALL_PATH}?device_id=ALT3`, {
      method: 'DELETE', headers: AUTH,
    });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['DEVICEA']);
  });

  it('DELETE device_id query soft-4', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a' },
          { device_id: 'ALT4', call_id: 'b' },
        ]),
      ],
    });
    await request(createEnv({ db }), `${CALL_PATH}?device_id=ALT4`, {
      method: 'DELETE', headers: AUTH,
    });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['DEVICEA']);
  });

  it('DELETE device_id query soft-5', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a' },
          { device_id: 'ALT5', call_id: 'b' },
        ]),
      ],
    });
    await request(createEnv({ db }), `${CALL_PATH}?device_id=ALT5`, {
      method: 'DELETE', headers: AUTH,
    });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['DEVICEA']);
  });

  it('DELETE device_id query soft-6', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a' },
          { device_id: 'ALT6', call_id: 'b' },
        ]),
      ],
    });
    await request(createEnv({ db }), `${CALL_PATH}?device_id=ALT6`, {
      method: 'DELETE', headers: AUTH,
    });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['DEVICEA']);
  });

  it('DELETE device_id query soft-7', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a' },
          { device_id: 'ALT7', call_id: 'b' },
        ]),
      ],
    });
    await request(createEnv({ db }), `${CALL_PATH}?device_id=ALT7`, {
      method: 'DELETE', headers: AUTH,
    });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['DEVICEA']);
  });

});

describe('voip leftovers roomId path charset soft flood after #157', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('roomId charset soft-0', async () => {
    const roomId = '!room:example.com';
    const db = createVoipDb({
      memberships: [joinMember(roomId)],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }], roomId)],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/call`;
    const res = await request(createEnv({ db }), path, { headers: AUTH });
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args[0]).toBe('!room:example.com');
  });

  it('roomId charset soft-1', async () => {
    const roomId = '!room_alt:example.com';
    const db = createVoipDb({
      memberships: [joinMember(roomId)],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }], roomId)],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/call`;
    const res = await request(createEnv({ db }), path, { headers: AUTH });
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args[0]).toBe('!room_alt:example.com');
  });

  it('roomId charset soft-2', async () => {
    const roomId = '!ROOM:example.com';
    const db = createVoipDb({
      memberships: [joinMember(roomId)],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }], roomId)],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/call`;
    const res = await request(createEnv({ db }), path, { headers: AUTH });
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args[0]).toBe('!ROOM:example.com');
  });

  it('roomId charset soft-3', async () => {
    const roomId = '!r0om:example.com';
    const db = createVoipDb({
      memberships: [joinMember(roomId)],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }], roomId)],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/call`;
    const res = await request(createEnv({ db }), path, { headers: AUTH });
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args[0]).toBe('!r0om:example.com');
  });

  it('roomId charset soft-4', async () => {
    const roomId = '!room-1:example.com';
    const db = createVoipDb({
      memberships: [joinMember(roomId)],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }], roomId)],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/call`;
    const res = await request(createEnv({ db }), path, { headers: AUTH });
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args[0]).toBe('!room-1:example.com');
  });

  it('roomId charset soft-5', async () => {
    const roomId = '!room.2:example.com';
    const db = createVoipDb({
      memberships: [joinMember(roomId)],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }], roomId)],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/call`;
    const res = await request(createEnv({ db }), path, { headers: AUTH });
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args[0]).toBe('!room.2:example.com');
  });

  it('roomId charset soft-6', async () => {
    const roomId = '!room_3:example.com';
    const db = createVoipDb({
      memberships: [joinMember(roomId)],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }], roomId)],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/call`;
    const res = await request(createEnv({ db }), path, { headers: AUTH });
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args[0]).toBe('!room_3:example.com');
  });

  it('roomId charset soft-7', async () => {
    const roomId = '!room4:example.com';
    const db = createVoipDb({
      memberships: [joinMember(roomId)],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }], roomId)],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/call`;
    const res = await request(createEnv({ db }), path, { headers: AUTH });
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args[0]).toBe('!room4:example.com');
  });

});

describe('voip leftovers lifecycle PUT-GET-DELETE soft flood after #157', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('lifecycle PUT-GET-DELETE soft-0', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-0', expires_ts: NOW + 5000,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-0');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-1', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-1', expires_ts: NOW + 5001,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-1');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-2', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-2', expires_ts: NOW + 5002,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-2');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-3', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-3', expires_ts: NOW + 5003,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-3');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-4', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-4', expires_ts: NOW + 5004,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-4');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-5', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-5', expires_ts: NOW + 5005,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-5');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-6', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-6', expires_ts: NOW + 5006,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-6');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-7', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-7', expires_ts: NOW + 5007,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-7');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-8', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-8', expires_ts: NOW + 5008,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-8');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-9', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-9', expires_ts: NOW + 5009,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-9');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-10', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-10', expires_ts: NOW + 5010,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-10');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-11', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-11', expires_ts: NOW + 5011,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-11');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-12', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-12', expires_ts: NOW + 5012,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-12');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-13', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-13', expires_ts: NOW + 5013,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-13');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-14', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-14', expires_ts: NOW + 5014,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-14');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

  it('lifecycle PUT-GET-DELETE soft-15', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const putRes = await request(env, CALL_PATH, jsonInit('PUT', {
      call_id: 'life-15', expires_ts: NOW + 5015,
    }));
    expect(putRes.status).toBe(200);
    const getRes = await request(env, CALL_PATH, { headers: AUTH });
    expect(getRes.status).toBe(200);
    expect((getRes.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe('life-15');
    const delRes = await request(env, CALL_PATH, { method: 'DELETE', headers: AUTH });
    expect(delRes.status).toBe(200);
    const getAfter = await request(env, CALL_PATH, { headers: AUTH });
    expect(getAfter.status).toBe(404);
  });

});