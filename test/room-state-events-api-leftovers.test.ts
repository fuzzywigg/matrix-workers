/**
 * TOKENMAXX HEAVY leftovers — room state / timeline state-event API edges.
 * Orthogonal to rooms-api-routes, rooms-api-route-leftovers, sync soft floods,
 * oauth-push-identity, voip-rtc, spaces-search, keys-media-appservice,
 * admin-federation, login-qr.
 * Focus: power-level edges, state-key collisions (M_CONFLICT), redaction paths.
 * Tests-only — no product inventing. Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

const createRoom = vi.fn();
const getRoom = vi.fn();
const storeEvent = vi.fn();
const storeEventIdempotent = vi.fn();
const getRoomState = vi.fn();
const getStateEvent = vi.fn();
const getRoomEvents = vi.fn();
const updateMembership = vi.fn();
const tryInsertJoinMembership = vi.fn();
const getMembership = vi.fn();
const getUserRooms = vi.fn();
const getRoomMembers = vi.fn();
const createRoomAlias = vi.fn();
const getRoomByAlias = vi.fn();
const deleteRoomAlias = vi.fn();
const getEvent = vi.fn();
const notifyUsersOfEvent = vi.fn();
const validateEventSize = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    createRoom: (...args: unknown[]) => createRoom(...args),
    getRoom: (...args: unknown[]) => getRoom(...args),
    storeEvent: (...args: unknown[]) => storeEvent(...args),
    storeEventIdempotent: (...args: unknown[]) => storeEventIdempotent(...args),
    getRoomState: (...args: unknown[]) => getRoomState(...args),
    getStateEvent: (...args: unknown[]) => getStateEvent(...args),
    getRoomEvents: (...args: unknown[]) => getRoomEvents(...args),
    updateMembership: (...args: unknown[]) => updateMembership(...args),
    tryInsertJoinMembership: (...args: unknown[]) => tryInsertJoinMembership(...args),
    getMembership: (...args: unknown[]) => getMembership(...args),
    getUserRooms: (...args: unknown[]) => getUserRooms(...args),
    getRoomMembers: (...args: unknown[]) => getRoomMembers(...args),
    createRoomAlias: (...args: unknown[]) => createRoomAlias(...args),
    getRoomByAlias: (...args: unknown[]) => getRoomByAlias(...args),
    deleteRoomAlias: (...args: unknown[]) => deleteRoomAlias(...args),
    getEvent: (...args: unknown[]) => getEvent(...args),
    notifyUsersOfEvent: (...args: unknown[]) => notifyUsersOfEvent(...args),
    validateEventSize: (...args: unknown[]) => validateEventSize(...args),
  };
});

const bumpRoomCacheGeneration = vi.fn(async () => undefined);
const invalidateRoomCache = vi.fn(async () => undefined);

vi.mock('../src/services/room-cache', () => ({
  bumpRoomCacheGeneration: (...args: unknown[]) => bumpRoomCacheGeneration(...args),
  invalidateRoomCache: (...args: unknown[]) => invalidateRoomCache(...args),
}));

const generateRoomId = vi.fn(async () => '!newroom:example.com');
const generateEventId = vi.fn(async () => '$evt:example.com');
const generateDeterministicEventId = vi.fn(async () => '$detjoin:example.com');

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateRoomId: (...args: unknown[]) => generateRoomId(...args),
    generateEventId: (...args: unknown[]) => generateEventId(...args),
    generateDeterministicEventId: (...args: unknown[]) => generateDeterministicEventId(...args),
  };
});

import rooms from '../src/api/rooms';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const EVENT = '$msg1:example.com';
const EVENT_ENC = encodeURIComponent(EVENT);
const NOW = 1_700_000_000_000;

type SqlCall = { sql: string; args: unknown[] };
type Membership = { membership: string; eventId: string };
type StateMap = Record<string, PDU | null>;

function createSqlDb() {
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  let streamPosition = 10;
  return {
    inserts,
    updates,
    deletes,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('UPDATE stream_positions') && sql.includes('RETURNING position')) {
                streamPosition += args[0] as number;
                return { position: streamPosition } as T;
              }
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              if (sql.trimStart().startsWith('INSERT')) inserts.push({ sql, args });
              else if (sql.trimStart().startsWith('UPDATE')) updates.push({ sql, args });
              else if (sql.trimStart().startsWith('DELETE')) deletes.push({ sql, args });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(stmts: unknown[]) {
      return stmts.map(() => ({ success: true }));
    },
  };
}

type SqlDb = ReturnType<typeof createSqlDb>;

function mockKv() {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function createExecCtx() {
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) {
      waitUntilPromises.push(p);
    },
    passThroughOnException() {},
    props: {},
    waitUntilPromises,
  };
}

function envFor(db: SqlDb): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
    SESSIONS: mockKv(),
    DEVICE_KEYS: mockKv(),
    ONE_TIME_KEYS: mockKv(),
    CROSS_SIGNING_KEYS: mockKv(),
    CACHE: mockKv(),
    ACCOUNT_DATA: mockKv(),
    MEDIA: {} as R2Bucket,
    ROOM: { idFromName: () => ({}) as DurableObjectId, get: () => ({}) as DurableObjectStub },
    SYNC: { idFromName: () => ({}) as DurableObjectId, get: () => ({}) as DurableObjectStub },
    FEDERATION: { idFromName: () => ({}) as DurableObjectId, get: () => ({}) as DurableObjectStub },
    CALL_ROOM: { idFromName: () => ({}) as DurableObjectId, get: () => ({}) as DurableObjectStub },
    ADMIN: { idFromName: () => ({}) as DurableObjectId, get: () => ({}) as DurableObjectStub },
    USER_KEYS: { idFromName: () => ({}) as DurableObjectId, get: () => ({}) as DurableObjectStub },
    PUSH: { idFromName: () => ({}) as DurableObjectId, get: () => ({}) as DurableObjectStub },
    RATE_LIMIT: { idFromName: () => ({}) as DurableObjectId, get: () => ({}) as DurableObjectStub },
  } as unknown as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  db: SqlDb = createSqlDb()
): Promise<{ status: number; body: unknown; db: SqlDb }> {
  const env = envFor(db);
  const res = await rooms.request(`http://localhost${path}`, init, env, createExecCtx() as never);
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, db };
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

function joinMembership(eventId = '$alice-join'): Membership {
  return { membership: 'join', eventId };
}

function pdu(overrides: Partial<PDU> & { type: string; event_id: string }): PDU {
  return {
    room_id: ROOM,
    sender: USER,
    content: {},
    origin_server_ts: NOW,
    depth: 1,
    auth_events: [],
    prev_events: [],
    ...overrides,
  };
}

function defaultState(overrides: StateMap = {}): void {
  getStateEvent.mockImplementation(async (_db, _room, type: string, stateKey = '') => {
    const key = stateKey ? `${type}\0${stateKey}` : type;
    if (key in overrides) return overrides[key];
    if (type in overrides) return overrides[type];
    const defaults: StateMap = {
      'm.room.create': pdu({
        type: 'm.room.create',
        event_id: '$create',
        content: { creator: USER, room_version: '10' },
        state_key: '',
      }),
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: {
          users: { [USER]: 100 },
          users_default: 0,
          state_default: 50,
          events_default: 0,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 50,
        },
        state_key: '',
      }),
    };
    return defaults[type] ?? null;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  createRoom.mockReset().mockResolvedValue(undefined);
  getRoom.mockReset();
  storeEvent.mockReset().mockResolvedValue(1);
  storeEventIdempotent.mockReset().mockResolvedValue({ inserted: true, eventId: '$det' });
  getRoomState.mockReset().mockResolvedValue([]);
  getStateEvent.mockReset();
  getRoomEvents.mockReset().mockResolvedValue({ events: [], end: 0 });
  updateMembership.mockReset().mockResolvedValue(undefined);
  tryInsertJoinMembership.mockReset().mockResolvedValue({ inserted: true, eventId: '$det' });
  getMembership.mockReset();
  getUserRooms.mockReset().mockResolvedValue([]);
  getRoomMembers.mockReset().mockResolvedValue([]);
  createRoomAlias.mockReset().mockResolvedValue(undefined);
  getRoomByAlias.mockReset().mockResolvedValue(null);
  deleteRoomAlias.mockReset().mockResolvedValue(undefined);
  getEvent.mockReset();
  notifyUsersOfEvent.mockReset().mockResolvedValue(undefined);
  validateEventSize.mockReset();
  bumpRoomCacheGeneration.mockReset().mockResolvedValue(undefined);
  invalidateRoomCache.mockReset().mockResolvedValue(undefined);
  generateRoomId.mockReset().mockResolvedValue('!newroom:example.com');
  generateEventId.mockReset().mockResolvedValue('$evt:example.com');
  generateDeterministicEventId.mockReset().mockResolvedValue('$detjoin:example.com');
  defaultState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('room-state leftovers — GET state membership + content pins', () => {
  it('forbids GET full state when membership is invite', async () => {
    getMembership.mockResolvedValue({ membership: 'invite', eventId: '$i' });
    const { status, body } = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/state`);
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'Not a member of this room' });
  });

  it('forbids GET full state when membership is leave', async () => {
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$l' });
    const { status } = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/state`);
    expect(status).toBe(403);
  });

  it('forbids GET full state when membership is null', async () => {
    getMembership.mockResolvedValue(null);
    const { status } = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/state`);
    expect(status).toBe(403);
  });

  it('returns mapped client fields for full state including empty state_key', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomState.mockResolvedValue([
      pdu({ type: 'm.room.name', event_id: '$n', state_key: '', content: { name: 'Lobby' } }),
      pdu({
        type: 'm.room.member',
        event_id: '$m',
        state_key: BOB,
        sender: BOB,
        content: { membership: 'join' },
      }),
    ]);
    const { status, body } = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/state`);
    expect(status).toBe(200);
    expect(body).toEqual([
      {
        type: 'm.room.name',
        state_key: '',
        content: { name: 'Lobby' },
        sender: USER,
        origin_server_ts: NOW,
        event_id: '$n',
        room_id: ROOM,
      },
      {
        type: 'm.room.member',
        state_key: BOB,
        content: { membership: 'join' },
        sender: BOB,
        origin_server_ts: NOW,
        event_id: '$m',
        room_id: ROOM,
      },
    ]);
  });

  it('GET specific state uses empty string when stateKey omitted', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getStateEvent.mockImplementation(async (_db, _r, type, stateKey = '') => {
      expect(type).toBe('m.room.topic');
      expect(stateKey).toBe('');
      return pdu({ type: 'm.room.topic', event_id: '$t', state_key: '', content: { topic: 'hi' } });
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ topic: 'hi' });
  });

  it('GET specific state returns content-only for encoded member state_key', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getStateEvent.mockImplementation(async (_db, _r, type, stateKey = '') => {
      expect(type).toBe('m.room.member');
      expect(stateKey).toBe(BOB);
      return pdu({
        type: 'm.room.member',
        event_id: '$mb',
        state_key: BOB,
        content: { membership: 'join', displayname: 'Bob' },
      });
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.member/${encodeURIComponent(BOB)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ membership: 'join', displayname: 'Bob' });
  });

  it('GET specific state pins exact not-found error', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getStateEvent.mockResolvedValue(null);
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.avatar`
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'State event not found' });
  });
});

describe('room-state leftovers — PUT power-level edges', () => {
  it('pins exact insufficient PL error for state_default gate', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: { users: { [USER]: 49 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'Nope' })
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Insufficient power level for this state event',
    });
    expect(storeEvent).not.toHaveBeenCalled();
  });

  it('allows state write at exact state_default threshold', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: { users: { [USER]: 50 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'Exact' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ event_id: '$evt:example.com' });
  });

  it('uses events[] override when higher than state_default', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: {
          users: { [USER]: 60 },
          state_default: 50,
          events: { 'm.room.name': 75 },
          users_default: 0,
        },
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'Blocked' })
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'Insufficient power level for this state event' });
  });

  it('uses events[] override when lower than state_default', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: {
          users: { [USER]: 10 },
          state_default: 50,
          events: { 'm.room.topic': 10 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'ok' })
    );
    expect(status).toBe(200);
  });

  it('falls back to users_default when users map omits sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: { users: { [BOB]: 100 }, users_default: 0, state_default: 50 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'x' })
    );
    expect(status).toBe(403);
  });

  it('treats missing power_levels content as empty (defaults to 0 < state_default 50)', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') return null;
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'x' })
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'Insufficient power level for this state event' });
  });
});

describe('room-state leftovers — state-key collision / optimistic concurrency', () => {
  it('pins exact Power levels changed during request conflict message', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let plCalls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        plCalls += 1;
        return pdu({
          type: 'm.room.power_levels',
          event_id: plCalls === 1 ? '$pl-a' : '$pl-b',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'race' })
    );
    expect(status).toBe(409);
    expect(body).toEqual({
      errcode: 'M_CONFLICT',
      error: 'Power levels changed during request; retry',
    });
    expect(storeEvent).not.toHaveBeenCalled();
  });

  it('pins exact slot collision message including type and state_key', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let nameCalls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string, stateKey = '') => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.name' && stateKey === '') {
        nameCalls += 1;
        return pdu({
          type: 'm.room.name',
          event_id: nameCalls === 1 ? '$n1' : '$n2',
          state_key: '',
          content: { name: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'new' })
    );
    expect(status).toBe(409);
    expect(body).toEqual({
      errcode: 'M_CONFLICT',
      error: 'State event m.room.name/ changed during request; retry',
    });
  });

  it('pins member state_key in collision error path', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let memberCalls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string, stateKey = '') => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.member' && stateKey === BOB) {
        memberCalls += 1;
        return pdu({
          type: 'm.room.member',
          event_id: memberCalls === 1 ? '$m1' : '$m2',
          state_key: BOB,
          content: { membership: 'join' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.member/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { membership: 'leave' })
    );
    expect(status).toBe(409);
    expect(body).toEqual({
      errcode: 'M_CONFLICT',
      error: `State event m.room.member/${BOB} changed during request; retry`,
    });
  });

  it('allows concurrent-looking writes when PL and slot event_ids stay stable', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let plCalls = 0;
    let nameCalls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        plCalls += 1;
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl-stable',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.name') {
        nameCalls += 1;
        return pdu({
          type: 'm.room.name',
          event_id: '$n-stable',
          state_key: '',
          content: { name: 'same' },
        });
      }
      return null;
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'ok' })
    );
    expect(status).toBe(200);
    expect(plCalls).toBeGreaterThanOrEqual(2);
    expect(nameCalls).toBeGreaterThanOrEqual(2);
    expect(storeEvent).toHaveBeenCalled();
  });

  it('treats null→event and event→null as slot collisions', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let nameCalls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.name') {
        nameCalls += 1;
        if (nameCalls === 1) return null;
        return pdu({
          type: 'm.room.name',
          event_id: '$appeared',
          state_key: '',
          content: { name: 'race' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'x' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
});

describe('room-state leftovers — PUT state_key + cache + membership side effects', () => {
  it('omitted state_key uses empty-string slot on store', async () => {
    getMembership.mockResolvedValue(joinMembership());
    await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.guest_access`,
      jsonInit('PUT', { guest_access: 'can_join' })
    );
    expect(storeEvent.mock.calls[0][1]).toMatchObject({
      type: 'm.room.guest_access',
      state_key: '',
      content: { guest_access: 'can_join' },
    });
  });

  it('preserves non-empty custom state_key for custom types', async () => {
    getMembership.mockResolvedValue(joinMembership());
    await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/org.example.widget/main`,
      jsonInit('PUT', { url: 'https://example.com/w' })
    );
    expect(storeEvent.mock.calls[0][1]).toMatchObject({
      type: 'org.example.widget',
      state_key: 'main',
    });
  });

  const cachedTypes = [
    'm.room.name',
    'm.room.avatar',
    'm.room.topic',
    'm.room.canonical_alias',
  ] as const;

  for (const type of cachedTypes) {
    it(`bumps cache generation for ${type}`, async () => {
      getMembership.mockResolvedValue(joinMembership());
      await request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/state/${encodeURIComponent(type)}`,
        jsonInit('PUT', { x: 1 })
      );
      expect(bumpRoomCacheGeneration).toHaveBeenCalledWith(expect.anything(), ROOM);
      expect(invalidateRoomCache).toHaveBeenCalledWith(expect.anything(), ROOM);
    });
  }

  it('does not bump cache for non-metadata state types', async () => {
    getMembership.mockResolvedValue(joinMembership());
    await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.join_rules`,
      jsonInit('PUT', { join_rule: 'invite' })
    );
    expect(bumpRoomCacheGeneration).not.toHaveBeenCalled();
  });

  it('updates membership table and bumps cache for member state writes', async () => {
    getMembership.mockResolvedValue(joinMembership());
    await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.member/${encodeURIComponent(CAROL)}`,
      jsonInit('PUT', {
        membership: 'join',
        displayname: 'Carol',
        avatar_url: 'mxc://example.com/c',
      })
    );
    expect(updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      CAROL,
      'join',
      '$evt:example.com',
      'Carol',
      'mxc://example.com/c'
    );
    expect(bumpRoomCacheGeneration).toHaveBeenCalled();
  });

  it('rejects bad JSON on PUT state', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: '{',
      }
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('forbids PUT state for non-join membership', async () => {
    getMembership.mockResolvedValue({ membership: 'knock', eventId: '$k' });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'x' })
    );
    expect(status).toBe(403);
  });
});

describe('room-state leftovers — redaction power / own / reason paths', () => {
  it('forbids redacting others below redact threshold with exact error', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: { users: { [USER]: 49 }, redact: 50, users_default: 0 },
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/txn`,
      jsonInit('PUT', { reason: 'nope' })
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'Insufficient power level to redact' });
  });

  it('allows redacting others at exact redact threshold', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: CAROL,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: { users: { [USER]: 50 }, redact: 50, users_default: 0 },
      }),
    });
    const db = createSqlDb();
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/t50`,
      jsonInit('PUT', {}),
      db
    );
    expect(status).toBe(200);
    expect(storeEvent.mock.calls[0][1]).toMatchObject({
      type: 'm.room.redaction',
      content: { redacts: EVENT },
      redacts: EVENT,
      unsigned: { transaction_id: 't50' },
    });
    expect(db.updates.some((u) => u.sql.includes('redacted_because'))).toBe(true);
  });

  it('allows own-event redaction even with redact power 0', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: { users: { [USER]: 0 }, redact: 100, users_default: 0 },
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/own`,
      jsonInit('PUT', { reason: 'typo' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ event_id: '$evt:example.com' });
    expect(storeEvent.mock.calls[0][1].content).toEqual({
      redacts: EVENT,
      reason: 'typo',
    });
  });

  it('omits reason when body.reason is empty string (falsy)', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/empty-reason`,
      jsonInit('PUT', { reason: '' })
    );
    expect(storeEvent.mock.calls[0][1].content).toEqual({ redacts: EVENT });
  });

  it('404 when target event is in a different room', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        room_id: '!other:example.com',
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/x`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'Event not found' });
  });

  it('can redact a state event (m.room.name) with sufficient PL', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.name',
        event_id: EVENT,
        sender: BOB,
        state_key: '',
        content: { name: 'old' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: { users: { [USER]: 100 }, redact: 50 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/state-redact`,
      jsonInit('PUT', { reason: 'cleanup' })
    );
    expect(status).toBe(200);
    expect(notifyUsersOfEvent).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      '$evt:example.com',
      'm.room.redaction'
    );
  });

  it('defaults redact threshold to 50 when PL event lacks redact field', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: { users: { [USER]: 49 }, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/def`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
  });

  it('forbids redact when not joined', async () => {
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$l' });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/t`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
  });
});

describe('room-state leftovers — PUT PL soft flood', () => {
  it('PL soft-0: users=40 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-0',
        state_key: '',
        content: { users: { [USER]: 40 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n0' })
    );
    expect(status).toBe(403);
  });
  it('PL soft-1: users=41 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-1',
        state_key: '',
        content: { users: { [USER]: 41 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n1' })
    );
    expect(status).toBe(403);
  });
  it('PL soft-2: users=42 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-2',
        state_key: '',
        content: { users: { [USER]: 42 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n2' })
    );
    expect(status).toBe(403);
  });
  it('PL soft-3: users=43 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-3',
        state_key: '',
        content: { users: { [USER]: 43 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n3' })
    );
    expect(status).toBe(403);
  });
  it('PL soft-4: users=44 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-4',
        state_key: '',
        content: { users: { [USER]: 44 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n4' })
    );
    expect(status).toBe(403);
  });
  it('PL soft-5: users=45 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-5',
        state_key: '',
        content: { users: { [USER]: 45 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n5' })
    );
    expect(status).toBe(403);
  });
  it('PL soft-6: users=46 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-6',
        state_key: '',
        content: { users: { [USER]: 46 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n6' })
    );
    expect(status).toBe(403);
  });
  it('PL soft-7: users=47 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-7',
        state_key: '',
        content: { users: { [USER]: 47 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n7' })
    );
    expect(status).toBe(403);
  });
  it('PL soft-8: users=48 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-8',
        state_key: '',
        content: { users: { [USER]: 48 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n8' })
    );
    expect(status).toBe(403);
  });
  it('PL soft-9: users=49 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-9',
        state_key: '',
        content: { users: { [USER]: 49 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n9' })
    );
    expect(status).toBe(403);
  });
  it('PL soft-10: users=50 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-10',
        state_key: '',
        content: { users: { [USER]: 50 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n10' })
    );
    expect(status).toBe(200);
  });
  it('PL soft-11: users=51 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-11',
        state_key: '',
        content: { users: { [USER]: 51 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n11' })
    );
    expect(status).toBe(200);
  });
  it('PL soft-12: users=52 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-12',
        state_key: '',
        content: { users: { [USER]: 52 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n12' })
    );
    expect(status).toBe(200);
  });
  it('PL soft-13: users=53 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-13',
        state_key: '',
        content: { users: { [USER]: 53 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n13' })
    );
    expect(status).toBe(200);
  });
  it('PL soft-14: users=54 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-14',
        state_key: '',
        content: { users: { [USER]: 54 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n14' })
    );
    expect(status).toBe(200);
  });
  it('PL soft-15: users=55 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-15',
        state_key: '',
        content: { users: { [USER]: 55 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n15' })
    );
    expect(status).toBe(200);
  });
  it('PL soft-16: users=56 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-16',
        state_key: '',
        content: { users: { [USER]: 56 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n16' })
    );
    expect(status).toBe(200);
  });
  it('PL soft-17: users=57 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-17',
        state_key: '',
        content: { users: { [USER]: 57 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n17' })
    );
    expect(status).toBe(200);
  });
  it('PL soft-18: users=58 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-18',
        state_key: '',
        content: { users: { [USER]: 58 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n18' })
    );
    expect(status).toBe(200);
  });
  it('PL soft-19: users=59 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-19',
        state_key: '',
        content: { users: { [USER]: 59 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n19' })
    );
    expect(status).toBe(200);
  });
  it('PL soft-20: users=40 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-20',
        state_key: '',
        content: { users: { [USER]: 40 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n20' })
    );
    expect(status).toBe(403);
  });
  it('PL soft-21: users=41 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-21',
        state_key: '',
        content: { users: { [USER]: 41 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n21' })
    );
    expect(status).toBe(403);
  });
  it('PL soft-22: users=42 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-22',
        state_key: '',
        content: { users: { [USER]: 42 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n22' })
    );
    expect(status).toBe(403);
  });
  it('PL soft-23: users=43 vs state_default=50', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-23',
        state_key: '',
        content: { users: { [USER]: 43 }, state_default: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'n23' })
    );
    expect(status).toBe(403);
  });
});

describe('room-state leftovers — events[] override soft flood', () => {
  it('events override soft-0: m.room.name need=10 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e0',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.name': 10 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { v: 0 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-1: m.room.topic need=20 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e1',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.topic': 20 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { v: 1 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-2: m.room.avatar need=30 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e2',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.avatar': 30 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.avatar`,
      jsonInit('PUT', { v: 2 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-3: m.room.guest_access need=40 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e3',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.guest_access': 40 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.guest_access`,
      jsonInit('PUT', { v: 3 })
    );
    expect(status).toBe(403);
  });
  it('events override soft-4: m.room.history_visibility need=50 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e4',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.history_visibility': 50 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.history_visibility`,
      jsonInit('PUT', { v: 4 })
    );
    expect(status).toBe(403);
  });
  it('events override soft-5: m.room.join_rules need=10 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e5',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.join_rules': 10 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.join_rules`,
      jsonInit('PUT', { v: 5 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-6: org.example.a need=20 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e6',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'org.example.a': 20 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/org.example.a`,
      jsonInit('PUT', { v: 6 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-7: org.example.b need=30 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e7',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'org.example.b': 30 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/org.example.b`,
      jsonInit('PUT', { v: 7 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-8: m.room.name need=40 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e8',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.name': 40 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { v: 8 })
    );
    expect(status).toBe(403);
  });
  it('events override soft-9: m.room.topic need=50 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e9',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.topic': 50 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { v: 9 })
    );
    expect(status).toBe(403);
  });
  it('events override soft-10: m.room.avatar need=10 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e10',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.avatar': 10 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.avatar`,
      jsonInit('PUT', { v: 10 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-11: m.room.guest_access need=20 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e11',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.guest_access': 20 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.guest_access`,
      jsonInit('PUT', { v: 11 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-12: m.room.history_visibility need=30 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e12',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.history_visibility': 30 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.history_visibility`,
      jsonInit('PUT', { v: 12 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-13: m.room.join_rules need=40 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e13',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.join_rules': 40 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.join_rules`,
      jsonInit('PUT', { v: 13 })
    );
    expect(status).toBe(403);
  });
  it('events override soft-14: org.example.a need=50 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e14',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'org.example.a': 50 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/org.example.a`,
      jsonInit('PUT', { v: 14 })
    );
    expect(status).toBe(403);
  });
  it('events override soft-15: org.example.b need=10 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e15',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'org.example.b': 10 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/org.example.b`,
      jsonInit('PUT', { v: 15 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-16: m.room.name need=20 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e16',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.name': 20 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { v: 16 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-17: m.room.topic need=30 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e17',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.topic': 30 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { v: 17 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-18: m.room.avatar need=40 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e18',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.avatar': 40 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.avatar`,
      jsonInit('PUT', { v: 18 })
    );
    expect(status).toBe(403);
  });
  it('events override soft-19: m.room.guest_access need=50 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e19',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.guest_access': 50 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.guest_access`,
      jsonInit('PUT', { v: 19 })
    );
    expect(status).toBe(403);
  });
  it('events override soft-20: m.room.history_visibility need=10 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e20',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.history_visibility': 10 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.history_visibility`,
      jsonInit('PUT', { v: 20 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-21: m.room.join_rules need=20 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e21',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'm.room.join_rules': 20 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.join_rules`,
      jsonInit('PUT', { v: 21 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-22: org.example.a need=30 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e22',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'org.example.a': 30 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/org.example.a`,
      jsonInit('PUT', { v: 22 })
    );
    expect(status).toBe(200);
  });
  it('events override soft-23: org.example.b need=40 have=30', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-e23',
        state_key: '',
        content: {
          users: { [USER]: 30 },
          state_default: 50,
          events: { 'org.example.b': 40 },
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/org.example.b`,
      jsonInit('PUT', { v: 23 })
    );
    expect(status).toBe(403);
  });
});

describe('room-state leftovers — redact threshold soft flood', () => {
  it('redact soft-0: have=0 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r0',
        state_key: '',
        content: { users: { [USER]: 0 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-0`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
  });
  it('redact soft-1: have=5 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r1',
        state_key: '',
        content: { users: { [USER]: 5 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-1`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
  });
  it('redact soft-2: have=10 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r2',
        state_key: '',
        content: { users: { [USER]: 10 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-2`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
  });
  it('redact soft-3: have=15 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r3',
        state_key: '',
        content: { users: { [USER]: 15 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-3`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
  });
  it('redact soft-4: have=20 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r4',
        state_key: '',
        content: { users: { [USER]: 20 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-4`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
  });
  it('redact soft-5: have=25 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r5',
        state_key: '',
        content: { users: { [USER]: 25 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-5`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
  });
  it('redact soft-6: have=30 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r6',
        state_key: '',
        content: { users: { [USER]: 30 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-6`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
  });
  it('redact soft-7: have=35 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r7',
        state_key: '',
        content: { users: { [USER]: 35 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-7`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
  });
  it('redact soft-8: have=40 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r8',
        state_key: '',
        content: { users: { [USER]: 40 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-8`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
  });
  it('redact soft-9: have=45 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r9',
        state_key: '',
        content: { users: { [USER]: 45 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-9`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
  });
  it('redact soft-10: have=50 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r10',
        state_key: '',
        content: { users: { [USER]: 50 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-10`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(200);
  });
  it('redact soft-11: have=55 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r11',
        state_key: '',
        content: { users: { [USER]: 55 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-11`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(200);
  });
  it('redact soft-12: have=60 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r12',
        state_key: '',
        content: { users: { [USER]: 60 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-12`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(200);
  });
  it('redact soft-13: have=65 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r13',
        state_key: '',
        content: { users: { [USER]: 65 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-13`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(200);
  });
  it('redact soft-14: have=70 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r14',
        state_key: '',
        content: { users: { [USER]: 70 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-14`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(200);
  });
  it('redact soft-15: have=75 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r15',
        state_key: '',
        content: { users: { [USER]: 75 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-15`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(200);
  });
  it('redact soft-16: have=80 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r16',
        state_key: '',
        content: { users: { [USER]: 80 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-16`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(200);
  });
  it('redact soft-17: have=85 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r17',
        state_key: '',
        content: { users: { [USER]: 85 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-17`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(200);
  });
  it('redact soft-18: have=90 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r18',
        state_key: '',
        content: { users: { [USER]: 90 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-18`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(200);
  });
  it('redact soft-19: have=95 need=50 other-sender', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-r19',
        state_key: '',
        content: { users: { [USER]: 95 }, redact: 50, users_default: 0 },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/soft-19`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(200);
  });
});

describe('room-state leftovers — state_key collision soft flood', () => {
  it('slot collision soft-0', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-0' : '$t-b-0',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n0' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-1', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-1' : '$t-b-1',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n1' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-2', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-2' : '$t-b-2',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n2' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-3', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-3' : '$t-b-3',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n3' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-4', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-4' : '$t-b-4',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n4' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-5', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-5' : '$t-b-5',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n5' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-6', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-6' : '$t-b-6',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n6' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-7', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-7' : '$t-b-7',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n7' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-8', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-8' : '$t-b-8',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n8' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-9', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-9' : '$t-b-9',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n9' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-10', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-10' : '$t-b-10',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n10' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-11', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-11' : '$t-b-11',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n11' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-12', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-12' : '$t-b-12',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n12' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-13', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-13' : '$t-b-13',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n13' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-14', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-14' : '$t-b-14',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n14' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
  it('slot collision soft-15', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let calls = 0;
    getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.topic') {
        calls += 1;
        return pdu({
          type: 'm.room.topic',
          event_id: calls === 1 ? '$t-a-15' : '$t-b-15',
          state_key: '',
          content: { topic: 'old' },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 'n15' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
  });
});
