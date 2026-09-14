/**
 * TOKENMAXX HEAVY deepen after #117 — different slice: voip API routes.
 * Avoids sync (#117), rooms (#114), oidc/media (#115/#113), keys leftovers (already heavy).
 * Tests-only — no product inventing.
 * Exercises TURN turnServer + MatrixRTC call membership GET/PUT/DELETE via Hono app.request().
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
      Authorization: 'Bearer t',
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
    event_id: `$call_${userId}`,
    content: JSON.stringify({ memberships }),
    sender: userId,
    origin_server_ts: NOW,
  };
}

// =============================================================================
// GET /_matrix/client/v3/voip/turnServer
// =============================================================================

describe('voip GET /voip/turnServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    turnMocks.getStunServers.mockReturnValue({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 86400,
    });
  });

  it('returns STUN-only when TURN is not configured', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 86400,
    });
    expect(turnMocks.getMatrixTurnCredentials).not.toHaveBeenCalled();
  });

  it('returns TURN credentials when configured', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockResolvedValue({
      username: 'u',
      password: 'p',
      uris: ['turn:turn.example:3478?transport=udp'],
      ttl: 3600,
    });
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'u',
      password: 'p',
      uris: ['turn:turn.example:3478?transport=udp'],
      ttl: 3600,
    });
    expect(turnMocks.getMatrixTurnCredentials).toHaveBeenCalledWith(env, 3600, USER);
  });

  it('returns 429 M_LIMIT_EXCEEDED for USER_RATE_LIMITED with retry_after_ms', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate', 'USER_RATE_LIMITED', 429, 45000)
    );
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many TURN credential requests. Please try again later.',
      retry_after_ms: 45000,
    });
  });

  it('defaults retry_after_ms to 60000 when USER_RATE_LIMITED omits it', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('rate', 'USER_RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(429);
    expect((res.body as { retry_after_ms: number }).retry_after_ms).toBe(60000);
  });

  it('returns 429 for Cloudflare API RATE_LIMITED', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('cf rate', 'RATE_LIMITED', 429)
    );
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'TURN credential requests are rate limited. Please try again later.',
      retry_after_ms: 60000,
    });
  });

  it('degrades to STUN for other TurnError codes (API_ERROR)', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('boom', 'API_ERROR', 500)
    );
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uris: ['stun:stun.cloudflare.com:3478'] });
  });

  it('degrades to STUN for NOT_CONFIGURED TurnError (graceful)', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('missing', 'NOT_CONFIGURED')
    );
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(turnMocks.getStunServers).toHaveBeenCalled();
  });

  it('degrades to STUN for INVALID_RESPONSE TurnError', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(
      new TurnError('bad', 'INVALID_RESPONSE')
    );
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { ttl: number }).ttl).toBe(86400);
  });

  it('degrades to STUN for unexpected non-TurnError throws', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(true);
    turnMocks.getMatrixTurnCredentials.mockRejectedValue(new Error('network'));
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: '', password: '' });
  });
});

// =============================================================================
// GET /_matrix/client/v1/rooms/:roomId/call
// =============================================================================

describe('voip GET /rooms/:roomId/call', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const path = `/_matrix/client/v1/rooms/${ROOM_ENC}/call`;

  it('forbids when membership missing', async () => {
    const db = createVoipDb({ memberships: [] });
    const res = await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it.each(['leave', 'invite', 'ban', 'knock'])(
    'forbids membership=%s (join-only)',
    async (membership) => {
      const db = createVoipDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership }],
      });
      const res = await request(createEnv({ db }), path, {
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(403);
    }
  );

  it('returns 404 when no m.call.member state events', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('returns 404 when all memberships are expired', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', expires_ts: NOW - 1, call_id: 'c1' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });

  it('includes memberships without expires_ts (always valid)', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', application: 'm.call', call_id: 'x' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      call_id: '',
      members: [
        {
          user_id: USER,
          device_id: 'DEVICEA',
          application: 'm.call',
          call_id: 'x',
          expires_ts: undefined,
          foci_active: undefined,
          focus_active: undefined,
        },
      ],
    });
  });

  it('includes non-expired memberships and maps foci fields', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          {
            device_id: 'DEVICEA',
            application: 'm.call',
            call_id: 'cid',
            expires_ts: NOW + 60_000,
            foci_active: [{ type: 'livekit', livekit_alias: 'a' }],
            focus_active: { type: 'livekit', livekit_alias: 'b' },
          },
          { device_id: 'OLD', expires_ts: NOW - 5 },
        ]),
        callMemberState('@bob:example.com', [
          { device_id: 'BOBDEV', expires_ts: NOW + 1, call_id: '' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { members: Array<{ user_id: string; device_id: string }> };
    expect(body.members.map((m) => `${m.user_id}/${m.device_id}`).sort()).toEqual([
      `${USER}/DEVICEA`,
      '@bob:example.com/BOBDEV',
    ]);
    const alice = (res.body as { members: Array<Record<string, unknown>> }).members.find(
      (m) => m.device_id === 'DEVICEA'
    );
    expect(alice).toMatchObject({
      foci_active: [{ type: 'livekit', livekit_alias: 'a' }],
      focus_active: { type: 'livekit', livekit_alias: 'b' },
    });
  });

  it('defaults missing call_id to empty string', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [callMemberState(USER, [{ device_id: 'D1', expires_ts: NOW + 1 }])],
    });
    const res = await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    const members = (res.body as { members: Array<{ call_id: string }> }).members;
    expect(members[0].call_id).toBe('');
  });

  it('skips unparseable state content and still returns valid peers', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: '@bad:example.com',
          event_id: '$bad',
          content: '{not-json',
          sender: '@bad:example.com',
          origin_server_ts: NOW,
        },
        callMemberState(USER, [{ device_id: 'DEVICEA', expires_ts: NOW + 1 }]),
      ],
    });
    const res = await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { members: unknown[] }).members).toHaveLength(1);
  });

  it('treats missing memberships array as empty via || []', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          event_id: '$e',
          content: JSON.stringify({}),
          sender: USER,
          origin_server_ts: NOW,
        },
      ],
    });
    const res = await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });

  it('decodes roomId path param as-is for DB lookup', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    await request(createEnv({ db }), path, {
      headers: { Authorization: 'Bearer t' },
    });
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args[0]).toBe(ROOM);
  });
});

// =============================================================================
// PUT /_matrix/client/v1/rooms/:roomId/call
// =============================================================================

describe('voip PUT /rooms/:roomId/call', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const path = `/_matrix/client/v1/rooms/${ROOM_ENC}/call`;

  it('forbids non-join members', async () => {
    const db = createVoipDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const res = await request(
      createEnv({ db }),
      path,
      jsonInit('PUT', { device_id: 'DEVICEA' })
    );
    expect(res.status).toBe(403);
  });

  it('returns M_NOT_JSON for invalid body', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(createEnv({ db }), path, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_JSON' });
  });

  it('empty-string body.device_id falls through to auth deviceId (||)', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const res = await request(
      createEnv({ db }),
      path,
      jsonInit('PUT', { device_id: '' })
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships[0].device_id).toBe('DEVICEA');
  });

  it('joins call creating new m.call.member state + event + notify', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const env = createEnv({ db });
    const res = await request(
      env,
      path,
      jsonInit('PUT', {
        application: 'm.call',
        call_id: 'cid-1',
        foci_active: [{ type: 'livekit' }],
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    expect(db.state).toHaveLength(1);
    expect(db.events).toHaveLength(1);
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<Record<string, unknown>>;
    };
    expect(content.memberships).toHaveLength(1);
    expect(content.memberships[0]).toMatchObject({
      device_id: 'DEVICEA',
      application: 'm.call',
      call_id: 'cid-1',
      expires_ts: NOW + 3600000,
      foci_active: [{ type: 'livekit' }],
    });
    expect(notifyMock.notifyUsersOfEvent).toHaveBeenCalledWith(
      env,
      ROOM,
      (res.body as { event_id: string }).event_id,
      'm.call.member'
    );
  });

  it('defaults application to m.call and call_id to empty string', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    await request(createEnv({ db }), path, jsonInit('PUT', {}));
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ application: string; call_id: string }>;
    };
    expect(content.memberships[0].application).toBe('m.call');
    expect(content.memberships[0].call_id).toBe('');
  });

  it('updates existing device membership in place', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'old', expires_ts: NOW + 1 },
          { device_id: 'OTHER', call_id: 'keep', expires_ts: NOW + 1 },
        ]),
      ],
    });
    await request(
      createEnv({ db }),
      path,
      jsonInit('PUT', { call_id: 'new', expires_ts: NOW + 999 })
    );
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string; call_id: string; expires_ts: number }>;
    };
    expect(content.memberships).toHaveLength(2);
    expect(content.memberships.find((m) => m.device_id === 'DEVICEA')).toMatchObject({
      call_id: 'new',
      expires_ts: NOW + 999,
    });
    expect(content.memberships.find((m) => m.device_id === 'OTHER')?.call_id).toBe('keep');
  });

  it('appends when device not yet in memberships', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [{ device_id: 'OTHER', call_id: 'x', expires_ts: NOW + 1 }]),
      ],
    });
    await request(
      createEnv({ db }),
      path,
      jsonInit('PUT', { device_id: 'DEVICEA' })
    );
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id).sort()).toEqual(['DEVICEA', 'OTHER']);
  });

  it('recovers from corrupt existing content by starting fresh memberships', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          event_id: '$old',
          content: 'NOT_JSON',
          sender: USER,
          origin_server_ts: NOW,
        },
      ],
    });
    const res = await request(
      createEnv({ db }),
      path,
      jsonInit('PUT', { device_id: 'DEVICEA' })
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships).toEqual([
      expect.objectContaining({ device_id: 'DEVICEA' }),
    ]);
  });

  it('uses body.device_id over auth device when provided', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    await request(
      createEnv({ db }),
      path,
      jsonInit('PUT', { device_id: 'ALTDEV' })
    );
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships[0].device_id).toBe('ALTDEV');
  });

  it('preserves focus_active from body', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    await request(
      createEnv({ db }),
      path,
      jsonInit('PUT', {
        focus_active: { type: 'livekit', livekit_alias: 'focus' },
      })
    );
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ focus_active: unknown }>;
    };
    expect(content.memberships[0].focus_active).toEqual({
      type: 'livekit',
      livekit_alias: 'focus',
    });
  });
});

// =============================================================================
// DELETE /_matrix/client/v1/rooms/:roomId/call
// =============================================================================

describe('voip DELETE /rooms/:roomId/call', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const path = `/_matrix/client/v1/rooms/${ROOM_ENC}/call`;

  it('returns empty object when no existing call membership', async () => {
    const db = createVoipDb({ memberships: [joinMember()], state: [] });
    const res = await request(createEnv({ db }), path, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.events).toHaveLength(0);
  });

  it('removes only the target device and writes event', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a' },
          { device_id: 'KEEP', call_id: 'b' },
        ]),
      ],
    });
    const res = await request(createEnv({ db }), path, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$/) });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships).toEqual([{ device_id: 'KEEP', call_id: 'b' }]);
    expect(db.events).toHaveLength(1);
  });

  it('uses device_id query param over auth device', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'DEVICEA', call_id: 'a' },
          { device_id: 'ALT', call_id: 'b' },
        ]),
      ],
    });
    await request(createEnv({ db }), `${path}?device_id=ALT`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    const content = JSON.parse(db.state[0].content) as {
      memberships: Array<{ device_id: string }>;
    };
    expect(content.memberships.map((m) => m.device_id)).toEqual(['DEVICEA']);
  });

  it('returns empty object when existing content is corrupt JSON', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          event_id: '$x',
          content: '{broken',
          sender: USER,
          origin_server_ts: NOW,
        },
      ],
    });
    const res = await request(createEnv({ db }), path, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.events).toHaveLength(0);
  });

  it('leaves empty memberships array when last device leaves', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [callMemberState(USER, [{ device_id: 'DEVICEA' }])],
    });
    await request(createEnv({ db }), path, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    const content = JSON.parse(db.state[0].content) as { memberships: unknown[] };
    expect(content.memberships).toEqual([]);
  });

  it('treats missing memberships key as empty via || [] then filters', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        {
          room_id: ROOM,
          type: 'm.call.member',
          state_key: USER,
          event_id: '$x',
          content: JSON.stringify({}),
          sender: USER,
          origin_server_ts: NOW,
        },
      ],
    });
    const res = await request(createEnv({ db }), path, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.any(String) });
    const content = JSON.parse(db.state[0].content) as { memberships: unknown[] };
    expect(content.memberships).toEqual([]);
  });
});

// =============================================================================
// TOKENMAXX leftovers — edge combos
// =============================================================================

describe('voip TOKENMAXX leftover edges after #117', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('GET call expires_ts exactly equal to now is treated as expired (not > now)', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW }])],
    });
    const res = await request(
      createEnv({ db }),
      `/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
  });

  it('GET call expires_ts = now+1 is included', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [callMemberState(USER, [{ device_id: 'D', expires_ts: NOW + 1 }])],
    });
    const res = await request(
      createEnv({ db }),
      `/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
  });

  it('PUT then GET round-trips the joined membership', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    await request(
      env,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      jsonInit('PUT', { call_id: 'round', expires_ts: NOW + 5000 })
    );
    const res = await request(env, `/_matrix/client/v1/rooms/${ROOM_ENC}/call`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { members: Array<{ call_id: string }> }).members[0].call_id).toBe(
      'round'
    );
  });

  it('PUT then DELETE then GET returns 404', async () => {
    const db = createVoipDb({ memberships: [joinMember()] });
    const env = createEnv({ db });
    const path = `/_matrix/client/v1/rooms/${ROOM_ENC}/call`;
    await request(env, path, jsonInit('PUT', {}));
    await request(env, path, { method: 'DELETE', headers: { Authorization: 'Bearer t' } });
    const res = await request(env, path, { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(404);
  });

  it('multi-device PUT keeps sibling devices active on GET', async () => {
    const db = createVoipDb({
      memberships: [joinMember()],
      state: [
        callMemberState(USER, [
          { device_id: 'OTHER', expires_ts: NOW + 10_000, call_id: 'o' },
        ]),
      ],
    });
    const env = createEnv({ db });
    await request(
      env,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      jsonInit('PUT', { expires_ts: NOW + 10_000 })
    );
    const res = await request(env, `/_matrix/client/v1/rooms/${ROOM_ENC}/call`, {
      headers: { Authorization: 'Bearer t' },
    });
    const ids = (res.body as { members: Array<{ device_id: string }> }).members.map(
      (m) => m.device_id
    );
    expect(ids.sort()).toEqual(['DEVICEA', 'OTHER']);
  });

  it('turnServer still works after call routes exercised (no shared state leak)', async () => {
    turnMocks.isTurnConfigured.mockReturnValue(false);
    const env = createEnv({
      db: createVoipDb({ memberships: [joinMember()] }),
    });
    await request(
      env,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/call`,
      jsonInit('PUT', {})
    );
    const res = await request(env, '/_matrix/client/v3/voip/turnServer', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ttl: 86400 });
  });
});
