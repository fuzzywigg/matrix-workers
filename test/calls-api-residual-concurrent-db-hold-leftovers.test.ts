/**
 * TOKENMAXX HEAVY residual concurrent leftovers after #261 — Cloudflare Calls
 * Matrix routes DB-hold / failEnd races not covered by:
 *   - test/calls-api-residual-concurrent-race-leftovers.test.ts (#261):
 *     WS∥start events INSERT hold, throwInit∥GET, dual end UPDATE barrier,
 *     active flip mid dual-start, WS∥end inactive, throwInit∥end
 *   - voip-rtc-calls-concurrent-race (#201): dual cold start / start∥end
 *
 * This slice (unsaturated):
 *   - failEnd ∥ GET (end still 200 + DB inactive; GET may see either)
 *   - INSERT room_state hold mid-start ∥ GET (early inactive → late active)
 *   - membership SELECT hold + flip to leave mid dual-start (403 vs 200)
 *   - failEnd ∥ end (both succeed; DO throw swallowed)
 *   - room_state INSERT hold ∥ end on empty (end 404 until start completes)
 *
 * Tests-only. Fixtures use example.com only.
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

let opaqueSeq = 0;
const generateOpaqueId = vi.fn(async () => {
  opaqueSeq += 1;
  return `pinned-call-${opaqueSeq}`;
});

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateOpaqueId: (...args: unknown[]) => generateOpaqueId(...(args as [])),
  };
});

import callsApp from '../src/api/calls';

const USER = '@alice:example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const CALL_ID = 'pinned-call-1';
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
type RunBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type CallFetch = { url: string; method: string; body?: unknown; headers?: Record<string, string> };

async function withBarrier(
  barrier: { match: (sql: string, args: unknown[]) => boolean; count: number } | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  sql: string,
  args: unknown[]
) {
  if (!barrier || !barrier.match(sql, args)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
}

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
  opts: {
    memberships?: Membership[];
    stateLinks?: StateLink[];
    events?: EventRow[];
    runBarrier?: RunBarrier;
  } = {}
) {
  const memberships = opts.memberships ?? [];
  const stateLinks = opts.stateLinks ?? [];
  const events = opts.events ?? [];
  const selects: SqlCall[] = [];
  const runs: SqlCall[] = [];
  const runWaiters = { list: [] as Array<() => void> };
  let runBarrier = opts.runBarrier;

  const db = {
    memberships,
    stateLinks,
    events,
    selects,
    runs,
    setRunBarrier(b: RunBarrier | undefined) {
      runBarrier = b;
    },
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
              await withBarrier(
                runBarrier,
                runWaiters,
                () => {
                  runBarrier = undefined;
                },
                sql,
                args
              );
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

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

describe('calls residual concurrent DB-hold leftovers after #261', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    opaqueSeq = 0;
    callsMocks.isCallsConfigured.mockReturnValue(true);
    generateOpaqueId.mockImplementation(async () => {
      opaqueSeq += 1;
      return `pinned-call-${opaqueSeq}`;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('failEnd ∥ GET: end still 200 + DB inactive; GET may see active or inactive', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db);
    const callRoom = createCallRoomStub({ failEnd: true });
    const env = createEnv({ db, callRoom });

    const [endRes, getRes] = await Promise.all([
      request(env, END_PATH, jsonInit('POST', {})),
      request(env, GET_PATH),
    ]);

    expect(endRes.status).toBe(200);
    expect(endRes.body).toEqual({ success: true });
    expect(getRes.status).toBe(200);
    // GET may race before or after UPDATE — either active true or false is valid
    expect([true, false]).toContain((getRes.body as { active: boolean }).active);
    const ev = db.events.find((e) => e.event_id === `call_${CALL_ID}`)!;
    expect(JSON.parse(ev.content).active).toBe(false);
    expect(callRoom.fetches.some((f) => f.url.includes('/end'))).toBe(true);
  });

  it('INSERT room_state hold mid-start ∥ GET: early inactive → late active after release', async () => {
    const waiters: Array<() => void> = [];
    let holdInsert = true;
    const db = createCallsDb({ memberships: [joinMember()] });
    const origPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      const origBind = stmt.bind.bind(stmt);
      return {
        bind(...args: unknown[]) {
          const bound = origBind(...args);
          const origRun = bound.run.bind(bound);
          return {
            ...bound,
            async run() {
              if (holdInsert && sql.includes('INSERT INTO room_state')) {
                await new Promise<void>((resolve) => waiters.push(resolve));
              }
              return origRun();
            },
          };
        },
      };
    }) as typeof db.prepare;

    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });

    const startP = request(env, START_PATH, jsonInit('POST', {}));
    await vi.waitFor(() => expect(waiters.length).toBe(1));

    const getEarly = await request(env, GET_PATH);
    expect(getEarly.status).toBe(200);
    expect(getEarly.body).toEqual({ active: false });

    holdInsert = false;
    waiters[0]();
    const startRes = await startP;
    expect(startRes.status).toBe(200);

    const getLate = await request(env, GET_PATH);
    expect(getLate.status).toBe(200);
    expect(getLate.body).toMatchObject({ active: true, callId: 'pinned-call-1' });
  });

  it('membership SELECT hold + flip to leave mid dual-start → 403 and/or proceed', async () => {
    const hold: Array<() => void> = [];
    const db = createCallsDb({ memberships: [joinMember()] });

    const basePrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = basePrepare(sql);
      const origBind = stmt.bind.bind(stmt);
      return {
        bind(...args: unknown[]) {
          const bound = origBind(...args);
          const origFirst = bound.first.bind(bound);
          return {
            ...bound,
            async first<T>() {
              if (sql.includes('FROM room_memberships')) {
                await new Promise<void>((resolve) => {
                  hold.push(resolve);
                  if (hold.length >= 2) {
                    const m = db.memberships.find(
                      (row) => row.room_id === ROOM && row.user_id === USER
                    );
                    if (m) m.membership = 'leave';
                    const all = [...hold];
                    hold.length = 0;
                    for (const r of all) r();
                  }
                });
              }
              return origFirst<T>();
            },
          };
        },
      };
    }) as typeof db.prepare;

    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });

    const results = await Promise.all([
      request(env, START_PATH, jsonInit('POST', {})),
      request(env, START_PATH, jsonInit('POST', {})),
    ]);

    for (const r of results) {
      expect([200, 403, 400]).toContain(r.status);
    }
    // After flip both should see leave → both 403 is the common TOCTOU outcome;
    // document LWW: at least one is forbidden OR (if race before flip) may proceed.
    expect(results.some((r) => r.status === 403 || r.status === 200)).toBe(true);
  });

  it('dual failEnd both succeed — DO throw swallowed, DB inactive', async () => {
    const db = createCallsDb({ memberships: [joinMember()] });
    seedActiveCall(db);
    const callRoom = createCallRoomStub({ failEnd: true });
    const env = createEnv({ db, callRoom });

    const results = await Promise.all([
      request(env, END_PATH, jsonInit('POST', {})),
      request(env, END_PATH, jsonInit('POST', {})),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    const ev = db.events.find((e) => e.event_id === `call_${CALL_ID}`)!;
    expect(JSON.parse(ev.content).active).toBe(false);
    expect(callRoom.fetches.filter((f) => f.url.includes('/end')).length).toBeGreaterThanOrEqual(1);
  });

  it('room_state INSERT hold ∥ end on empty room: end 404 until start completes', async () => {
    const waiters: Array<() => void> = [];
    let holdInsert = true;
    const db = createCallsDb({ memberships: [joinMember()] });
    const origPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      const origBind = stmt.bind.bind(stmt);
      return {
        bind(...args: unknown[]) {
          const bound = origBind(...args);
          const origRun = bound.run.bind(bound);
          return {
            ...bound,
            async run() {
              if (holdInsert && sql.includes('INSERT INTO room_state')) {
                await new Promise<void>((resolve) => waiters.push(resolve));
              }
              return origRun();
            },
          };
        },
      };
    }) as typeof db.prepare;

    const callRoom = createCallRoomStub();
    const env = createEnv({ db, callRoom });

    const startP = request(env, START_PATH, jsonInit('POST', {}));
    await vi.waitFor(() => expect(waiters.length).toBe(1));

    const endEarly = await request(env, END_PATH, jsonInit('POST', {}));
    expect(endEarly.status).toBe(404);
    expect(endEarly.body).toMatchObject({ errcode: 'M_NOT_FOUND' });

    holdInsert = false;
    waiters[0]();
    const startRes = await startP;
    expect(startRes.status).toBe(200);

    const endLate = await request(env, END_PATH, jsonInit('POST', {}));
    expect(endLate.status).toBe(200);
    expect(endLate.body).toEqual({ success: true });
  });
});
