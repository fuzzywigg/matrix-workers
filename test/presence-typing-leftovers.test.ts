/**
 * TOKENMAXX HEAVY leftovers — presence / typing / ephemeral timeout & coalescing.
 * Complements presence-api-routes, typing-api-routes, presence-helpers,
 * receipts-typing-helpers, room-durable-object, and the soft-flood leftovers suite.
 * Focus: timeout expiry, multi-user typing coalescing, offline/online transitions,
 * and rate-limit stubs (presence/typing → default bucket).
 * Tests-only — no product inventing. Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { AppEnv, Env } from '../src/types';
import {
  FakeDurableObjectState,
  durableObjectMockFactory,
} from './helpers/fake-durable-object';
import {
  getRateLimitType,
  RATE_LIMITS,
  rateLimitMiddleware,
  getClientId,
} from '../src/middleware/rate-limit';
import {
  getPresenceForUsers,
  updateLastActive,
} from '../src/api/presence';
import { getTypingUsers, getTypingForRooms } from '../src/api/typing';

vi.mock('cloudflare:workers', () => durableObjectMockFactory());

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

import { RoomDurableObject } from '../src/durable-objects/RoomDurableObject';
import presenceApp from '../src/api/presence';
import typingApp from '../src/api/typing';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DAVE = '@dave:example.com';
const ROOM = '!r:example.com';
const ROOM2 = '!r2:example.com';
const SERVER = 'example.com';
const NOW = 1_700_000_000_000;
const PRESENCE_TIMEOUT = 5 * 60 * 1000;
const DEFAULT_TYPING_TIMEOUT = 30_000;
const MAX_TYPING_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

type PresenceRow = {
  user_id: string;
  presence: string;
  status_msg: string | null;
  last_active_ts: number;
};

type Membership = { room_id: string; user_id: string; membership: string };
type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type RoomFetch = { url: string; method: string; body?: unknown };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const kv = {
    data,
    puts,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      delete data[key];
    },
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
  };
}

function createPresenceDb(opts: {
  users?: string[];
  presence?: PresenceRow[];
  memberships?: Membership[];
} = {}) {
  const users = new Set(opts.users ?? [USER, BOB, CAROL, DAVE]);
  const presence = opts.presence ?? [];
  const memberships = opts.memberships ?? [];
  const inserts: Array<{ sql: string; args: unknown[] }> = [];

  const db = {
    users,
    presence,
    memberships,
    inserts,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT user_id FROM users WHERE user_id = ?')) {
                const userId = args[0] as string;
                return (users.has(userId) ? { user_id: userId } : null) as T;
              }
              if (
                sql.includes('FROM presence') &&
                sql.includes('WHERE user_id = ?') &&
                !sql.includes('INSERT')
              ) {
                const userId = args[0] as string;
                const row = presence.find((p) => p.user_id === userId);
                if (!row) return null;
                return {
                  presence: row.presence,
                  status_msg: row.status_msg,
                  last_active_ts: row.last_active_ts,
                } as T;
              }
              return null as T;
            },
            async all<T>() {
              if (
                sql.includes('SUBSTR(rm2.user_id') &&
                sql.includes('room_memberships rm1')
              ) {
                return { results: [] as T[] };
              }
              if (sql.includes('FROM presence') && sql.includes('IN (')) {
                const ids = args as string[];
                const results = ids
                  .map((id) => {
                    const row = presence.find((p) => p.user_id === id);
                    if (!row) return null;
                    return {
                      user_id: id,
                      presence: row.presence,
                      status_msg: row.status_msg,
                      last_active_ts: row.last_active_ts,
                    };
                  })
                  .filter(Boolean) as T[];
                return { results };
              }
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO presence')) {
                inserts.push({ sql, args });
                const [userId, presenceState, statusMsg, lastActiveTs] = args as [
                  string,
                  string,
                  string | null,
                  number,
                ];
                const idx = presence.findIndex((p) => p.user_id === userId);
                const row: PresenceRow = {
                  user_id: userId,
                  presence: presenceState,
                  status_msg: statusMsg,
                  last_active_ts: lastActiveTs,
                };
                if (idx >= 0) presence[idx] = row;
                else presence.push(row);
                return { success: true, meta: { changes: 1, last_row_id: 1 } };
              }
              if (sql.includes('UPDATE presence SET last_active_ts')) {
                const [ts, userId] = args as [number, string];
                const row = presence.find((p) => p.user_id === userId);
                if (row) row.last_active_ts = ts;
                return { success: true, meta: { changes: row ? 1 : 0, last_row_id: 0 } };
              }
              return { success: true, meta: { changes: 0, last_row_id: 0 } };
            },
          };
        },
      };
    },
  };

  return db;
}

type PresenceDb = ReturnType<typeof createPresenceDb>;

function createPresenceEnv(opts: { db?: PresenceDb; cache?: ReturnType<typeof mockKv> } = {}) {
  const db = opts.db ?? createPresenceDb();
  const cache = opts.cache ?? mockKv();
  const env = {
    DB: db as unknown as D1Database,
    CACHE: cache,
    SERVER_NAME: SERVER,
    FEDERATION: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => ({
        fetch: async () => Response.json({ ok: true }),
      }),
    },
    _db: db,
    _cache: cache,
  };
  return env as unknown as Env & typeof env;
}

function createTypingDb(memberships: Membership[] = []) {
  return {
    memberships,
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
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              throw new Error(`Unexpected run: ${sql.slice(0, 80)}`);
            },
          };
        },
      };
    },
  };
}

function createRoomDOStub(opts: {
  typingByRoom?: Record<string, string[]>;
  throwOn?: string;
} = {}) {
  const fetches: RoomFetch[] = [];
  const typing = { ...(opts.typingByRoom ?? {}) };
  return {
    fetches,
    typing,
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      const url = new URL(req.url);
      fetches.push({ url: req.url, method: req.method, body });
      if (opts.throwOn && url.pathname.endsWith(opts.throwOn)) {
        throw new Error('room DO boom');
      }
      if (url.pathname.endsWith('/typing') && req.method === 'GET') {
        // Resolve room from idFromName via stub env — caller sets typing map by room
        return Response.json({ user_ids: [] });
      }
      return Response.json({ ok: true });
    },
  };
}

function makeRoom() {
  const state = new FakeDurableObjectState();
  return {
    state,
    do: new RoomDurableObject(state as unknown as DurableObjectState, {} as Env),
  };
}

async function presenceRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await presenceApp.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text };
    }
  }
  return { status: res.status, body };
}

async function typingRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await typingApp.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text };
    }
  }
  return { status: res.status, body };
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

function statusPath(userId: string) {
  return `/_matrix/client/v3/presence/${encodeURIComponent(userId)}/status`;
}

function typingPath(roomId = ROOM, userId = USER) {
  return `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`;
}

function makeRateLimitContext(
  opts: {
    userId?: string;
    headers?: Record<string, string>;
    env?: Partial<AppEnv['Bindings']>;
    path?: string;
    method?: string;
  } = {}
): Context<AppEnv> & { _headers: Record<string, string> } {
  const headers = opts.headers ?? {};
  const setHeaders: Record<string, string> = {};
  return {
    get: (key: string) => (key === 'userId' ? opts.userId : undefined),
    req: {
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
      path: opts.path ?? '/_matrix/client/v3/presence/@alice:example.com/status',
      method: opts.method ?? 'PUT',
    },
    env: opts.env ?? {},
    header: (name: string, value: string) => {
      setHeaders[name] = value;
    },
    json: (body: unknown, status?: number) => ({
      body,
      status: status ?? 200,
      headers: setHeaders,
    }),
    _headers: setHeaders,
  } as unknown as Context<AppEnv> & { _headers: Record<string, string> };
}

function mockRateLimitBinding(fetchImpl: (req: Request) => Promise<Response>) {
  const idFromName = vi.fn((name: string) => ({ name }));
  const get = vi.fn(() => ({ fetch: fetchImpl }));
  return { idFromName, get };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ===========================================================================
// Room DO — typing timeout expiry leftovers
// ===========================================================================

describe('presence-typing leftovers: Room DO typing timeout expiry', () => {
  const timeouts = [1, 100, 1_000, 5_000, 10_000, 30_000, 60_000, 90_000, 120_000];

  for (const timeout of timeouts) {
    it(`expires typer at exact timeout boundary (${timeout}ms)`, async () => {
      const { do: room } = makeRoom();
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: USER,
            typing: true,
            timeout,
          }),
        })
      );

      vi.setSystemTime(NOW + timeout - 1);
      expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
        user_ids: [USER],
      });

      vi.setSystemTime(NOW + timeout);
      expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
        user_ids: [],
      });
    });
  }

  it('clamps oversize timeout then expires at MAX (not requested)', async () => {
    const { do: room } = makeRoom();
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({
          user_id: USER,
          typing: true,
          timeout: 999_999,
        }),
      })
    );

    vi.setSystemTime(NOW + MAX_TYPING_TIMEOUT - 1);
    expect(
      ((await (await room.fetch(new Request('https://do/typing'))).json()) as { user_ids: string[] })
        .user_ids
    ).toEqual([USER]);

    vi.setSystemTime(NOW + MAX_TYPING_TIMEOUT);
    expect(
      ((await (await room.fetch(new Request('https://do/typing'))).json()) as { user_ids: string[] })
        .user_ids
    ).toEqual([]);
  });

  it('default timeout when omitted expires at 30s', async () => {
    const { do: room } = makeRoom();
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: USER, typing: true }),
      })
    );
    vi.setSystemTime(NOW + DEFAULT_TYPING_TIMEOUT - 1);
    expect(
      ((await (await room.fetch(new Request('https://do/typing'))).json()) as { user_ids: string[] })
        .user_ids
    ).toContain(USER);
    vi.setSystemTime(NOW + DEFAULT_TYPING_TIMEOUT);
    expect(
      ((await (await room.fetch(new Request('https://do/typing'))).json()) as { user_ids: string[] })
        .user_ids
    ).toEqual([]);
  });

  it('explicit stop clears before timeout would fire', async () => {
    const { do: room } = makeRoom();
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: USER, typing: true, timeout: 60_000 }),
      })
    );
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: USER, typing: false }),
      })
    );
    vi.setSystemTime(NOW + 1);
    expect(
      ((await (await room.fetch(new Request('https://do/typing'))).json()) as { user_ids: string[] })
        .user_ids
    ).toEqual([]);
  });
});

// ===========================================================================
// Room DO — multi-user typing coalescing leftovers
// ===========================================================================

describe('presence-typing leftovers: multi-user typing coalescing', () => {
  it('coalesces concurrent typers into a single GET user_ids list', async () => {
    const { do: room } = makeRoom();
    for (const uid of [USER, BOB, CAROL]) {
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({ user_id: uid, typing: true, timeout: 10_000 }),
        })
      );
    }
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: [USER, BOB, CAROL],
    });
  });

  it('same-user re-typing coalesces into one map entry (refreshes expiry)', async () => {
    const { do: room } = makeRoom();
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: USER, typing: true, timeout: 5_000 }),
      })
    );
    vi.setSystemTime(NOW + 4_000);
    // Refresh with a new 10s window from the new now
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: USER, typing: true, timeout: 10_000 }),
      })
    );

    const typingUsers = (
      room as unknown as { typingUsers: Map<string, { expiresAt: number }> }
    ).typingUsers;
    expect(typingUsers.size).toBe(1);
    expect(typingUsers.get(USER)?.expiresAt).toBe(NOW + 4_000 + 10_000);

    vi.setSystemTime(NOW + 4_000 + 10_000 - 1);
    expect(
      ((await (await room.fetch(new Request('https://do/typing'))).json()) as { user_ids: string[] })
        .user_ids
    ).toEqual([USER]);
    vi.setSystemTime(NOW + 4_000 + 10_000);
    expect(
      ((await (await room.fetch(new Request('https://do/typing'))).json()) as { user_ids: string[] })
        .user_ids
    ).toEqual([]);
  });

  it('independent expiry: short-timeout user drops while long-timeout remains', async () => {
    const { do: room } = makeRoom();
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: USER, typing: true, timeout: 2_000 }),
      })
    );
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: BOB, typing: true, timeout: 10_000 }),
      })
    );

    vi.setSystemTime(NOW + 2_000);
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: [BOB],
    });

    vi.setSystemTime(NOW + 10_000);
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: [],
    });
  });

  it('stopping one typer does not clear others', async () => {
    const { do: room } = makeRoom();
    for (const uid of [USER, BOB, CAROL]) {
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({ user_id: uid, typing: true, timeout: 20_000 }),
        })
      );
    }
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: BOB, typing: false }),
      })
    );
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: [USER, CAROL],
    });
  });

  const pairTimeouts: Array<[number, number]> = [
    [1_000, 2_000],
    [2_000, 5_000],
    [5_000, 10_000],
    [10_000, 30_000],
    [30_000, 60_000],
    [60_000, 120_000],
    [100, 120_000],
    [1, 30_000],
  ];

  for (const [shortMs, longMs] of pairTimeouts) {
    it(`coalesced pair expiry short=${shortMs} long=${longMs}`, async () => {
      const { do: room } = makeRoom();
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({ user_id: USER, typing: true, timeout: shortMs }),
        })
      );
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({ user_id: BOB, typing: true, timeout: longMs }),
        })
      );

      vi.setSystemTime(NOW + shortMs - 1);
      expect(
        (
          (await (await room.fetch(new Request('https://do/typing'))).json()) as {
            user_ids: string[];
          }
        ).user_ids.sort()
      ).toEqual([USER, BOB].sort());

      vi.setSystemTime(NOW + shortMs);
      expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
        user_ids: [BOB],
      });

      vi.setSystemTime(NOW + longMs);
      expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
        user_ids: [],
      });
    });
  }

  it('four-user staggered expiry keeps only still-active typers', async () => {
    const { do: room } = makeRoom();
    const schedule: Array<[string, number]> = [
      [USER, 1_000],
      [BOB, 2_000],
      [CAROL, 3_000],
      [DAVE, 4_000],
    ];
    for (const [uid, timeout] of schedule) {
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({ user_id: uid, typing: true, timeout }),
        })
      );
    }

    vi.setSystemTime(NOW + 1_500);
    expect(
      (
        (await (await room.fetch(new Request('https://do/typing'))).json()) as {
          user_ids: string[];
        }
      ).user_ids.sort()
    ).toEqual([BOB, CAROL, DAVE].sort());

    vi.setSystemTime(NOW + 3_500);
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: [DAVE],
    });
  });

  it('re-typing after stop re-enters the coalesced set', async () => {
    const { do: room } = makeRoom();
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: USER, typing: true, timeout: 10_000 }),
      })
    );
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: BOB, typing: true, timeout: 10_000 }),
      })
    );
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: USER, typing: false }),
      })
    );
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: [BOB],
    });
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: USER, typing: true, timeout: 10_000 }),
      })
    );
    expect(
      (
        (await (await room.fetch(new Request('https://do/typing'))).json()) as {
          user_ids: string[];
        }
      ).user_ids.sort()
    ).toEqual([USER, BOB].sort());
  });
});

// ===========================================================================
// Presence HTTP — offline/online transitions + timeout expiry
// ===========================================================================

describe('presence-typing leftovers: offline/online HTTP transitions', () => {
  const transitions: Array<{
    from: string;
    to: string;
    status_msg?: string;
  }> = [
    { from: 'offline', to: 'online' },
    { from: 'online', to: 'offline' },
    { from: 'online', to: 'unavailable' },
    { from: 'unavailable', to: 'online' },
    { from: 'offline', to: 'unavailable' },
    { from: 'unavailable', to: 'offline' },
    { from: 'online', to: 'online', status_msg: 'still here' },
    { from: 'offline', to: 'online', status_msg: 'back' },
    { from: 'online', to: 'offline', status_msg: 'gone' },
    { from: 'unavailable', to: 'online', status_msg: 'ready' },
  ];

  for (const [i, t] of transitions.entries()) {
    it(`PUT transition ${i}: ${t.from} → ${t.to}${t.status_msg ? ` (${t.status_msg})` : ''}`, async () => {
      const db = createPresenceDb({
        presence: [
          {
            user_id: USER,
            presence: t.from,
            status_msg: 'old',
            last_active_ts: NOW - 1_000,
          },
        ],
      });
      const env = createPresenceEnv({ db });
      const body: { presence: string; status_msg?: string } = { presence: t.to };
      if (t.status_msg !== undefined) body.status_msg = t.status_msg;

      const put = await presenceRequest(env, statusPath(USER), jsonInit('PUT', body));
      expect(put.status).toBe(200);
      expect(db.presence[0].presence).toBe(t.to);
      expect(db.presence[0].last_active_ts).toBe(NOW);

      const get = await presenceRequest(env, statusPath(USER));
      expect(get.status).toBe(200);
      expect(get.body.presence).toBe(t.to);
      if (t.to === 'online') {
        expect(get.body.currently_active).toBe(true);
      } else {
        expect(get.body.currently_active).toBe(false);
      }
    });
  }

  it('online → clock past TIMEOUT → GET reports unavailable', async () => {
    const env = createPresenceEnv({ db: createPresenceDb({ memberships: [] }) });
    await presenceRequest(env, statusPath(USER), jsonInit('PUT', { presence: 'online' }));

    let get = await presenceRequest(env, statusPath(USER));
    expect(get.body).toMatchObject({ presence: 'online', currently_active: true });

    vi.setSystemTime(NOW + PRESENCE_TIMEOUT);
    get = await presenceRequest(env, statusPath(USER));
    expect(get.body).toMatchObject({
      presence: 'unavailable',
      currently_active: false,
      last_active_ago: PRESENCE_TIMEOUT,
    });
  });

  it('online → TIMEOUT−1 stays online; TIMEOUT remaps unavailable', async () => {
    const env = createPresenceEnv({ db: createPresenceDb({ memberships: [] }) });
    await presenceRequest(env, statusPath(USER), jsonInit('PUT', { presence: 'online' }));

    vi.setSystemTime(NOW + PRESENCE_TIMEOUT - 1);
    expect((await presenceRequest(env, statusPath(USER))).body.presence).toBe('online');

    vi.setSystemTime(NOW + PRESENCE_TIMEOUT);
    expect((await presenceRequest(env, statusPath(USER))).body.presence).toBe('unavailable');
  });

  it('offline stays offline after TIMEOUT (no remap)', async () => {
    const env = createPresenceEnv({ db: createPresenceDb({ memberships: [] }) });
    await presenceRequest(
      env,
      statusPath(USER),
      jsonInit('PUT', { presence: 'offline', status_msg: 'zzz' })
    );
    vi.setSystemTime(NOW + PRESENCE_TIMEOUT * 3);
    const get = await presenceRequest(env, statusPath(USER));
    expect(get.body).toMatchObject({
      presence: 'offline',
      status_msg: 'zzz',
      currently_active: false,
    });
  });

  it('offline → online → offline lifecycle refreshes last_active each PUT', async () => {
    const env = createPresenceEnv({ db: createPresenceDb({ memberships: [] }) });
    await presenceRequest(env, statusPath(USER), jsonInit('PUT', { presence: 'offline' }));
    expect(env._db.presence[0].last_active_ts).toBe(NOW);

    vi.setSystemTime(NOW + 60_000);
    await presenceRequest(env, statusPath(USER), jsonInit('PUT', { presence: 'online' }));
    expect(env._db.presence[0].last_active_ts).toBe(NOW + 60_000);
    expect((await presenceRequest(env, statusPath(USER))).body.presence).toBe('online');

    vi.setSystemTime(NOW + 120_000);
    await presenceRequest(env, statusPath(USER), jsonInit('PUT', { presence: 'offline' }));
    expect(env._db.presence[0].last_active_ts).toBe(NOW + 120_000);
    expect((await presenceRequest(env, statusPath(USER))).body).toMatchObject({
      presence: 'offline',
      currently_active: false,
    });
  });

  it('KV write-through mirrors transition then serves GET without D1 presence select', async () => {
    const db = createPresenceDb({ memberships: [] });
    const cache = mockKv();
    const env = createPresenceEnv({ db, cache });
    await presenceRequest(
      env,
      statusPath(USER),
      jsonInit('PUT', { presence: 'online', status_msg: 'hi' })
    );
    expect(cache.puts[0].key).toBe(`presence:${USER}`);
    expect(JSON.parse(cache.puts[0].value)).toMatchObject({
      presence: 'online',
      status_msg: 'hi',
      last_active_ts: NOW,
    });

    // Clear D1 row to prove GET is served from KV
    db.presence.length = 0;
    const get = await presenceRequest(env, statusPath(USER));
    expect(get.body).toMatchObject({
      presence: 'online',
      status_msg: 'hi',
      currently_active: true,
    });
  });

  it('stale KV online remaps to unavailable on GET', async () => {
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: null,
        last_active_ts: NOW - PRESENCE_TIMEOUT - 5,
      }),
    });
    const env = createPresenceEnv({
      db: createPresenceDb({ users: [USER], presence: [] }),
      cache,
    });
    const get = await presenceRequest(env, statusPath(USER));
    expect(get.body).toMatchObject({
      presence: 'unavailable',
      currently_active: false,
    });
  });

  const softStates = ['online', 'offline', 'unavailable'] as const;
  for (let i = 0; i < 12; i++) {
    const a = softStates[i % 3];
    const b = softStates[(i + 1) % 3];
    it(`soft transition flood ${i}: ${a}→${b}`, async () => {
      const env = createPresenceEnv({ db: createPresenceDb({ memberships: [] }) });
      await presenceRequest(env, statusPath(USER), jsonInit('PUT', { presence: a }));
      await presenceRequest(
        env,
        statusPath(USER),
        jsonInit('PUT', { presence: b, status_msg: `msg-${i}` })
      );
      const get = await presenceRequest(env, statusPath(USER));
      expect(get.body.presence).toBe(b);
      expect(get.body.status_msg).toBe(`msg-${i}`);
      expect(get.body.currently_active).toBe(b === 'online');
    });
  }
});

// ===========================================================================
// Presence helpers — multi-user + updateLastActive refresh after expiry window
// ===========================================================================

describe('presence-typing leftovers: getPresenceForUsers transitions', () => {
  function helperDb(rows: Map<string, Omit<PresenceRow, 'user_id'>>) {
    const updates: Array<{ ts: number; userId: string }> = [];
    const db = {
      updates,
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async all<T>() {
                if (!sql.includes('FROM presence') || !sql.includes('IN (')) {
                  return { results: [] as T[] };
                }
                const ids = args as string[];
                const results = ids
                  .map((id) => {
                    const row = rows.get(id);
                    if (!row) return null;
                    return {
                      user_id: id,
                      presence: row.presence,
                      status_msg: row.status_msg,
                      last_active_ts: row.last_active_ts,
                    };
                  })
                  .filter(Boolean) as T[];
                return { results };
              },
              async run() {
                if (sql.includes('UPDATE presence SET last_active_ts')) {
                  const [ts, userId] = args as [number, string];
                  updates.push({ ts, userId });
                  const existing = rows.get(userId);
                  if (existing) {
                    rows.set(userId, { ...existing, last_active_ts: ts });
                  }
                }
                return { meta: { changes: 0 } };
              },
              async first() {
                return null;
              },
            };
          },
        };
      },
    };
    return db as unknown as D1Database & { updates: typeof updates };
  }

  it('mixed multi-user: online/offline/unavailable with independent activity', async () => {
    const db = helperDb(
      new Map([
        [
          USER,
          {
            presence: 'online',
            status_msg: null,
            last_active_ts: NOW - 1_000,
          },
        ],
        [
          BOB,
          {
            presence: 'offline',
            status_msg: 'away',
            last_active_ts: NOW - 1_000,
          },
        ],
        [
          CAROL,
          {
            presence: 'online',
            status_msg: null,
            last_active_ts: NOW - PRESENCE_TIMEOUT - 1,
          },
        ],
      ])
    );

    const result = await getPresenceForUsers(db, [USER, BOB, CAROL]);
    expect(result[USER]).toMatchObject({ presence: 'online', currently_active: true });
    expect(result[BOB]).toMatchObject({ presence: 'offline', currently_active: false });
    expect(result[CAROL]).toMatchObject({
      presence: 'unavailable',
      currently_active: false,
    });
  });

  it('updateLastActive after near-timeout keeps user online on next read', async () => {
    const rows = new Map([
      [
        USER,
        {
          presence: 'online',
          status_msg: null,
          last_active_ts: NOW - (PRESENCE_TIMEOUT - 1_000),
        },
      ],
    ]);
    const db = helperDb(rows);

    expect((await getPresenceForUsers(db, [USER]))[USER].presence).toBe('online');

    vi.setSystemTime(NOW + 500);
    await updateLastActive(db, USER);
    expect(db.updates[0]).toEqual({ ts: NOW + 500, userId: USER });

    vi.setSystemTime(NOW + 500 + PRESENCE_TIMEOUT - 1);
    expect((await getPresenceForUsers(db, [USER]))[USER]).toMatchObject({
      presence: 'online',
      currently_active: true,
    });

    vi.setSystemTime(NOW + 500 + PRESENCE_TIMEOUT);
    expect((await getPresenceForUsers(db, [USER]))[USER]).toMatchObject({
      presence: 'unavailable',
      currently_active: false,
    });
  });

  for (const offset of [
    PRESENCE_TIMEOUT - 2,
    PRESENCE_TIMEOUT - 1,
    PRESENCE_TIMEOUT,
    PRESENCE_TIMEOUT + 1,
    PRESENCE_TIMEOUT * 2,
  ]) {
    it(`activity cutoff soft offset=${offset}`, async () => {
      const db = helperDb(
        new Map([
          [
            USER,
            {
              presence: 'online',
              status_msg: null,
              last_active_ts: NOW - offset,
            },
          ],
        ])
      );
      const row = (await getPresenceForUsers(db, [USER]))[USER];
      const shouldBeActive = offset < PRESENCE_TIMEOUT;
      expect(row.presence).toBe(shouldBeActive ? 'online' : 'unavailable');
      expect(row.currently_active).toBe(shouldBeActive);
      expect(row.last_active_ago).toBe(offset);
    });
  }
});

// ===========================================================================
// Typing helpers — multi-room / multi-user coalescing leftovers
// ===========================================================================

describe('presence-typing leftovers: getTypingUsers / getTypingForRooms coalescing', () => {
  function envWithTyping(
    byRoom: Record<
      string,
      { user_ids: string[] } | { throw: Error }
    >
  ): Env {
    return {
      ROOMS: {
        idFromName(roomId: string) {
          return { name: roomId };
        },
        get(id: { name: string }) {
          return {
            async fetch() {
              const entry = byRoom[id.name];
              if (!entry) {
                return Response.json({ user_ids: [] });
              }
              if ('throw' in entry) throw entry.throw;
              return Response.json({ user_ids: entry.user_ids });
            },
          };
        },
      },
    } as unknown as Env;
  }

  it('returns multi-user coalesced list for a single room', async () => {
    const env = envWithTyping({
      [ROOM]: { user_ids: [USER, BOB, CAROL] },
    });
    expect(await getTypingUsers(env, ROOM)).toEqual([USER, BOB, CAROL]);
  });

  it('aggregates multi-user typing across rooms and omits empty', async () => {
    const env = envWithTyping({
      [ROOM]: { user_ids: [USER, BOB] },
      [ROOM2]: { user_ids: [] },
      '!quiet:example.com': { user_ids: [CAROL] },
    });
    expect(
      await getTypingForRooms(env, [ROOM, ROOM2, '!quiet:example.com'])
    ).toEqual({
      [ROOM]: [USER, BOB],
      '!quiet:example.com': [CAROL],
    });
  });

  const softMultiUserCounts = [1, 2, 3, 4, 5, 8, 10, 12];
  for (const n of softMultiUserCounts) {
    it(`soft multi-user coalescing n=${n}`, async () => {
      const users = Array.from({ length: n }, (_, i) => `@u${i}:example.com`);
      const env = envWithTyping({ [ROOM]: { user_ids: users } });
      expect(await getTypingUsers(env, ROOM)).toEqual(users);
      expect(await getTypingForRooms(env, [ROOM])).toEqual({ [ROOM]: users });
    });
  }

  it('isolates DO throw for one room while coalescing others', async () => {
    const env = envWithTyping({
      [ROOM]: { throw: new Error('boom') },
      [ROOM2]: { user_ids: [USER, BOB] },
    });
    expect(await getTypingForRooms(env, [ROOM, ROOM2])).toEqual({
      [ROOM2]: [USER, BOB],
    });
  });
});

// ===========================================================================
// Typing HTTP — timeout forwarding leftovers (API → Room DO)
// ===========================================================================

describe('presence-typing leftovers: typing HTTP timeout forwarding', () => {
  function typingEnv(roomDO: ReturnType<typeof createRoomDOStub>) {
    const db = createTypingDb([{ room_id: ROOM, user_id: USER, membership: 'join' }]);
    return {
      DB: db as unknown as D1Database,
      SERVER_NAME: SERVER,
      ROOMS: {
        idFromName: (name: string) => ({ name, toString: () => name }),
        get: () => roomDO,
      },
      _roomDO: roomDO,
    } as unknown as Env & { _roomDO: ReturnType<typeof createRoomDOStub> };
  }

  const forwardCases: Array<{ typing: boolean; timeout?: number; expected: number }> = [
    { typing: true, expected: DEFAULT_TYPING_TIMEOUT },
    { typing: true, timeout: 1, expected: 1 },
    { typing: true, timeout: 29_999, expected: 29_999 },
    { typing: true, timeout: 30_000, expected: 30_000 },
    { typing: true, timeout: 60_000, expected: 60_000 },
    { typing: true, timeout: 119_999, expected: 119_999 },
    { typing: true, timeout: 120_000, expected: 120_000 },
    { typing: true, timeout: 120_001, expected: MAX_TYPING_TIMEOUT },
    { typing: true, timeout: 500_000, expected: MAX_TYPING_TIMEOUT },
    { typing: false, timeout: 90_000, expected: DEFAULT_TYPING_TIMEOUT },
    { typing: false, expected: DEFAULT_TYPING_TIMEOUT },
  ];

  for (const [i, c] of forwardCases.entries()) {
    it(`forwards timeout case ${i}: typing=${c.typing} req=${c.timeout ?? 'omit'} → ${c.expected}`, async () => {
      const roomDO = createRoomDOStub();
      const env = typingEnv(roomDO);
      const body: { typing: boolean; timeout?: number } = { typing: c.typing };
      if (c.timeout !== undefined) body.timeout = c.timeout;
      const res = await typingRequest(env, typingPath(), jsonInit('PUT', body));
      expect(res.status).toBe(200);
      expect(roomDO.fetches[0].body).toEqual({
        user_id: USER,
        typing: c.typing,
        timeout: c.expected,
      });
    });
  }

  it('start then stop sequence sends two DO PUTs', async () => {
    const roomDO = createRoomDOStub();
    const env = typingEnv(roomDO);
    await typingRequest(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 5_000 }));
    await typingRequest(env, typingPath(), jsonInit('PUT', { typing: false }));
    expect(roomDO.fetches).toHaveLength(2);
    expect(roomDO.fetches[0].body).toMatchObject({ typing: true, timeout: 5_000 });
    expect(roomDO.fetches[1].body).toMatchObject({ typing: false, timeout: DEFAULT_TYPING_TIMEOUT });
  });
});

// ===========================================================================
// Rate-limit stubs — presence / typing → default bucket
// ===========================================================================

describe('presence-typing leftovers: rate-limit stubs (default bucket)', () => {
  const presenceTypingPaths: Array<[string, string]> = [
    ['/_matrix/client/v3/presence/@alice:example.com/status', 'PUT'],
    ['/_matrix/client/v3/presence/@alice:example.com/status', 'GET'],
    ['/_matrix/client/v3/presence/@bob:example.com/status', 'GET'],
    ['/_matrix/client/v3/rooms/!r:example.com/typing/@alice:example.com', 'PUT'],
    [
      '/_matrix/client/v3/rooms/%21r%3Aexample.com/typing/%40alice%3Aexample.com',
      'PUT',
    ],
    ['/_matrix/client/v3/rooms/!r:example.com/typing/@bob:example.com', 'PUT'],
  ];

  for (const [path, method] of presenceTypingPaths) {
    it(`classifies ${method} ${path} as default (not send_message/sync)`, () => {
      expect(getRateLimitType(path, method)).toBe('default');
      expect(RATE_LIMITS.default).toEqual({ requests: 100, windowMs: 60_000 });
    });
  }

  it('typing PUT is not send_message (rooms/send regex only)', () => {
    expect(
      getRateLimitType('/_matrix/client/v3/rooms/!r:example.com/typing/@a:example.com', 'PUT')
    ).toBe('default');
    expect(
      getRateLimitType(
        '/_matrix/client/v3/rooms/!r:example.com/send/m.room.message/1',
        'PUT'
      )
    ).toBe('send_message');
  });

  it('middleware stubs RATE_LIMIT DO with default bucket for presence PUT', async () => {
    const binding = mockRateLimitBinding(async (req) => {
      const body = (await req.json()) as {
        action: string;
        clientId: string;
        limit: number;
        windowMs: number;
      };
      expect(body).toEqual({
        action: 'check',
        clientId: 'user:@alice:example.com',
        limit: 100,
        windowMs: 60_000,
      });
      return Response.json({
        allowed: true,
        remaining: 99,
        resetAt: NOW + 60_000,
      });
    });
    const next = vi.fn(async () => 'ok');
    const ctx = makeRateLimitContext({
      userId: USER,
      path: '/_matrix/client/v3/presence/@alice:example.com/status',
      method: 'PUT',
      env: { RATE_LIMIT: binding } as Partial<AppEnv['Bindings']>,
    });

    await expect(rateLimitMiddleware(ctx, next)).resolves.toBe('ok');
    expect(binding.idFromName).toHaveBeenCalledWith('default');
    expect(ctx._headers['X-RateLimit-Limit']).toBe('100');
    expect(ctx._headers['X-RateLimit-Remaining']).toBe('99');
    expect(next).toHaveBeenCalledOnce();
  });

  it('middleware stubs RATE_LIMIT DO with default bucket for typing PUT', async () => {
    const binding = mockRateLimitBinding(async (req) => {
      const body = (await req.json()) as {
        action: string;
        clientId: string;
        limit: number;
        windowMs: number;
      };
      expect(body.action).toBe('check');
      expect(body.limit).toBe(RATE_LIMITS.default.requests);
      expect(body.windowMs).toBe(RATE_LIMITS.default.windowMs);
      return Response.json({
        allowed: true,
        remaining: 50,
        resetAt: NOW + 30_000,
      });
    });
    const next = vi.fn(async () => 'typed');
    const ctx = makeRateLimitContext({
      userId: USER,
      path: '/_matrix/client/v3/rooms/!r:example.com/typing/@alice:example.com',
      method: 'PUT',
      env: { RATE_LIMIT: binding } as Partial<AppEnv['Bindings']>,
    });

    await expect(rateLimitMiddleware(ctx, next)).resolves.toBe('typed');
    expect(binding.idFromName).toHaveBeenCalledWith('default');
    expect(ctx._headers['X-RateLimit-Limit']).toBe('100');
  });

  it('returns 429 when default-bucket DO denies presence traffic', async () => {
    const binding = mockRateLimitBinding(async () =>
      Response.json({
        allowed: false,
        remaining: 0,
        retryAfterMs: 2500,
        resetAt: NOW + 2500,
      })
    );
    const next = vi.fn();
    const ctx = makeRateLimitContext({
      userId: USER,
      path: '/_matrix/client/v3/presence/@alice:example.com/status',
      method: 'GET',
      env: { RATE_LIMIT: binding } as Partial<AppEnv['Bindings']>,
    });

    const res = (await rateLimitMiddleware(ctx, next)) as {
      status: number;
      body: { errcode: string };
    };
    expect(res.status).toBe(429);
    expect(res.body.errcode).toBe('M_LIMIT_EXCEEDED');
    expect(next).not.toHaveBeenCalled();
  });

  it('authenticated presence clientId prefers user bucket over CF IP', () => {
    expect(
      getClientId(
        makeRateLimitContext({
          userId: USER,
          headers: { 'CF-Connecting-IP': '203.0.113.9' },
        })
      )
    ).toBe(`user:${USER}`);
  });

  const softPaths = [
    '/_matrix/client/v3/presence/@u0:example.com/status',
    '/_matrix/client/v3/presence/@u1:example.com/status',
    '/_matrix/client/v3/presence/@u2:example.com/status',
    '/_matrix/client/v3/rooms/!a:example.com/typing/@u0:example.com',
    '/_matrix/client/v3/rooms/!b:example.com/typing/@u1:example.com',
    '/_matrix/client/v3/rooms/!c:example.com/typing/@u2:example.com',
  ];
  for (const [i, path] of softPaths.entries()) {
    it(`soft default-bucket flood ${i} for ${path}`, async () => {
      expect(getRateLimitType(path, i % 2 === 0 ? 'PUT' : 'GET')).toBe('default');
      const binding = mockRateLimitBinding(async () =>
        Response.json({ allowed: true, remaining: 100 - i, resetAt: NOW + 60_000 })
      );
      const next = vi.fn(async () => 'next');
      const ctx = makeRateLimitContext({
        userId: USER,
        path,
        method: i % 2 === 0 ? 'PUT' : 'GET',
        env: { RATE_LIMIT: binding } as Partial<AppEnv['Bindings']>,
      });
      await rateLimitMiddleware(ctx, next);
      expect(binding.idFromName).toHaveBeenCalledWith('default');
      expect(next).toHaveBeenCalledOnce();
    });
  }
});
