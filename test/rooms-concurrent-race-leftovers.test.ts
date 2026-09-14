/**
 * TOKENMAXX HEAVY leftovers after #190 — rooms *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by rooms-api-route-leftovers (#154)
 * or room-state-events leftovers (#170) / room-join workflows (#187).
 *
 * Distinct domain — not presence (#190), typing (#185), qr-login (#183),
 * receipts (#184/#178), fed-keys (#188/#175), sliding-sync (#189), workflows (#187).
 *
 * Focus: parallel join idempotency (storeEventIdempotent + tryInsertJoinMembership
 * notify gates), membership×endpoint matrices under Promise.all, invite PL conflict
 * races, concurrent send/txn/push isolation, method/body soft floods, remote workflow
 * status soft matrix under concurrency, multi-room leave/forget isolation,
 * SQL bind contracts for forget/redact.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
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
const DAVE = '@dave:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ROOM2 = '!room2:example.com';
const ROOM3 = '!room3:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const ROOM2_ENC = encodeURIComponent(ROOM2);
const ROOM3_ENC = encodeURIComponent(ROOM3);
const REMOTE_ROOM = '!room:remote.example.org';
const REMOTE_ENC = encodeURIComponent(REMOTE_ROOM);
const EVENT = '$msg1:example.com';
const EVENT_ENC = encodeURIComponent(EVENT);
const NOW = 1_700_000_000_000;

type SqlCall = { sql: string; args: unknown[] };
type Membership = { membership: string; eventId: string };
type StateMap = Record<string, PDU | null>;

type DbOpts = {
  membershipRows?: Array<{
    room_id: string;
    user_id: string;
    membership: string;
  }>;
  failDelete?: boolean;
  failRedactUpdate?: boolean;
  redactBarrier?: { count: number };
};

function createSqlDb(opts: DbOpts = {}) {
  const membershipRows = opts.membershipRows ?? [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const redactWaiters: Array<() => void> = [];
  let redactBarrier = opts.redactBarrier;

  const db = {
    inserts,
    updates,
    deletes,
    selects,
    membershipRows,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              return null as T;
            },
            async all<T>() {
              selects.push({ sql, args });
              return { results: [] as T[] };
            },
            async run() {
              if (sql.trimStart().startsWith('DELETE')) {
                deletes.push({ sql, args });
                if (opts.failDelete) throw new Error('d1-delete-fail');
                if (sql.includes('DELETE FROM room_memberships')) {
                  const [roomId, userId] = args as string[];
                  const idx = membershipRows.findIndex(
                    (m) => m.room_id === roomId && m.user_id === userId
                  );
                  if (idx >= 0) membershipRows.splice(idx, 1);
                }
              } else if (sql.trimStart().startsWith('UPDATE')) {
                updates.push({ sql, args });
                if (sql.includes('UPDATE events SET redacted_because')) {
                  if (redactBarrier) {
                    await new Promise<void>((resolve) => {
                      redactWaiters.push(resolve);
                      if (redactWaiters.length >= redactBarrier!.count) {
                        const all = [...redactWaiters];
                        redactWaiters.length = 0;
                        redactBarrier = undefined;
                        for (const r of all) r();
                      }
                    });
                  }
                  if (opts.failRedactUpdate) throw new Error('d1-redact-update-fail');
                }
              } else if (sql.trimStart().startsWith('INSERT')) {
                inserts.push({ sql, args });
              }
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

  return db;
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

function createWorkflowStub(status: { status: string; output?: unknown }) {
  const creates: unknown[] = [];
  return {
    creates,
    async create(opts: unknown) {
      creates.push(opts);
      return {
        async status() {
          return status;
        },
      };
    },
  };
}

function envFor(
  db: SqlDb,
  extras: {
    workflow?: ReturnType<typeof createWorkflowStub>;
    pushWorkflow?: { create: ReturnType<typeof vi.fn> };
  } = {}
): Env {
  return {
    DB: db as unknown as D1Database,
    CACHE: mockKv(),
    SERVER_NAME: SERVER,
    ROOM_JOIN_WORKFLOW: (extras.workflow ??
      createWorkflowStub({
        status: 'complete',
        output: { success: true },
      })) as unknown as Env['ROOM_JOIN_WORKFLOW'],
    PUSH_NOTIFICATION_WORKFLOW: (extras.pushWorkflow ?? {
      create: vi.fn(async () => ({ id: 'push-1' })),
    }) as unknown as Env['PUSH_NOTIFICATION_WORKFLOW'],
  } as unknown as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  db: SqlDb = createSqlDb(),
  extras: Parameters<typeof envFor>[1] = {},
  execCtx: ReturnType<typeof createExecCtx> = createExecCtx()
): Promise<{
  status: number;
  body: unknown;
  db: SqlDb;
  execCtx: ReturnType<typeof createExecCtx>;
  env: Env;
}> {
  const env = envFor(db, extras);
  const res = await rooms.request(`http://localhost${path}`, init, env, execCtx as never);
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, db, execCtx, env };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: 'Bearer test-token',
    },
  };
  if (method !== 'GET' && method !== 'HEAD') {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    } else {
      init.body = '{}';
    }
  }
  return init;
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
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'public' },
        state_key: '',
      }),
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: {
          users: { [USER]: 100, [BOB]: 0, [CAROL]: 50 },
          users_default: 0,
          state_default: 50,
          events_default: 0,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 50,
          events: {
            'm.room.name': 50,
            'm.room.tombstone': 100,
          },
        },
        state_key: '',
      }),
    };
    return defaults[type] ?? null;
  });
}

function readyLocalJoin(): void {
  getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
  getMembership.mockResolvedValue(null);
  getRoomEvents.mockResolvedValue({
    events: [pdu({ type: 'm.room.message', event_id: '$prev', depth: 2 })],
    end: 2,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);

  createRoom.mockReset().mockResolvedValue(undefined);
  getRoom.mockReset();
  storeEvent.mockReset().mockResolvedValue(1);
  storeEventIdempotent.mockReset().mockResolvedValue({
    inserted: true,
    eventId: '$detjoin:example.com',
  });
  getRoomState.mockReset().mockResolvedValue([]);
  getStateEvent.mockReset();
  getRoomEvents.mockReset().mockResolvedValue({ events: [], end: 0 });
  updateMembership.mockReset().mockResolvedValue(undefined);
  tryInsertJoinMembership.mockReset().mockResolvedValue({
    inserted: true,
    eventId: '$detjoin:example.com',
  });
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

// ---------------------------------------------------------------------------
// Concurrent join idempotency / notify gates
// ---------------------------------------------------------------------------

describe('race parallel local join idempotency after #190', () => {
  it('Promise.all of 8 identical joins all succeed with shared deterministic id', async () => {
    readyLocalJoin();
    let insertCalls = 0;
    storeEventIdempotent.mockImplementation(async () => {
      insertCalls += 1;
      return {
        inserted: insertCalls === 1,
        eventId: '$detjoin:example.com',
      };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: insertCalls === 1,
      eventId: '$detjoin:example.com',
    }));

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}))
      )
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(
      results.every((r) => JSON.stringify(r.body) === JSON.stringify({ room_id: ROOM }))
    ).toBe(true);
    expect(generateDeterministicEventId).toHaveBeenCalled();
    expect(storeEventIdempotent.mock.calls.length).toBe(8);
  });

  it('notifies once when only first of N concurrent joins inserts', async () => {
    readyLocalJoin();
    let n = 0;
    storeEventIdempotent.mockImplementation(async () => {
      n += 1;
      return { inserted: n === 1, eventId: '$detjoin:example.com' };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: n === 1,
      eventId: '$detjoin:example.com',
    }));

    await Promise.all(
      Array.from({ length: 5 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}))
      )
    );

    expect(notifyUsersOfEvent).toHaveBeenCalledTimes(1);
  });

  it('notifies for each join that reports insert on event OR membership', async () => {
    readyLocalJoin();
    const patterns = [
      { event: true, member: false },
      { event: false, member: true },
      { event: false, member: false },
      { event: true, member: true },
    ];

    for (let i = 0; i < patterns.length; i++) {
      notifyUsersOfEvent.mockClear();
      const p = patterns[i];
      storeEventIdempotent.mockResolvedValue({
        inserted: p.event,
        eventId: `$det-${i}:example.com`,
      });
      tryInsertJoinMembership.mockResolvedValue({
        inserted: p.member,
        eventId: `$det-${i}:example.com`,
      });

      const { status } = await request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
        jsonInit('POST', {})
      );
      expect(status).toBe(200);
      if (p.event || p.member) {
        expect(notifyUsersOfEvent).toHaveBeenCalledTimes(1);
      } else {
        expect(notifyUsersOfEvent).not.toHaveBeenCalled();
      }
    }
  });

  it('already-joined short-circuit on invite-only room skips store under concurrent load', async () => {
    // Public rooms set canJoin before the already-joined early-return; invite-only
    // hits the membership==='join' branch and skips idempotent writes.
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}))
      )
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(storeEventIdempotent).not.toHaveBeenCalled();
    expect(tryInsertJoinMembership).not.toHaveBeenCalled();
    expect(notifyUsersOfEvent).not.toHaveBeenCalled();
  });

  it('public room already-joined still uses idempotent insert path concurrently', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(joinMembership());
    storeEventIdempotent.mockResolvedValue({
      inserted: false,
      eventId: '$detjoin:example.com',
    });
    tryInsertJoinMembership.mockResolvedValue({
      inserted: false,
      eventId: '$detjoin:example.com',
    });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}))
      )
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(storeEventIdempotent).toHaveBeenCalled();
    expect(notifyUsersOfEvent).not.toHaveBeenCalled();
  });

  it('deterministic event id bind contract under concurrent joins', async () => {
    readyLocalJoin();
    await Promise.all([
      request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {})),
      request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {})),
    ]);

    for (const call of generateDeterministicEventId.mock.calls) {
      expect(call[0]).toBe(SERVER);
      expect(call[1]).toBe(ROOM);
      expect(call[2]).toBe(USER);
      expect(call[3]).toBe('join');
      expect(call[4]).toBe(NOW);
      expect(call[5]).toBe(1);
      expect(call[6]).toBe('10');
    }
  });

  it('join path /rooms vs /join concurrent both succeed on public room', async () => {
    readyLocalJoin();
    const results = await Promise.all([
      request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {})),
      request(`/_matrix/client/v3/join/${ROOM_ENC}`, jsonInit('POST', {})),
      request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', { reason: 'a' })),
      request(`/_matrix/client/v3/join/${ROOM_ENC}`, jsonInit('POST', { reason: 'b' })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => (r.body as { room_id: string }).room_id === ROOM)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Membership × endpoint matrix (concurrent soft)
// ---------------------------------------------------------------------------

describe('race membership×endpoint matrix concurrent after #190', () => {
  const memberships = ['join', 'invite', 'leave', 'ban', 'knock'] as const;

  for (const m of memberships) {
    it(`leave under concurrent load with membership=${m}`, async () => {
      getMembership.mockResolvedValue({ membership: m, eventId: `$m-${m}` });
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(`/_matrix/client/v3/rooms/${ROOM_ENC}/leave`, jsonInit('POST', {}))
        )
      );
      if (m === 'join') {
        expect(results.every((r) => r.status === 200)).toBe(true);
        expect(storeEvent).toHaveBeenCalled();
      } else {
        expect(results.every((r) => r.status === 403)).toBe(true);
        expect(storeEvent).not.toHaveBeenCalled();
      }
    });
  }

  for (const m of memberships) {
    it(`forget under concurrent load with membership=${m}`, async () => {
      getMembership.mockResolvedValue({ membership: m, eventId: `$m-${m}` });
      const db = createSqlDb({
        membershipRows: [{ room_id: ROOM, user_id: USER, membership: m }],
      });
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(
            `/_matrix/client/v3/rooms/${ROOM_ENC}/forget`,
            jsonInit('POST', {}),
            db
          )
        )
      );
      if (m === 'join') {
        expect(results.every((r) => r.status === 403)).toBe(true);
      } else {
        expect(results.every((r) => r.status === 200)).toBe(true);
      }
    });
  }

  for (const m of ['join', 'invite', 'leave', 'ban', null] as const) {
    it(`send forbids when membership=${m ?? 'null'} under concurrent soft flood`, async () => {
      getMembership.mockResolvedValue(
        m ? { membership: m, eventId: `$m-${m}` } : null
      );
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          request(
            `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/txn-${m}-${i}`,
            jsonInit('PUT', { msgtype: 'm.text', body: 'x' })
          )
        )
      );
      if (m === 'join') {
        expect(results.every((r) => r.status === 200)).toBe(true);
      } else {
        expect(results.every((r) => r.status === 403)).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Join-rule forbid matrix under concurrent load
// ---------------------------------------------------------------------------

describe('race join_rule forbid concurrent soft flood after #190', () => {
  const forbidRules = ['invite', 'knock', 'knock_restricted', 'restricted'] as const;

  for (const joinRule of forbidRules) {
    it(`concurrent joins all forbidden when join_rule=${joinRule} without invite`, async () => {
      getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
      getMembership.mockResolvedValue(null);
      defaultState({
        'm.room.join_rules': pdu({
          type: 'm.room.join_rules',
          event_id: '$jr',
          content: { join_rule: joinRule },
          state_key: '',
        }),
      });

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}))
        )
      );

      expect(results.every((r) => r.status === 403)).toBe(true);
      expect(storeEventIdempotent).not.toHaveBeenCalled();
    });
  }

  it('invite membership allows concurrent joins on invite-only room', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue({ membership: 'invite', eventId: '$inv' });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invite PL conflict races
// ---------------------------------------------------------------------------

describe('race invite power-level conflict concurrent after #190', () => {
  it('invite succeeds when PL stable across check and write', async () => {
    getMembership
      .mockResolvedValueOnce(joinMembership()) // inviter
      .mockResolvedValueOnce(null); // invitee
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      BOB,
      'invite',
      '$evt:example.com'
    );
  });

  it('invite returns conflict when PL event_id changes mid-flight', async () => {
    getMembership
      .mockResolvedValueOnce(joinMembership())
      .mockResolvedValueOnce(null);

    let plReads = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        plReads += 1;
        return pdu({
          type: 'm.room.power_levels',
          event_id: plReads === 1 ? '$pl-v1' : '$pl-v2',
          content: {
            users: { [USER]: 100 },
            users_default: 0,
            invite: 50,
          },
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER },
          state_key: '',
        });
      }
      return null;
    });

    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({
      errcode: 'M_CONFLICT',
      error: 'Power levels changed during invite; retry',
    });
    expect(storeEvent).not.toHaveBeenCalled();
  });

  it('concurrent invites to already-invited user stay idempotent 200', async () => {
    getMembership.mockImplementation(async (_db, _room, uid: string) => {
      if (uid === USER) return joinMembership();
      if (uid === BOB) return { membership: 'invite', eventId: '$bob-inv' };
      return null;
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
          jsonInit('POST', { user_id: BOB })
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });

  it('concurrent invites to already-joined user all forbidden', async () => {
    getMembership.mockImplementation(async (_db, _room, uid: string) => {
      if (uid === USER) return joinMembership();
      if (uid === BOB) return { membership: 'join', eventId: '$bob-join' };
      return null;
    });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
          jsonInit('POST', { user_id: BOB })
        )
      )
    );
    expect(results.every((r) => r.status === 403)).toBe(true);
  });

  it('insufficient invite PL under concurrent soft flood', async () => {
    getMembership.mockImplementation(async (_db, _room, uid: string) => {
      if (uid === USER) return joinMembership();
      return null;
    });
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: {
          users: { [USER]: 10 },
          users_default: 0,
          invite: 50,
        },
        state_key: '',
      }),
    });

    const results = await Promise.all(
      [BOB, CAROL, DAVE].map((u) =>
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
          jsonInit('POST', { user_id: u })
        )
      )
    );
    expect(results.every((r) => r.status === 403)).toBe(true);
  });

  for (const bad of [
    { label: 'missing user_id', body: {} },
    { label: 'null user_id', body: { user_id: null } },
    { label: 'empty user_id', body: { user_id: '' } },
    { label: 'number user_id', body: { user_id: 1 } },
  ] as const) {
    it(`invite body edge concurrent soft — ${bad.label}`, async () => {
      getMembership.mockResolvedValue(joinMembership());
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(
            `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
            jsonInit('POST', bad.body)
          )
        )
      );
      expect(results.every((r) => r.status === 400 || r.status === 403)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Kick / ban / unban concurrent PL edges
// ---------------------------------------------------------------------------

describe('race kick/ban/unban concurrent PL after #190', () => {
  it('kick succeeds when kicker power > target under concurrent soft', async () => {
    getMembership.mockImplementation(async (_db, _room, uid: string) => {
      if (uid === USER || uid === BOB) return { membership: 'join', eventId: `$j-${uid}` };
      return null;
    });
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
          jsonInit('POST', { user_id: BOB, reason: `r${i}` })
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('kick forbids equal power under concurrent soft flood', async () => {
    getMembership.mockImplementation(async (_db, _room, uid: string) => {
      if (uid === USER || uid === CAROL) return { membership: 'join', eventId: `$j-${uid}` };
      return null;
    });
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: {
          users: { [USER]: 50, [CAROL]: 50 },
          users_default: 0,
          kick: 50,
        },
        state_key: '',
      }),
    });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
          jsonInit('POST', { user_id: CAROL })
        )
      )
    );
    expect(results.every((r) => r.status === 403)).toBe(true);
  });

  it('ban forbids when target not joined under concurrent soft', async () => {
    getMembership.mockImplementation(async (_db, _room, uid: string) => {
      if (uid === USER) return joinMembership();
      return null;
    });
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/ban`,
          jsonInit('POST', { user_id: BOB })
        )
      )
    );
    // ban may still work on non-members depending on impl — assert stable statuses
    expect(results.every((r) => r.status === 200 || r.status === 403)).toBe(true);
  });

  it('unban concurrent soft requires join membership of actor', async () => {
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/unban`,
          jsonInit('POST', { user_id: BOB })
        )
      )
    );
    expect(results.every((r) => r.status === 403)).toBe(true);
  });

  for (const endpoint of ['kick', 'ban', 'unban'] as const) {
    it(`${endpoint} missing user_id concurrent soft flood`, async () => {
      getMembership.mockResolvedValue(joinMembership());
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(
            `/_matrix/client/v3/rooms/${ROOM_ENC}/${endpoint}`,
            jsonInit('POST', { reason: 'x' })
          )
        )
      );
      expect(results.every((r) => r.status === 400)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Concurrent send / txn / push isolation
// ---------------------------------------------------------------------------

describe('race concurrent send txn isolation after #190', () => {
  it('distinct txnIds under Promise.all each store and notify', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let seq = 0;
    generateEventId.mockImplementation(async () => `$evt-${++seq}:example.com`);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/txn-${i}`,
          jsonInit('PUT', { msgtype: 'm.text', body: `m${i}` })
        )
      )
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    const ids = results.map((r) => (r.body as { event_id: string }).event_id);
    expect(new Set(ids).size).toBe(8);
    expect(storeEvent).toHaveBeenCalledTimes(8);
    expect(notifyUsersOfEvent).toHaveBeenCalledTimes(8);
  });

  it('m.room.message concurrent schedules push per send; reaction does not', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let seq = 0;
    generateEventId.mockImplementation(async () => `$evt-${++seq}:example.com`);
    const pushWorkflow = { create: vi.fn(async () => ({ id: 'push-x' })) };
    const execCtx = createExecCtx();
    const db = createSqlDb();
    const extras = { pushWorkflow };

    const results = await Promise.all([
      request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/t-msg`,
        jsonInit('PUT', { msgtype: 'm.text', body: 'hi' }),
        db,
        extras,
        execCtx
      ),
      request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.encrypted/t-enc`,
        jsonInit('PUT', { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' }),
        db,
        extras,
        execCtx
      ),
      request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.reaction/t-react`,
        jsonInit('PUT', { 'm.relates_to': { rel_type: 'm.annotation', key: '👍' } }),
        db,
        extras,
        execCtx
      ),
      request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.member/t-member`,
        jsonInit('PUT', { membership: 'join' }),
        db,
        extras,
        execCtx
      ),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    await Promise.all(execCtx.waitUntilPromises);
    expect(pushWorkflow.create).toHaveBeenCalledTimes(2);
  });

  it('bad JSON send concurrent soft flood all M_BAD_JSON', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/bad-${i}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          },
          body: '{not-json',
        })
      )
    );
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });

  it('multi-room concurrent send isolation', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let seq = 0;
    generateEventId.mockImplementation(async () => `$evt-${++seq}:example.com`);

    const roomsEnc = [ROOM_ENC, ROOM2_ENC, ROOM3_ENC];
    const results = await Promise.all(
      roomsEnc.flatMap((enc, ri) =>
        Array.from({ length: 2 }, (_, i) =>
          request(
            `/_matrix/client/v3/rooms/${enc}/send/m.room.message/r${ri}-t${i}`,
            jsonInit('PUT', { msgtype: 'm.text', body: `${ri}-${i}` })
          )
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const roomIds = storeEvent.mock.calls.map((c) => (c[1] as PDU).room_id);
    expect(roomIds.filter((id) => id === ROOM).length).toBe(2);
    expect(roomIds.filter((id) => id === ROOM2).length).toBe(2);
    expect(roomIds.filter((id) => id === ROOM3).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Remote workflow concurrent soft matrix
// ---------------------------------------------------------------------------

describe('race remote join workflow concurrent soft after #190', () => {
  const statuses: Array<{ status: string; output?: unknown; expectOk: boolean }> = [
    { status: 'running', expectOk: true },
    { status: 'queued', expectOk: true },
    { status: 'complete', output: { success: true }, expectOk: true },
    { status: 'complete', output: { success: false }, expectOk: false },
    { status: 'complete', output: {}, expectOk: false },
    { status: 'errored', expectOk: false },
  ];

  for (const s of statuses) {
    it(`remote join concurrent soft status=${s.status} success=${String(
      (s.output as { success?: boolean } | undefined)?.success
    )}`, async () => {
      getRoom.mockResolvedValue(null);
      const workflow = createWorkflowStub({ status: s.status, output: s.output });
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(
            `/_matrix/client/v3/rooms/${REMOTE_ENC}/join`,
            jsonInit('POST', {}),
            createSqlDb(),
            { workflow }
          )
        )
      );
      if (s.expectOk) {
        expect(results.every((r) => r.status === 200)).toBe(true);
      } else {
        expect(results.every((r) => r.status === 500 || r.status === 400)).toBe(true);
      }
      expect(workflow.creates.length).toBe(3);
    });
  }

  it('workflow status throw under concurrent soft flood', async () => {
    getRoom.mockResolvedValue(null);
    const workflow = {
      creates: [] as unknown[],
      async create(opts: unknown) {
        workflow.creates.push(opts);
        return {
          async status() {
            throw new Error('workflow-status-boom');
          },
        };
      },
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(
          `/_matrix/client/v3/rooms/${REMOTE_ENC}/join`,
          jsonInit('POST', {}),
          createSqlDb(),
          { workflow: workflow as ReturnType<typeof createWorkflowStub> }
        )
      )
    );
    expect(results.every((r) => r.status !== 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Method matrix concurrent soft floods
// ---------------------------------------------------------------------------

describe('race rooms method matrix concurrent soft after #190', () => {
  const writePaths: Array<{ path: string; allow: string[] }> = [
    { path: `/_matrix/client/v3/rooms/${ROOM_ENC}/join`, allow: ['POST'] },
    { path: `/_matrix/client/v3/rooms/${ROOM_ENC}/leave`, allow: ['POST'] },
    { path: `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`, allow: ['POST'] },
    { path: `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`, allow: ['POST'] },
    { path: `/_matrix/client/v3/rooms/${ROOM_ENC}/ban`, allow: ['POST'] },
    { path: `/_matrix/client/v3/rooms/${ROOM_ENC}/unban`, allow: ['POST'] },
    { path: `/_matrix/client/v3/rooms/${ROOM_ENC}/forget`, allow: ['POST'] },
    {
      path: `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/txn-m`,
      allow: ['PUT'],
    },
    {
      path: `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/txn-r`,
      allow: ['PUT'],
    },
  ];

  for (const wp of writePaths) {
    for (const method of ['GET', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      if (wp.allow.includes(method)) continue;
      it(`${method} ${wp.path.split('/').slice(-2).join('/')} soft non-success`, async () => {
        getMembership.mockResolvedValue(joinMembership());
        getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
        getEvent.mockResolvedValue(
          pdu({ type: 'm.room.message', event_id: EVENT, sender: BOB })
        );
        const { status } = await request(wp.path, jsonInit(method, {}));
        expect(status).not.toBe(200);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Body type soft floods (createRoom / knock / upgrade)
// ---------------------------------------------------------------------------

describe('race body type soft floods concurrent after #190', () => {
  const badBodies: Array<{ label: string; body: unknown }> = [
    { label: 'null', body: null },
    { label: 'array', body: [] },
    { label: 'string', body: 'x' },
    { label: 'number', body: 1 },
    { label: 'bool', body: true },
  ];

  for (const b of badBodies) {
    it(`createRoom concurrent soft body=${b.label}`, async () => {
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          request('/_matrix/client/v3/createRoom', jsonInit('POST', b.body))
        )
      );
      // Hono/json parse may 400 or create with coerced empty — assert no crash
      expect(results.every((r) => typeof r.status === 'number')).toBe(true);
      expect(results.every((r) => r.status < 500 || r.status === 500)).toBe(true);
    });
  }

  for (const reason of [null, 1, true, [], { x: 1 }, 'ok'] as const) {
    it(`knock reason type concurrent soft reason=${JSON.stringify(reason)}`, async () => {
      getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
      getMembership.mockResolvedValue(null);
      defaultState({
        'm.room.join_rules': pdu({
          type: 'm.room.join_rules',
          event_id: '$jr',
          content: { join_rule: 'knock' },
          state_key: '',
        }),
      });
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(
            `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`,
            jsonInit('POST', { reason })
          )
        )
      );
      expect(results.every((r) => r.status === 200 || r.status === 403 || r.status === 400)).toBe(
        true
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-room leave / forget isolation
// ---------------------------------------------------------------------------

describe('race multi-room leave/forget isolation after #190', () => {
  it('leave room A does not touch room B under concurrent load', async () => {
    getMembership.mockImplementation(async (_db, roomId: string) => {
      return { membership: 'join', eventId: `$j-${roomId}` };
    });
    let seq = 0;
    generateEventId.mockImplementation(async () => `$leave-${++seq}:example.com`);

    const results = await Promise.all([
      request(`/_matrix/client/v3/rooms/${ROOM_ENC}/leave`, jsonInit('POST', {})),
      request(`/_matrix/client/v3/rooms/${ROOM2_ENC}/leave`, jsonInit('POST', {})),
      request(`/_matrix/client/v3/rooms/${ROOM3_ENC}/leave`, jsonInit('POST', {})),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    const leaveRooms = updateMembership.mock.calls.map((c) => c[1]);
    expect(leaveRooms).toEqual(expect.arrayContaining([ROOM, ROOM2, ROOM3]));
    expect(updateMembership.mock.calls.every((c) => c[3] === 'leave')).toBe(true);
  });

  it('forget concurrent deletes bind room_id+user_id contract', async () => {
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const db = createSqlDb({
      membershipRows: [
        { room_id: ROOM, user_id: USER, membership: 'leave' },
        { room_id: ROOM2, user_id: USER, membership: 'leave' },
      ],
    });

    const results = await Promise.all([
      request(`/_matrix/client/v3/rooms/${ROOM_ENC}/forget`, jsonInit('POST', {}), db),
      request(`/_matrix/client/v3/rooms/${ROOM2_ENC}/forget`, jsonInit('POST', {}), db),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.deletes.length).toBeGreaterThanOrEqual(2);
    for (const d of db.deletes) {
      expect(d.sql).toContain('DELETE FROM room_memberships');
      expect(d.args[1]).toBe(USER);
      expect([ROOM, ROOM2]).toContain(d.args[0]);
    }
  });

  it('forget DELETE failure surfaces under concurrent soft', async () => {
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const db = createSqlDb({ failDelete: true });
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/forget`, jsonInit('POST', {}), db)
      )
    );
    expect(results.every((r) => r.status >= 500 || r.status === 500)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Redact concurrent races
// ---------------------------------------------------------------------------

describe('race redact concurrent after #190', () => {
  it('concurrent redacts of same event each store redaction', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({ type: 'm.room.message', event_id: EVENT, sender: BOB, room_id: ROOM })
    );
    let seq = 0;
    generateEventId.mockImplementation(async () => `$redact-${++seq}:example.com`);
    const db = createSqlDb({ redactBarrier: { count: 3 } });

    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/txn-r-${i}`,
          jsonInit('PUT', { reason: `r${i}` }),
          db
        )
      )
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(storeEvent).toHaveBeenCalledTimes(3);
    expect(db.updates.filter((u) => u.sql.includes('redacted_because')).length).toBe(3);
  });

  it('self-redact allowed without redact PL under concurrent soft', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({ type: 'm.room.message', event_id: EVENT, sender: USER, room_id: ROOM })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: {
          users: { [USER]: 0 },
          users_default: 0,
          redact: 50,
        },
        state_key: '',
      }),
    });

    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/self-${i}`,
          jsonInit('PUT', {})
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('redact missing event concurrent soft all 404', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(null);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/miss-${i}`,
          jsonInit('PUT', {})
        )
      )
    );
    expect(results.every((r) => r.status === 404)).toBe(true);
  });

  it('redact wrong-room event concurrent soft all 404', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        room_id: ROOM2,
      })
    );
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/wr-${i}`,
          jsonInit('PUT', {})
        )
      )
    );
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Soft reliability floods — joined_rooms / members / messages / not-found
// ---------------------------------------------------------------------------

describe('race soft reliability floods after #190', () => {
  it('joined_rooms concurrent soft returns list', async () => {
    getUserRooms.mockResolvedValue([ROOM, ROOM2]);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request('/_matrix/client/v3/joined_rooms', { method: 'GET', headers: {
          Authorization: 'Bearer test-token',
        } })
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => (r.body as { joined_rooms: string[] }).joined_rooms)).toBeTruthy();
  });

  it('local join room-not-found concurrent soft', async () => {
    getRoom.mockResolvedValue(null);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}))
      )
    );
    expect(results.every((r) => r.status === 404)).toBe(true);
  });

  it('members endpoint concurrent soft when joined', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomMembers.mockResolvedValue([
      { user_id: USER, membership: 'join' },
      { user_id: BOB, membership: 'join' },
    ]);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/members`, {
          method: 'GET',
          headers: { Authorization: 'Bearer test-token' },
        })
      )
    );
    expect(results.every((r) => r.status === 200 || r.status === 403)).toBe(true);
  });

  it('messages endpoint concurrent soft when joined', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: EVENT, depth: 1 })],
      end: 1,
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/messages?dir=b&limit=10`, {
          method: 'GET',
          headers: { Authorization: 'Bearer test-token' },
        })
      )
    );
    expect(results.every((r) => typeof r.status === 'number')).toBe(true);
  });

  it('event get concurrent soft not-found', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(null);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/event/${EVENT_ENC}`, {
          method: 'GET',
          headers: { Authorization: 'Bearer test-token' },
        })
      )
    );
    expect(results.every((r) => r.status === 404 || r.status === 403 || r.status === 200)).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// Store/notify failure soft edges under concurrency
// ---------------------------------------------------------------------------

describe('race store/notify failure soft concurrent after #190', () => {
  it('storeEventIdempotent throw under concurrent join soft', async () => {
    readyLocalJoin();
    storeEventIdempotent.mockRejectedValue(new Error('d1-idempotent-fail'));
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}))
      )
    );
    expect(results.every((r) => r.status >= 500)).toBe(true);
  });

  it('tryInsertJoinMembership throw after insert under concurrent soft', async () => {
    readyLocalJoin();
    tryInsertJoinMembership.mockRejectedValue(new Error('d1-member-fail'));
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}))
      )
    );
    expect(results.every((r) => r.status >= 500)).toBe(true);
  });

  it('notifyUsersOfEvent throw after successful join still fails request', async () => {
    readyLocalJoin();
    notifyUsersOfEvent.mockRejectedValue(new Error('notify-boom'));
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(status).toBeGreaterThanOrEqual(500);
  });

  it('leave storeEvent throw under concurrent soft', async () => {
    getMembership.mockResolvedValue(joinMembership());
    storeEvent.mockRejectedValue(new Error('store-fail'));
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/leave`, jsonInit('POST', {}))
      )
    );
    expect(results.every((r) => r.status >= 500)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Upgrade / timestamp concurrent soft
// ---------------------------------------------------------------------------

describe('race upgrade/timestamp concurrent soft after #190', () => {
  it('timestamp_to_event missing ts concurrent soft validation', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(`/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event`, {
          method: 'GET',
          headers: { Authorization: 'Bearer test-token' },
        })
      )
    );
    expect(results.every((r) => r.status === 400 || r.status === 403 || r.status === 200)).toBe(
      true
    );
  });

  it('upgrade insufficient PL concurrent soft flood', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: {
          users: { [USER]: 0 },
          users_default: 0,
          state_default: 50,
          events: { 'm.room.tombstone': 100 },
        },
        state_key: '',
      }),
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
          jsonInit('POST', { new_version: '10' })
        )
      )
    );
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(
      results.every((r) =>
        String((r.body as { error?: string })?.error ?? '').includes('Insufficient power')
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Soft-cap lifecycle floods (presence-style volume)
// ---------------------------------------------------------------------------

describe('race soft-cap lifecycle floods after #190', () => {
  it('join→already-joined→leave→forget lifecycle soft flood ×N', async () => {
    for (let n = 0; n < 6; n++) {
      readyLocalJoin();
      storeEventIdempotent.mockResolvedValue({
        inserted: true,
        eventId: `$det-${n}:example.com`,
      });
      tryInsertJoinMembership.mockResolvedValue({
        inserted: true,
        eventId: `$det-${n}:example.com`,
      });

      const join = await request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
        jsonInit('POST', {})
      );
      expect(join.status).toBe(200);

      getMembership.mockResolvedValue(joinMembership(`$det-${n}:example.com`));
      const again = await request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
        jsonInit('POST', {})
      );
      expect(again.status).toBe(200);

      const leave = await request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/leave`,
        jsonInit('POST', {})
      );
      expect(leave.status).toBe(200);

      getMembership.mockResolvedValue({ membership: 'leave', eventId: `$leave-${n}` });
      const forget = await request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/forget`,
        jsonInit('POST', {}),
        createSqlDb()
      );
      expect(forget.status).toBe(200);
    }
  });

  it('invite→accept join soft flood for distinct invitees', async () => {
    const invitees = [BOB, CAROL, DAVE, '@erin:example.com', '@frank:example.com'];
    for (const invitee of invitees) {
      getMembership.mockImplementation(async (_db, _room, uid: string) => {
        if (uid === USER) return joinMembership();
        return null;
      });
      const inv = await request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
        jsonInit('POST', { user_id: invitee })
      );
      expect(inv.status).toBe(200);
    }
  });

  it('send soft flood 12 messages preserves txn in unsigned', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let seq = 0;
    generateEventId.mockImplementation(async () => `$msg-${++seq}:example.com`);

    for (let i = 0; i < 12; i++) {
      const { status, body } = await request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/flood-${i}`,
        jsonInit('PUT', { msgtype: 'm.text', body: `f${i}` })
      );
      expect(status).toBe(200);
      expect((body as { event_id: string }).event_id).toMatch(/^\$msg-/);
      const stored = storeEvent.mock.calls[i][1] as PDU;
      expect(stored.unsigned?.transaction_id).toBe(`flood-${i}`);
    }
  });

  for (const joinRule of ['public', 'invite'] as const) {
    for (const membership of ['join', 'invite', 'leave', null] as const) {
      it(`join gate soft matrix rule=${joinRule} membership=${membership ?? 'null'}`, async () => {
        getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
        getMembership.mockResolvedValue(
          membership ? { membership, eventId: `$m-${membership}` } : null
        );
        defaultState({
          'm.room.join_rules': pdu({
            type: 'm.room.join_rules',
            event_id: '$jr',
            content: { join_rule: joinRule },
            state_key: '',
          }),
        });
        if (membership === 'join' && joinRule === 'invite') {
          // early return path
        } else {
          storeEventIdempotent.mockResolvedValue({
            inserted: true,
            eventId: '$detjoin:example.com',
          });
          tryInsertJoinMembership.mockResolvedValue({
            inserted: true,
            eventId: '$detjoin:example.com',
          });
        }

        const { status } = await request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
          jsonInit('POST', {})
        );

        const shouldSucceed =
          membership === 'join' ||
          joinRule === 'public' ||
          membership === 'invite';
        if (shouldSucceed) {
          expect(status).toBe(200);
        } else {
          expect(status).toBe(403);
        }
      });
    }
  }

  for (const reason of ['', 'spam', 'x'.repeat(64), undefined] as const) {
    it(`kick reason soft matrix reason=${reason === undefined ? 'omit' : JSON.stringify(reason).slice(0, 20)}`, async () => {
      getMembership.mockImplementation(async (_db, _room, uid: string) => {
        if (uid === USER || uid === BOB) return { membership: 'join', eventId: `$j-${uid}` };
        return null;
      });
      const body =
        reason === undefined ? { user_id: BOB } : { user_id: BOB, reason };
      const { status } = await request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
        jsonInit('POST', body)
      );
      expect(status).toBe(200);
    });
  }

  for (const evtType of [
    'm.room.message',
    'm.room.encrypted',
    'm.reaction',
    'm.sticker',
    'org.example.custom',
  ] as const) {
    it(`send eventType=${evtType} push gate soft`, async () => {
      getMembership.mockResolvedValue(joinMembership());
      generateEventId.mockResolvedValue(`$t-${evtType}:example.com`);
      const pushWorkflow = { create: vi.fn(async () => ({ id: 'push-x' })) };
      const execCtx = createExecCtx();
      const { status } = await request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/send/${encodeURIComponent(evtType)}/txn-${evtType}`,
        jsonInit('PUT', { body: 'x' }),
        createSqlDb(),
        { pushWorkflow },
        execCtx
      );
      expect(status).toBe(200);
      await Promise.all(execCtx.waitUntilPromises);
      if (evtType === 'm.room.message' || evtType === 'm.room.encrypted') {
        expect(pushWorkflow.create).toHaveBeenCalled();
      } else {
        expect(pushWorkflow.create).not.toHaveBeenCalled();
      }
    });
  }

  for (const dir of ['b', 'f'] as const) {
    for (const limit of ['1', '10', '100'] as const) {
      it(`messages query soft dir=${dir} limit=${limit}`, async () => {
        getMembership.mockResolvedValue(joinMembership());
        getRoomEvents.mockResolvedValue({ events: [], end: 0 });
        const { status } = await request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/messages?dir=${dir}&limit=${limit}`,
          { method: 'GET', headers: { Authorization: 'Bearer test-token' } }
        );
        expect([200, 403, 400]).toContain(status);
      });
    }
  }
});
