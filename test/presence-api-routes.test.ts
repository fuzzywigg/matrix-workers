/**
 * TOKENMAXX HEAVY deepen — presence API HTTP routes (PUT/GET status).
 * Helpers already covered in presence-helpers.test.ts — this file focuses on routes.
 * Tests-only — no product inventing.
 * Exercises own-user gate, validation, D1+KV write-through, federation EDU fan-out,
 * cache hit / D1 fallback, stale online→unavailable, and swallow of EDU failures.
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

import presenceApp from '../src/api/presence';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!r:example.com';
const SERVER = 'example.com';
const REMOTE = 'remote.example.org';
const USER_ENC = encodeURIComponent(USER);
const BOB_ENC = encodeURIComponent(BOB);

const NOW = 1_700_000_000_000;
const PRESENCE_TIMEOUT = 5 * 60 * 1000;

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  const kv = {
    data,
    puts,
    deletes,
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
      deletes.push(key);
      delete data[key];
    },
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
    deletes: string[];
  };
}

type PresenceRow = {
  user_id: string;
  presence: string;
  status_msg: string | null;
  last_active_ts: number;
};

type Membership = { room_id: string; user_id: string; membership: string };

type SqlCall = { sql: string; args: unknown[] };

type FedFetch = { url: string; method: string; body?: unknown };

function createFederationStub(opts: { fail?: boolean } = {}) {
  const fetches: FedFetch[] = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }
      fetches.push({ url: req.url, method: req.method, body });
      if (opts.fail) {
        throw new Error('federation send-edu boom');
      }
      return Response.json({ ok: true });
    },
  };
}

function createPresenceDb(opts: {
  users?: string[];
  presence?: PresenceRow[];
  memberships?: Membership[];
} = {}) {
  const users = new Set(opts.users ?? [USER, BOB]);
  const presence = opts.presence ?? [];
  const memberships = opts.memberships ?? [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const runs: SqlCall[] = [];

  const db = {
    users,
    presence,
    memberships,
    inserts,
    updates,
    selects,
    runs,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });

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

              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 160)}`);
            },

            async all<T>() {
              selects.push({ sql, args });

              // getServersInRoomsWithUser
              if (
                sql.includes('SUBSTR(rm2.user_id') &&
                sql.includes('room_memberships rm1')
              ) {
                const requester = args[0] as string;
                const joinedRooms = new Set(
                  memberships
                    .filter((m) => m.user_id === requester && m.membership === 'join')
                    .map((m) => m.room_id)
                );
                const servers = new Set<string>();
                for (const m of memberships) {
                  if (!joinedRooms.has(m.room_id) || m.membership !== 'join') continue;
                  if (m.user_id === requester) continue;
                  const idx = m.user_id.indexOf(':');
                  if (idx > 0) servers.add(m.user_id.slice(idx + 1));
                }
                return {
                  results: [...servers].map((server_name) => ({ server_name })),
                } as { results: T[] };
              }

              return { results: [] as T[] };
            },

            async run(): Promise<{
              meta: { changes: number; last_row_id: number };
              success: boolean;
            }> {
              runs.push({ sql, args });

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
                updates.push({ sql, args });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              throw new Error(`Unhandled run() SQL: ${sql.slice(0, 160)}`);
            },
          };
        },
      };
    },
  };

  return db;
}

type PresenceDb = ReturnType<typeof createPresenceDb>;
type FedStub = ReturnType<typeof createFederationStub>;
type CacheKv = ReturnType<typeof mockKv>;

function createEnv(opts: {
  db?: PresenceDb;
  cache?: CacheKv;
  federation?: FedStub;
  failFederation?: boolean;
} = {}) {
  const db = opts.db ?? createPresenceDb();
  const cache = opts.cache ?? mockKv();
  const federation = opts.federation ?? createFederationStub({ fail: opts.failFederation });
  const fedByServer = new Map<string, FedStub>();

  const env = {
    DB: db as unknown as D1Database,
    CACHE: cache,
    SERVER_NAME: SERVER,
    FEDERATION: {
      idFromName: (name: string) => {
        if (!fedByServer.has(name)) {
          fedByServer.set(name, federation);
        }
        return { name, toString: () => name };
      },
      get: (id: { name: string }) => {
        if (!fedByServer.has(id.name)) {
          fedByServer.set(id.name, federation);
        }
        return fedByServer.get(id.name) ?? federation;
      },
    },
    _db: db,
    _cache: cache,
    _federation: federation,
    _fedByServer: fedByServer,
  };

  return env as unknown as Env & typeof env;
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await presenceApp.request(`http://localhost${path}`, init, env);
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

function statusPath(userId: string): string {
  return `/_matrix/client/v3/presence/${encodeURIComponent(userId)}/status`;
}

function sharedRoomMemberships(remoteServers: string[] = [REMOTE]): Membership[] {
  return [
    { room_id: ROOM, user_id: USER, membership: 'join' },
    ...remoteServers.map((s) => ({
      room_id: ROOM,
      user_id: `@remote:${s}`,
      membership: 'join' as const,
    })),
    { room_id: ROOM, user_id: BOB, membership: 'join' },
  ];
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

// ---------------------------------------------------------------------------
// PUT /presence/:userId/status
// ---------------------------------------------------------------------------

describe('presence PUT /status — auth & validation', () => {
  it('forbids setting presence for another user', async () => {
    const env = createEnv();
    const res = await request(env, statusPath(BOB), jsonInit('PUT', { presence: 'online' }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot set presence for other users',
    });
    expect(env._db.inserts).toHaveLength(0);
    expect(env._cache.puts).toHaveLength(0);
  });

  it('rejects bad JSON body', async () => {
    const env = createEnv();
    const res = await request(env, statusPath(USER), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer t',
      },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects missing presence field', async () => {
    const env = createEnv();
    const res = await request(env, statusPath(USER), jsonInit('PUT', { status_msg: 'hi' }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
    expect(String((res.body as { error: string }).error)).toContain('Invalid presence state');
  });

  it('rejects invalid presence state "busy"', async () => {
    const env = createEnv();
    const res = await request(env, statusPath(USER), jsonInit('PUT', { presence: 'busy' }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
    expect(String((res.body as { error: string }).error)).toContain('busy');
    expect(String((res.body as { error: string }).error)).toContain('online');
  });

  it('rejects empty-string presence', async () => {
    const env = createEnv();
    const res = await request(env, statusPath(USER), jsonInit('PUT', { presence: '' }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('rejects null presence', async () => {
    const env = createEnv();
    const res = await request(env, statusPath(USER), jsonInit('PUT', { presence: null }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('rejects unknown state "away"', async () => {
    const env = createEnv();
    const res = await request(env, statusPath(USER), jsonInit('PUT', { presence: 'away' }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });
});

describe('presence PUT /status — success writes', () => {
  it('sets online without status_msg (null in D1+KV)', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    const res = await request(env, statusPath(USER), jsonInit('PUT', { presence: 'online' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});

    expect(env._db.inserts).toHaveLength(1);
    expect(env._db.inserts[0].args).toEqual([USER, 'online', null, NOW]);
    expect(env._db.presence[0]).toMatchObject({
      user_id: USER,
      presence: 'online',
      status_msg: null,
      last_active_ts: NOW,
    });

    expect(env._cache.puts).toHaveLength(1);
    expect(env._cache.puts[0].key).toBe(`presence:${USER}`);
    expect(env._cache.puts[0].options).toEqual({ expirationTtl: 300 });
    expect(JSON.parse(env._cache.puts[0].value)).toEqual({
      presence: 'online',
      status_msg: null,
      last_active_ts: NOW,
    });
  });

  it('sets online with status_msg', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    const res = await request(
      env,
      statusPath(USER),
      jsonInit('PUT', { presence: 'online', status_msg: 'coding' })
    );
    expect(res.status).toBe(200);
    expect(env._db.inserts[0].args).toEqual([USER, 'online', 'coding', NOW]);
    expect(JSON.parse(env._cache.puts[0].value)).toMatchObject({
      presence: 'online',
      status_msg: 'coding',
    });
  });

  it('sets offline with status_msg', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    const res = await request(
      env,
      statusPath(USER),
      jsonInit('PUT', { presence: 'offline', status_msg: 'gone' })
    );
    expect(res.status).toBe(200);
    expect(env._db.presence[0].presence).toBe('offline');
    expect(env._db.presence[0].status_msg).toBe('gone');
  });

  it('sets unavailable without status_msg', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    const res = await request(
      env,
      statusPath(USER),
      jsonInit('PUT', { presence: 'unavailable' })
    );
    expect(res.status).toBe(200);
    expect(env._db.inserts[0].args).toEqual([USER, 'unavailable', null, NOW]);
  });

  it('upserts existing presence row on conflict', async () => {
    const db = createPresenceDb({
      presence: [
        {
          user_id: USER,
          presence: 'offline',
          status_msg: 'old',
          last_active_ts: NOW - 10_000,
        },
      ],
      memberships: [],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      statusPath(USER),
      jsonInit('PUT', { presence: 'online', status_msg: 'new' })
    );
    expect(res.status).toBe(200);
    expect(db.presence).toHaveLength(1);
    expect(db.presence[0]).toMatchObject({
      presence: 'online',
      status_msg: 'new',
      last_active_ts: NOW,
    });
  });

  it('treats empty status_msg as null', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    const res = await request(
      env,
      statusPath(USER),
      jsonInit('PUT', { presence: 'online', status_msg: '' })
    );
    expect(res.status).toBe(200);
    expect(env._db.inserts[0].args[2]).toBeNull();
  });

  it('writes KV with TTL exactly 300 seconds (5 minutes)', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    await request(env, statusPath(USER), jsonInit('PUT', { presence: 'offline' }));
    expect(env._cache.puts[0].options?.expirationTtl).toBe(5 * 60);
  });
});

describe('presence PUT /status — federation EDU fan-out', () => {
  it('queues m.presence EDUs to remote servers excluding local SERVER_NAME', async () => {
    const db = createPresenceDb({
      memberships: sharedRoomMemberships([REMOTE, SERVER]),
    });
    const federation = createFederationStub();
    const env = createEnv({ db, federation });

    const res = await request(
      env,
      statusPath(USER),
      jsonInit('PUT', { presence: 'online', status_msg: 'here' })
    );
    expect(res.status).toBe(200);

    // Local server filtered; remote kept; bob's example.com also filtered as local
    const destinations = federation.fetches.map(
      (f) => (f.body as { destination: string }).destination
    );
    expect(destinations).toContain(REMOTE);
    expect(destinations).not.toContain(SERVER);
    expect(new Set(destinations).size).toBe(destinations.length);

    const edu = federation.fetches.find(
      (f) => (f.body as { destination: string }).destination === REMOTE
    );
    expect(edu?.method).toBe('POST');
    expect(edu?.url).toContain('/send-edu');
    expect(edu?.body).toEqual({
      destination: REMOTE,
      edu_type: 'm.presence',
      content: {
        push: [
          {
            user_id: USER,
            presence: 'online',
            status_msg: 'here',
            last_active_ago: 0,
            currently_active: true,
          },
        ],
      },
    });
  });

  it('sets currently_active false and omits status_msg in EDU when offline/no msg', async () => {
    const db = createPresenceDb({ memberships: sharedRoomMemberships() });
    const federation = createFederationStub();
    const env = createEnv({ db, federation });

    await request(env, statusPath(USER), jsonInit('PUT', { presence: 'offline' }));

    expect(federation.fetches).toHaveLength(1);
    const push = (federation.fetches[0].body as {
      content: { push: Array<{ currently_active: boolean; status_msg?: string }> };
    }).content.push[0];
    expect(push.currently_active).toBe(false);
    expect(push.status_msg).toBeUndefined();
  });

  it('does not queue EDUs when no remote servers share rooms', async () => {
    const db = createPresenceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const federation = createFederationStub();
    const env = createEnv({ db, federation });

    const res = await request(env, statusPath(USER), jsonInit('PUT', { presence: 'online' }));
    expect(res.status).toBe(200);
    expect(federation.fetches).toHaveLength(0);
  });

  it('dedupes duplicate remote server names from multiple rooms', async () => {
    const db = createPresenceDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: '!r2:example.com', user_id: USER, membership: 'join' },
        { room_id: ROOM, user_id: `@x:${REMOTE}`, membership: 'join' },
        { room_id: '!r2:example.com', user_id: `@y:${REMOTE}`, membership: 'join' },
      ],
    });
    const federation = createFederationStub();
    const env = createEnv({ db, federation });

    await request(env, statusPath(USER), jsonInit('PUT', { presence: 'unavailable' }));
    expect(federation.fetches).toHaveLength(1);
    expect((federation.fetches[0].body as { destination: string }).destination).toBe(REMOTE);
  });

  it('swallows federation EDU failures and still returns 200', async () => {
    const db = createPresenceDb({ memberships: sharedRoomMemberships() });
    const env = createEnv({ db, failFederation: true });

    const res = await request(env, statusPath(USER), jsonInit('PUT', { presence: 'online' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    // D1+KV still written
    expect(env._db.inserts).toHaveLength(1);
    expect(env._cache.puts).toHaveLength(1);
    expect(console.warn).toHaveBeenCalled();
  });

  it('swallows getServersInRoomsWithUser / all() failures', async () => {
    const db = createPresenceDb({ memberships: sharedRoomMemberships() });
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.includes('SUBSTR(rm2.user_id')) {
        return {
          bind: () => ({
            first: async () => null,
            all: async () => {
              throw new Error('d1 membership join boom');
            },
            run: async () => ({ success: true, meta: { changes: 0, last_row_id: 0 } }),
          }),
        };
      }
      return stmt;
    }) as typeof db.prepare;

    const env = createEnv({ db });
    const res = await request(env, statusPath(USER), jsonInit('PUT', { presence: 'online' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// GET /presence/:userId/status
// ---------------------------------------------------------------------------

describe('presence GET /status', () => {
  it('returns 404 when target user does not exist', async () => {
    const db = createPresenceDb({ users: [USER] });
    const env = createEnv({ db });
    const res = await request(env, statusPath(BOB), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'User not found' });
  });

  it('defaults to offline when user exists but no presence row/cache', async () => {
    const env = createEnv({ db: createPresenceDb({ users: [USER, BOB], presence: [] }) });
    const res = await request(env, statusPath(BOB), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      presence: 'offline',
      currently_active: false,
    });
    expect((res.body as Record<string, unknown>).status_msg).toBeUndefined();
    expect((res.body as Record<string, unknown>).last_active_ago).toBeUndefined();
  });

  it('returns KV cache hit without needing D1 presence row', async () => {
    const cache = mockKv({
      [`presence:${BOB}`]: JSON.stringify({
        presence: 'online',
        status_msg: 'cached',
        last_active_ts: NOW - 1000,
      }),
    });
    const db = createPresenceDb({ users: [USER, BOB], presence: [] });
    const env = createEnv({ db, cache });

    const res = await request(env, statusPath(BOB), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      presence: 'online',
      status_msg: 'cached',
      currently_active: true,
      last_active_ago: 1000,
    });
    // No D1 presence SELECT needed beyond user existence check
    const presenceSelects = db.selects.filter(
      (s) => s.sql.includes('FROM presence') && s.sql.includes('WHERE user_id')
    );
    expect(presenceSelects).toHaveLength(0);
  });

  it('falls back to D1 when KV miss', async () => {
    const db = createPresenceDb({
      users: [USER, BOB],
      presence: [
        {
          user_id: BOB,
          presence: 'unavailable',
          status_msg: 'brb',
          last_active_ts: NOW - 2000,
        },
      ],
    });
    const env = createEnv({ db, cache: mockKv() });
    const res = await request(env, statusPath(BOB), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      presence: 'unavailable',
      status_msg: 'brb',
      last_active_ago: 2000,
      currently_active: false,
    });
  });

  it('maps stale online (>5min) to unavailable and currently_active false', async () => {
    const staleTs = NOW - PRESENCE_TIMEOUT - 1;
    const db = createPresenceDb({
      users: [USER, BOB],
      presence: [
        {
          user_id: BOB,
          presence: 'online',
          status_msg: 'was online',
          last_active_ts: staleTs,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, statusPath(BOB), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      presence: 'unavailable',
      status_msg: 'was online',
      currently_active: false,
      last_active_ago: PRESENCE_TIMEOUT + 1,
    });
  });

  it('keeps online and currently_active true when last_active within 5min', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [
        {
          user_id: USER,
          presence: 'online',
          status_msg: null,
          last_active_ts: NOW - 60_000,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, statusPath(USER), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      presence: 'online',
      last_active_ago: 60_000,
      currently_active: true,
    });
    expect(Object.prototype.hasOwnProperty.call(res.body as object, 'status_msg')).toBe(false);
  });

  it('omits status_msg when null (KV path)', async () => {
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'offline',
        status_msg: null,
        last_active_ts: NOW - 500,
      }),
    });
    const env = createEnv({
      db: createPresenceDb({ users: [USER] }),
      cache,
    });
    const res = await request(env, statusPath(USER), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      presence: 'offline',
      last_active_ago: 500,
      currently_active: false,
    });
  });

  it('omits status_msg when null (D1 path)', async () => {
    const db = createPresenceDb({
      users: [BOB],
      presence: [
        {
          user_id: BOB,
          presence: 'offline',
          status_msg: null,
          last_active_ts: NOW,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/client/v3/presence/${BOB_ENC}/status`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status_msg).toBeUndefined();
  });

  it('does not remap offline to unavailable even when stale', async () => {
    const db = createPresenceDb({
      users: [BOB],
      presence: [
        {
          user_id: BOB,
          presence: 'offline',
          status_msg: 'zzz',
          last_active_ts: NOW - PRESENCE_TIMEOUT * 2,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, statusPath(BOB), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toMatchObject({
      presence: 'offline',
      status_msg: 'zzz',
      currently_active: false,
    });
  });

  it('does not remap unavailable to anything when stale', async () => {
    const db = createPresenceDb({
      users: [BOB],
      presence: [
        {
          user_id: BOB,
          presence: 'unavailable',
          status_msg: null,
          last_active_ts: NOW - PRESENCE_TIMEOUT * 3,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, statusPath(BOB), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toMatchObject({
      presence: 'unavailable',
      currently_active: false,
    });
  });

  it('computes last_active_ago as now - last_active_ts', async () => {
    const ts = NOW - 12345;
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 'x',
        last_active_ts: ts,
      }),
    });
    const env = createEnv({ db: createPresenceDb({ users: [USER] }), cache });
    const res = await request(env, `/_matrix/client/v3/presence/${USER_ENC}/status`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect((res.body as { last_active_ago: number }).last_active_ago).toBe(12345);
  });

  it('currently_active is false for fresh offline (isActive but not online)', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [
        {
          user_id: USER,
          presence: 'offline',
          status_msg: null,
          last_active_ts: NOW,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, statusPath(USER), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toMatchObject({
      presence: 'offline',
      currently_active: false,
      last_active_ago: 0,
    });
  });

  it('boundary: exactly PRESENCE_TIMEOUT ago is no longer active', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [
        {
          user_id: USER,
          presence: 'online',
          status_msg: null,
          last_active_ts: NOW - PRESENCE_TIMEOUT,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, statusPath(USER), {
      headers: { Authorization: 'Bearer t' },
    });
    // (now - ts) < TIMEOUT is false when equal → unavailable
    expect(res.body).toMatchObject({
      presence: 'unavailable',
      currently_active: false,
      last_active_ago: PRESENCE_TIMEOUT,
    });
  });

  it('boundary: one ms under PRESENCE_TIMEOUT stays online/active', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [
        {
          user_id: USER,
          presence: 'online',
          status_msg: 'ok',
          last_active_ts: NOW - PRESENCE_TIMEOUT + 1,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, statusPath(USER), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toMatchObject({
      presence: 'online',
      currently_active: true,
      status_msg: 'ok',
    });
  });
});
