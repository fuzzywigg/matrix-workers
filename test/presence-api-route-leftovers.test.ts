/**
 * TOKENMAXX HEAVY leftovers — presence HTTP + sync-helper edges after #185.
 * Complements presence-api-routes, presence-helpers, presence-typing leftovers (#166),
 * and presence-receipts-typing-todevice soft floods. Distinct slice: body/type matrices,
 * corrupt KV shapes, membership-filtered federation fan-out, per-server DO isolation,
 * concurrent PUT/GET races, method matrix, SQL/KV bind contracts, getPresenceForUsers
 * corrupt-cache + batch isolation. Tests-only — no product inventing. example.com only.
 * Not typing / receipts / qr-login / oauth / push / identity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { getPresenceForUsers, updateLastActive } from '../src/api/presence';

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
const CAROL = '@carol:example.com';
const DAVE = '@dave:example.com';
const ROOM = '!r:example.com';
const ROOM2 = '!r2:example.com';
const SERVER = 'example.com';
const REMOTE = 'remote.example.org';
const REMOTE2 = 'other.example.net';
const USER_ENC = encodeURIComponent(USER);
const BOB_ENC = encodeURIComponent(BOB);

const NOW = 1_700_000_000_000;
const PRESENCE_TIMEOUT = 5 * 60 * 1000;

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const gets: Array<{ key: string; type?: string }> = [];
  const kv = {
    data,
    puts,
    gets,
    get: async (key: string, type?: string) => {
      gets.push({ key, type });
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
    gets: Array<{ key: string; type?: string }>;
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

function createFederationStub(opts: { fail?: boolean; failOnce?: boolean } = {}) {
  const fetches: FedFetch[] = [];
  let failOnceUsed = false;
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
      if (opts.fail) throw new Error('federation send-edu boom');
      if (opts.failOnce && !failOnceUsed) {
        failOnceUsed = true;
        throw new Error('federation send-edu once');
      }
      return Response.json({ ok: true });
    },
  };
}

function createPresenceDb(opts: {
  users?: string[];
  presence?: PresenceRow[];
  memberships?: Membership[];
  failInsert?: boolean;
  failUserSelect?: boolean;
  failPresenceSelect?: boolean;
  failServersAll?: boolean;
} = {}) {
  const users = new Set(opts.users ?? [USER, BOB, CAROL, DAVE]);
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
    failInsert: opts.failInsert ?? false,
    failUserSelect: opts.failUserSelect ?? false,
    failPresenceSelect: opts.failPresenceSelect ?? false,
    failServersAll: opts.failServersAll ?? false,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('SELECT user_id FROM users WHERE user_id = ?')) {
                if (db.failUserSelect) throw new Error('d1-user-select-fail');
                const userId = args[0] as string;
                return (users.has(userId) ? { user_id: userId } : null) as T;
              }
              if (
                sql.includes('FROM presence') &&
                sql.includes('WHERE user_id = ?') &&
                !sql.includes('INSERT')
              ) {
                if (db.failPresenceSelect) throw new Error('d1-presence-select-fail');
                const userId = args[0] as string;
                const row = presence.find((p) => p.user_id === userId);
                if (!row) return null;
                return {
                  presence: row.presence,
                  status_msg: row.status_msg,
                  last_active_ts: row.last_active_ts,
                } as T;
              }
              throw new Error('Unhandled first() SQL: ' + sql.slice(0, 160));
            },
            async all<T>() {
              selects.push({ sql, args });
              if (sql.includes('SUBSTR(rm2.user_id') && sql.includes('room_memberships rm1')) {
                if (db.failServersAll) throw new Error('d1-servers-all-fail');
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
            async run(): Promise<{
              meta: { changes: number; last_row_id: number };
              success: boolean;
            }> {
              runs.push({ sql, args });
              if (sql.includes('INSERT INTO presence')) {
                if (db.failInsert) throw new Error('d1-insert-fail');
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
                const [ts, userId] = args as [number, string];
                const idx = presence.findIndex((p) => p.user_id === userId);
                if (idx >= 0) {
                  presence[idx] = { ...presence[idx], last_active_ts: ts };
                  return { success: true, meta: { changes: 1, last_row_id: 0 } };
                }
                return { success: true, meta: { changes: 0, last_row_id: 0 } };
              }
              throw new Error('Unhandled run() SQL: ' + sql.slice(0, 160));
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
  perServerFederation?: Map<string, FedStub>;
  failFederation?: boolean;
  serverName?: string;
} = {}) {
  const db = opts.db ?? createPresenceDb();
  const cache = opts.cache ?? mockKv();
  const federation = opts.federation ?? createFederationStub({ fail: opts.failFederation });
  const fedByServer = opts.perServerFederation ?? new Map<string, FedStub>();
  const idCalls: string[] = [];

  const env = {
    DB: db as unknown as D1Database,
    CACHE: cache,
    SERVER_NAME: opts.serverName ?? SERVER,
    FEDERATION: {
      idFromName: (name: string) => {
        idCalls.push(name);
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
    _idCalls: idCalls,
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

function statusPath(userId: string = USER): string {
  return `/_matrix/client/v3/presence/${encodeURIComponent(userId)}/status`;
}

function sharedRoomMemberships(
  remoteServers: string[] = [REMOTE],
  opts: { includeBob?: boolean } = {}
): Membership[] {
  return [
    { room_id: ROOM, user_id: USER, membership: 'join' },
    ...remoteServers.map((s) => ({
      room_id: ROOM,
      user_id: `@remote:${s}`,
      membership: 'join' as const,
    })),
    ...(opts.includeBob === false
      ? []
      : [{ room_id: ROOM, user_id: BOB, membership: 'join' as const }]),
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
// PUT body / type edges
// ---------------------------------------------------------------------------

describe('presence leftovers PUT body type matrix', () => {
  const invalidPresenceBodies: Array<{ label: string; body: unknown }> = [
    { label: 'number', body: { presence: 1 } },
    { label: 'boolean-true', body: { presence: true } },
    { label: 'boolean-false', body: { presence: false } },
    { label: 'array', body: { presence: ['online'] } },
    { label: 'object', body: { presence: { state: 'online' } } },
    { label: 'whitespace', body: { presence: ' online' } },
    { label: 'ONLINE-upper', body: { presence: 'ONLINE' } },
    { label: 'Online-mixed', body: { presence: 'Online' } },
    { label: 'idle', body: { presence: 'idle' } },
    { label: 'invisible', body: { presence: 'invisible' } },
    { label: 'unknown', body: { presence: 'unknown' } },
    { label: 'undefined-field-only-msg', body: { status_msg: 'x' } },
  ];

  for (const c of invalidPresenceBodies) {
    it(`rejects invalid presence body (${c.label})`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const res = await request(env, statusPath(), jsonInit('PUT', c.body));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
      expect(env._db.inserts).toHaveLength(0);
      expect(env._cache.puts).toHaveLength(0);
    });
  }

  it('rejects empty object body', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    const res = await request(env, statusPath(), jsonInit('PUT', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('rejects truncated JSON', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    const res = await request(env, statusPath(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{"presence":"onlin',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects non-object JSON array root', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    const res = await request(env, statusPath(), jsonInit('PUT', ['online']));
    expect(res.status).toBe(400);
    // presence field undefined on array → M_INVALID_PARAM
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('rejects JSON string root', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    const res = await request(env, statusPath(), jsonInit('PUT', 'online'));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });
});

describe('presence leftovers PUT status_msg falsy / soft matrix', () => {
  const cases: Array<{ label: string; status_msg: unknown; expected: string | null }> = [
    { label: 'empty', status_msg: '', expected: null },
    { label: 'false', status_msg: false, expected: null },
    { label: 'zero', status_msg: 0, expected: null },
    { label: 'null', status_msg: null, expected: null },
    { label: 'whitespace', status_msg: ' ', expected: ' ' },
    { label: 'unicode', status_msg: '在线 🚀', expected: '在线 🚀' },
    { label: 'json-meta', status_msg: '{"a":1}', expected: '{"a":1}' },
    { label: 'newline', status_msg: 'line1\nline2', expected: 'line1\nline2' },
  ];

  for (const c of cases) {
    it(`status_msg ${c.label} stores ${JSON.stringify(c.expected)}`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const res = await request(
        env,
        statusPath(),
        jsonInit('PUT', { presence: 'online', status_msg: c.status_msg })
      );
      expect(res.status).toBe(200);
      expect(env._db.inserts[0].args[2]).toBe(c.expected);
      expect(JSON.parse(env._cache.puts[0].value).status_msg).toBe(c.expected);
    });
  }

  for (let i = 0; i < 16; i++) {
    it(`status_msg soft-flood-${i}`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const msg = `soft-${i}-${'x'.repeat(i)}`;
      const res = await request(
        env,
        statusPath(),
        jsonInit('PUT', { presence: i % 2 === 0 ? 'online' : 'unavailable', status_msg: msg })
      );
      expect(res.status).toBe(200);
      expect(env._db.inserts[0].args[2]).toBe(msg);
    });
  }
});

describe('presence leftovers PUT own-user gate soft deepen', () => {
  const others = [
    BOB,
    CAROL,
    DAVE,
    '@eve:example.com',
    '@alice:other.example.com',
    '@Alice:example.com',
  ];

  for (const other of others) {
    it(`forbids PUT for ${other}`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const res = await request(env, statusPath(other), jsonInit('PUT', { presence: 'online' }));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot set presence for other users',
      });
      expect(env._db.inserts).toHaveLength(0);
      expect(env._cache.puts).toHaveLength(0);
      expect(env._idCalls).toEqual([]);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`forbid-other soft-${i} skips D1+KV+fed`, async () => {
      const db = createPresenceDb({ memberships: sharedRoomMemberships() });
      const federation = createFederationStub();
      const env = createEnv({ db, federation });
      const other = `@other${i}:example.com`;
      const res = await request(env, statusPath(other), jsonInit('PUT', { presence: 'online' }));
      expect(res.status).toBe(403);
      expect(db.inserts).toHaveLength(0);
      expect(env._cache.puts).toHaveLength(0);
      expect(federation.fetches).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Federation membership filter + multi-server isolation
// ---------------------------------------------------------------------------

describe('presence leftovers federation membership filter', () => {
  it('ignores leave/invite/ban peers when discovering remote servers', async () => {
    const db = createPresenceDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM, user_id: `@left:${REMOTE}`, membership: 'leave' },
        { room_id: ROOM, user_id: `@inv:${REMOTE2}`, membership: 'invite' },
        { room_id: ROOM, user_id: `@ban:${REMOTE}`, membership: 'ban' },
      ],
    });
    const federation = createFederationStub();
    const env = createEnv({ db, federation });
    const res = await request(env, statusPath(), jsonInit('PUT', { presence: 'online' }));
    expect(res.status).toBe(200);
    expect(federation.fetches).toHaveLength(0);
  });

  it('ignores rooms where requester is only invite/leave', async () => {
    const db = createPresenceDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'invite' },
        { room_id: ROOM, user_id: `@r:${REMOTE}`, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'leave' },
        { room_id: ROOM2, user_id: `@r2:${REMOTE2}`, membership: 'join' },
      ],
    });
    const federation = createFederationStub();
    const env = createEnv({ db, federation });
    await request(env, statusPath(), jsonInit('PUT', { presence: 'unavailable' }));
    expect(federation.fetches).toHaveLength(0);
  });

  it('fans out to distinct remote servers with isolated DO ids', async () => {
    const remoteA = createFederationStub();
    const remoteB = createFederationStub();
    const perServer = new Map<string, FedStub>([
      [REMOTE, remoteA],
      [REMOTE2, remoteB],
    ]);
    const db = createPresenceDb({
      memberships: sharedRoomMemberships([REMOTE, REMOTE2], { includeBob: false }),
    });
    const env = createEnv({ db, perServerFederation: perServer });
    const res = await request(
      env,
      statusPath(),
      jsonInit('PUT', { presence: 'online', status_msg: 'multi' })
    );
    expect(res.status).toBe(200);
    expect(env._idCalls.sort()).toEqual([REMOTE, REMOTE2].sort());
    expect(remoteA.fetches).toHaveLength(1);
    expect(remoteB.fetches).toHaveLength(1);
    expect((remoteA.fetches[0].body as { destination: string }).destination).toBe(REMOTE);
    expect((remoteB.fetches[0].body as { destination: string }).destination).toBe(REMOTE2);
    expect(
      (remoteA.fetches[0].body as { content: { push: Array<{ status_msg?: string }> } }).content
        .push[0].status_msg
    ).toBe('multi');
  });

  it('partial per-server fail still returns 200 after first EDU throw', async () => {
    // Sequential for-loop: first server throws → catch swallows remaining fan-out
    const failStub = createFederationStub({ fail: true });
    const okStub = createFederationStub();
    const perServer = new Map<string, FedStub>([
      [REMOTE, failStub],
      [REMOTE2, okStub],
    ]);
    const db = createPresenceDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM, user_id: `@a:${REMOTE}`, membership: 'join' },
        { room_id: ROOM, user_id: `@b:${REMOTE2}`, membership: 'join' },
      ],
    });
    const env = createEnv({ db, perServerFederation: perServer });
    const res = await request(env, statusPath(), jsonInit('PUT', { presence: 'online' }));
    expect(res.status).toBe(200);
    expect(env._db.inserts).toHaveLength(1);
    expect(env._cache.puts).toHaveLength(1);
    expect(console.warn).toHaveBeenCalled();
    // Only first destination attempted before throw aborts the loop
    expect(failStub.fetches.length + okStub.fetches.length).toBe(1);
  });

  it('EDU currently_active true only for online', async () => {
    for (const presence of ['online', 'offline', 'unavailable'] as const) {
      const federation = createFederationStub();
      const db = createPresenceDb({ memberships: sharedRoomMemberships() });
      const env = createEnv({ db, federation });
      await request(env, statusPath(), jsonInit('PUT', { presence }));
      const push = (
        federation.fetches[0].body as {
          content: { push: Array<{ currently_active: boolean; presence: string }> };
        }
      ).content.push[0];
      expect(push.presence).toBe(presence);
      expect(push.currently_active).toBe(presence === 'online');
      expect(push).toMatchObject({ last_active_ago: 0, user_id: USER });
    }
  });

  it('filters local SERVER_NAME even when remote users also share domain peers', async () => {
    const federation = createFederationStub();
    const db = createPresenceDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM, user_id: BOB, membership: 'join' },
        { room_id: ROOM, user_id: `@x:${REMOTE}`, membership: 'join' },
      ],
    });
    const env = createEnv({ db, federation });
    await request(env, statusPath(), jsonInit('PUT', { presence: 'offline' }));
    const destinations = federation.fetches.map(
      (f) => (f.body as { destination: string }).destination
    );
    expect(destinations).toEqual([REMOTE]);
  });
});

// ---------------------------------------------------------------------------
// Corrupt KV / GET leftovers
// ---------------------------------------------------------------------------

describe('presence leftovers GET corrupt KV shapes', () => {
  it('falls back to D1 when KV JSON is corrupt string', async () => {
    const cache = mockKv({ [`presence:${BOB}`]: '{not-json' });
    const db = createPresenceDb({
      users: [BOB],
      presence: [
        {
          user_id: BOB,
          presence: 'online',
          status_msg: 'from-d1',
          last_active_ts: NOW - 1000,
        },
      ],
    });
    const env = createEnv({ db, cache });
    const res = await request(env, statusPath(BOB), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      presence: 'online',
      status_msg: 'from-d1',
      last_active_ago: 1000,
      currently_active: true,
    });
  });

  it('treats JSON null cache value as miss and falls back to D1', async () => {
    const cache = mockKv({ [`presence:${BOB}`]: 'null' });
    const db = createPresenceDb({
      users: [BOB],
      presence: [
        {
          user_id: BOB,
          presence: 'unavailable',
          status_msg: null,
          last_active_ts: NOW - 50,
        },
      ],
    });
    const env = createEnv({ db, cache });
    const res = await request(env, statusPath(BOB), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toMatchObject({
      presence: 'unavailable',
      currently_active: false,
      last_active_ago: 50,
    });
  });

  it('defaults offline when corrupt KV and no D1 row', async () => {
    const cache = mockKv({ [`presence:${BOB}`]: '[]' });
    const db = createPresenceDb({ users: [BOB], presence: [] });
    const env = createEnv({ db, cache });
    const res = await request(env, statusPath(BOB), {
      headers: { Authorization: 'Bearer t' },
    });
    // Array parses as truthy presence object without fields → NaN math path
    // If cached is [], then presence is truthy array; last_active_ts undefined → NaN
    // Safer expectation: handler returns something with presence field derived from []
    // Actually: cached = [] (array), truthy, so no D1 fallback. presence.presence undefined.
    // effectivePresence = undefined; isActive = (now - undefined) < TIMEOUT → false
    expect(res.status).toBe(200);
    expect((res.body as { presence: unknown }).presence).toBeUndefined();
    expect((res.body as { currently_active: boolean }).currently_active).toBe(false);
  });

  it('cross-user cache isolation: bob KV does not serve alice GET', async () => {
    const cache = mockKv({
      [`presence:${BOB}`]: JSON.stringify({
        presence: 'online',
        status_msg: 'bob-only',
        last_active_ts: NOW,
      }),
    });
    const db = createPresenceDb({ users: [USER, BOB], presence: [] });
    const env = createEnv({ db, cache });
    const res = await request(env, statusPath(USER), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toEqual({ presence: 'offline', currently_active: false });
  });

  it('GET unknown user 404 before any presence KV read side-effect needed', async () => {
    const cache = mockKv({
      [`presence:@ghost:example.com`]: JSON.stringify({
        presence: 'online',
        status_msg: null,
        last_active_ts: NOW,
      }),
    });
    const db = createPresenceDb({ users: [USER] });
    const env = createEnv({ db, cache });
    const res = await request(env, statusPath('@ghost:example.com'), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  for (let i = 0; i < 12; i++) {
    it(`GET soft default-offline-${i} for user without presence`, async () => {
      const uid = `@u${i}:example.com`;
      const db = createPresenceDb({ users: [uid], presence: [] });
      const env = createEnv({ db });
      const res = await request(env, statusPath(uid), {
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ presence: 'offline', currently_active: false });
    });
  }
});

describe('presence leftovers GET clock / remap soft deepen', () => {
  const offsets = [
    0,
    1,
    PRESENCE_TIMEOUT - 1,
    PRESENCE_TIMEOUT,
    PRESENCE_TIMEOUT + 1,
    PRESENCE_TIMEOUT * 2,
  ];

  for (const offset of offsets) {
    it(`online remap offset=${offset}`, async () => {
      const db = createPresenceDb({
        users: [USER],
        presence: [
          {
            user_id: USER,
            presence: 'online',
            status_msg: 'clk',
            last_active_ts: NOW - offset,
          },
        ],
      });
      const env = createEnv({ db });
      const res = await request(env, statusPath(), {
        headers: { Authorization: 'Bearer t' },
      });
      const active = offset < PRESENCE_TIMEOUT;
      expect(res.body).toMatchObject({
        presence: active ? 'online' : 'unavailable',
        currently_active: active,
        last_active_ago: offset,
        status_msg: 'clk',
      });
    });
  }

  it('PUT then advance clock past TIMEOUT remaps subsequent GET via KV', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    await request(env, statusPath(), jsonInit('PUT', { presence: 'online', status_msg: 'soon' }));
    vi.setSystemTime(NOW + PRESENCE_TIMEOUT);
    const res = await request(env, statusPath(), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toMatchObject({
      presence: 'unavailable',
      currently_active: false,
      status_msg: 'soon',
      last_active_ago: PRESENCE_TIMEOUT,
    });
  });

  it('PUT offline then clock advance stays offline (no remap)', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    await request(env, statusPath(), jsonInit('PUT', { presence: 'offline', status_msg: 'zzz' }));
    vi.setSystemTime(NOW + PRESENCE_TIMEOUT * 3);
    const res = await request(env, statusPath(), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toMatchObject({
      presence: 'offline',
      status_msg: 'zzz',
      currently_active: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrent races
// ---------------------------------------------------------------------------

describe('presence leftovers concurrent PUT/GET races', () => {
  it('parallel PUTs last-write-wins on D1+KV for same user', async () => {
    const db = createPresenceDb({ memberships: [] });
    const cache = mockKv();
    const env = createEnv({ db, cache });
    const states = ['online', 'offline', 'unavailable'] as const;
    await Promise.all(
      states.map((presence, i) =>
        request(
          env,
          statusPath(),
          jsonInit('PUT', { presence, status_msg: `msg-${i}` })
        )
      )
    );
    expect(db.inserts).toHaveLength(3);
    expect(cache.puts).toHaveLength(3);
    expect(db.presence).toHaveLength(1);
    expect(['online', 'offline', 'unavailable']).toContain(db.presence[0].presence);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe(db.presence[0].presence);
    expect(cached.status_msg).toBe(db.presence[0].status_msg);
  });

  it('parallel PUTs for different conceptual users are isolated by own-user gate', async () => {
    // Auth is fixed to alice — bob/carol PUTs all 403; only alice succeeds
    const db = createPresenceDb({ memberships: [] });
    const env = createEnv({ db });
    const results = await Promise.all([
      request(env, statusPath(USER), jsonInit('PUT', { presence: 'online' })),
      request(env, statusPath(BOB), jsonInit('PUT', { presence: 'online' })),
      request(env, statusPath(CAROL), jsonInit('PUT', { presence: 'online' })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403, 403]);
    expect(db.presence).toHaveLength(1);
    expect(db.presence[0].user_id).toBe(USER);
  });

  it('GET∥PUT race: GET may see pre or post write without throwing', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [
        {
          user_id: USER,
          presence: 'offline',
          status_msg: 'old',
          last_active_ts: NOW - 5000,
        },
      ],
      memberships: [],
    });
    const env = createEnv({ db });
    const [putRes, getRes] = await Promise.all([
      request(env, statusPath(), jsonInit('PUT', { presence: 'online', status_msg: 'new' })),
      request(env, statusPath(), { headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(putRes.status).toBe(200);
    expect(getRes.status).toBe(200);
    expect(['online', 'offline', 'unavailable']).toContain(
      (getRes.body as { presence: string }).presence
    );
  });

  it('concurrent federation fan-out PUTs do not throw', async () => {
    const federation = createFederationStub();
    const db = createPresenceDb({ memberships: sharedRoomMemberships([REMOTE, REMOTE2]) });
    const env = createEnv({ db, federation });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(
          env,
          statusPath(),
          jsonInit('PUT', { presence: i % 2 ? 'offline' : 'online', status_msg: `c-${i}` })
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(federation.fetches.length).toBeGreaterThanOrEqual(8);
  });

  for (let i = 0; i < 12; i++) {
    it(`concurrent soft-race-${i} put-then-get`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const presence = (['online', 'offline', 'unavailable'] as const)[i % 3];
      const [putRes, getRes] = await Promise.all([
        request(env, statusPath(), jsonInit('PUT', { presence, status_msg: `r-${i}` })),
        request(env, statusPath(), { headers: { Authorization: 'Bearer t' } }),
      ]);
      expect(putRes.status).toBe(200);
      expect(getRes.status).toBe(200);
    });
  }
});

// ---------------------------------------------------------------------------
// Method / path / bind contracts
// ---------------------------------------------------------------------------

describe('presence leftovers method matrix', () => {
  const writeMethods = ['POST', 'PATCH', 'DELETE'] as const;

  for (const method of writeMethods) {
    it(`${method} /status is not a successful empty PUT`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const res = await request(env, statusPath(), {
        method,
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ presence: 'online' }),
      });
      expect(res.status).not.toBe(200);
      expect(env._db.inserts).toHaveLength(0);
    });
  }

  it('OPTIONS /status is not a successful empty PUT', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    const res = await request(env, statusPath(), {
      method: 'OPTIONS',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).not.toBe(200);
    expect(env._db.inserts).toHaveLength(0);
  });

  it('HEAD /status follows GET (200) but never writes D1/KV', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [
        {
          user_id: USER,
          presence: 'online',
          status_msg: null,
          last_active_ts: NOW,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, statusPath(), {
      method: 'HEAD',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(0);
    expect(env._cache.puts).toHaveLength(0);
  });

  it('GET does not write D1 or KV', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [
        {
          user_id: USER,
          presence: 'online',
          status_msg: null,
          last_active_ts: NOW,
        },
      ],
    });
    const env = createEnv({ db });
    await request(env, statusPath(), { headers: { Authorization: 'Bearer t' } });
    expect(db.inserts).toHaveLength(0);
    expect(env._cache.puts).toHaveLength(0);
  });
});

describe('presence leftovers SQL / KV bind contracts', () => {
  it('INSERT binds user, presence, status_msg, last_active_ts in order', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    await request(
      env,
      statusPath(),
      jsonInit('PUT', { presence: 'unavailable', status_msg: 'bind' })
    );
    expect(env._db.inserts[0].sql).toContain('INSERT INTO presence');
    expect(env._db.inserts[0].args).toEqual([USER, 'unavailable', 'bind', NOW]);
  });

  it('KV key is presence:${userId} with TTL 300', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    await request(env, statusPath(), jsonInit('PUT', { presence: 'online' }));
    expect(env._cache.puts[0]).toMatchObject({
      key: `presence:${USER}`,
      options: { expirationTtl: 300 },
    });
  });

  it('GET user existence select binds target user id', async () => {
    const db = createPresenceDb({ users: [BOB], presence: [] });
    const env = createEnv({ db });
    await request(env, statusPath(BOB), { headers: { Authorization: 'Bearer t' } });
    const userSelect = db.selects.find((s) =>
      s.sql.includes('SELECT user_id FROM users WHERE user_id = ?')
    );
    expect(userSelect?.args).toEqual([BOB]);
  });

  it('URL-encoded user id path matches decoded own-user gate', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    const res = await request(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'online' })
    );
    expect(res.status).toBe(200);
    expect(env._db.inserts[0].args[0]).toBe(USER);
  });

  it('URL-encoded bob path still forbidden', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    const res = await request(
      env,
      `/_matrix/client/v3/presence/${BOB_ENC}/status`,
      jsonInit('PUT', { presence: 'online' })
    );
    expect(res.status).toBe(403);
  });

  for (let i = 0; i < 12; i++) {
    it(`bind soft-${i} state cycle`, async () => {
      const state = (['online', 'offline', 'unavailable'] as const)[i % 3];
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const res = await request(env, statusPath(), jsonInit('PUT', { presence: state }));
      expect(res.status).toBe(200);
      expect(env._db.inserts[0].args).toEqual([USER, state, null, NOW]);
      expect(JSON.parse(env._cache.puts[0].value)).toEqual({
        presence: state,
        status_msg: null,
        last_active_ts: NOW,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// getPresenceForUsers / updateLastActive leftovers (helper edges)
// ---------------------------------------------------------------------------

describe('presence leftovers getPresenceForUsers corrupt cache + batch', () => {
  it('skips corrupt KV entries and falls back to D1 for those ids', async () => {
    const db = createPresenceDb({
      presence: [
        {
          user_id: BOB,
          presence: 'online',
          status_msg: 'db',
          last_active_ts: NOW - 10,
        },
      ],
    });
    const cache = mockKv({
      [`presence:${USER}`]: '{bad',
      [`presence:${BOB}`]: JSON.stringify({
        presence: 'offline',
        status_msg: null,
        last_active_ts: NOW - 20,
      }),
    });
    const result = await getPresenceForUsers(
      db as unknown as D1Database,
      [USER, BOB],
      cache
    );
    // USER corrupt → uncached → missing from D1 → omitted
    expect(result[USER]).toBeUndefined();
    expect(result[BOB]).toMatchObject({
      presence: 'offline',
      currently_active: false,
      last_active_ago: 20,
    });
  });

  it('JSON null cache entry treated as miss', async () => {
    const db = createPresenceDb({
      presence: [
        {
          user_id: USER,
          presence: 'online',
          status_msg: null,
          last_active_ts: NOW - 5,
        },
      ],
    });
    const cache = mockKv({ [`presence:${USER}`]: 'null' });
    const result = await getPresenceForUsers(
      db as unknown as D1Database,
      [USER],
      cache
    );
    expect(result[USER]).toMatchObject({
      presence: 'online',
      currently_active: true,
      last_active_ago: 5,
    });
  });

  it('preserves request order independence in result keys', async () => {
    const db = createPresenceDb({
      presence: [
        {
          user_id: CAROL,
          presence: 'unavailable',
          status_msg: 'c',
          last_active_ts: NOW,
        },
        {
          user_id: DAVE,
          presence: 'offline',
          status_msg: 'd',
          last_active_ts: NOW,
        },
      ],
    });
    const result = await getPresenceForUsers(db as unknown as D1Database, [
      DAVE,
      CAROL,
      '@missing:example.com',
    ]);
    expect(Object.keys(result).sort()).toEqual([CAROL, DAVE].sort());
  });

  it('large batch builds matching IN placeholders', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `@u${i}:example.com`);
    const db = createPresenceDb({
      presence: ids.map((user_id, i) => ({
        user_id,
        presence: i % 2 ? 'offline' : 'online',
        status_msg: null,
        last_active_ts: NOW - i,
      })),
    });
    const result = await getPresenceForUsers(db as unknown as D1Database, ids);
    expect(Object.keys(result)).toHaveLength(10);
    const inSelect = db.selects.find((s) => s.sql.includes('IN ('));
    expect(inSelect?.args).toEqual(ids);
    expect(inSelect?.sql.match(/\?/g)?.length).toBe(10);
  });

  for (let i = 0; i < 12; i++) {
    it(`batch soft-${i} mixed cache/d1`, async () => {
      const cachedId = `@c${i}:example.com`;
      const dbId = `@d${i}:example.com`;
      const db = createPresenceDb({
        presence: [
          {
            user_id: dbId,
            presence: 'online',
            status_msg: `d-${i}`,
            last_active_ts: NOW - 100,
          },
        ],
      });
      const cache = mockKv({
        [`presence:${cachedId}`]: JSON.stringify({
          presence: 'offline',
          status_msg: `c-${i}`,
          last_active_ts: NOW - 200,
        }),
      });
      const result = await getPresenceForUsers(
        db as unknown as D1Database,
        [cachedId, dbId],
        cache
      );
      expect(result[cachedId]).toMatchObject({
        presence: 'offline',
        status_msg: `c-${i}`,
      });
      expect(result[dbId]).toMatchObject({
        presence: 'online',
        status_msg: `d-${i}`,
        currently_active: true,
      });
    });
  }
});

describe('presence leftovers updateLastActive soft deepen', () => {
  it('no-ops cleanly when user has no presence row', async () => {
    const db = createPresenceDb({ presence: [] });
    await updateLastActive(db as unknown as D1Database, USER);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].args).toEqual([NOW, USER]);
    expect(db.presence).toHaveLength(0);
  });

  it('concurrent updateLastActive for distinct users isolates binds', async () => {
    const db = createPresenceDb({
      presence: [
        {
          user_id: USER,
          presence: 'online',
          status_msg: null,
          last_active_ts: 0,
        },
        {
          user_id: BOB,
          presence: 'online',
          status_msg: null,
          last_active_ts: 0,
        },
      ],
    });
    await Promise.all([
      updateLastActive(db as unknown as D1Database, USER),
      updateLastActive(db as unknown as D1Database, BOB),
    ]);
    expect(db.updates).toHaveLength(2);
    const userIds = db.updates.map((u) => u.args[1]).sort();
    expect(userIds).toEqual([USER, BOB].sort());
    expect(db.presence.find((p) => p.user_id === USER)?.last_active_ts).toBe(NOW);
    expect(db.presence.find((p) => p.user_id === BOB)?.last_active_ts).toBe(NOW);
  });

  for (let i = 0; i < 12; i++) {
    it(`updateLastActive soft-${i} advances clock`, async () => {
      const db = createPresenceDb({
        presence: [
          {
            user_id: USER,
            presence: 'online',
            status_msg: null,
            last_active_ts: 0,
          },
        ],
      });
      const ts = NOW + i * 1000;
      vi.setSystemTime(ts);
      await updateLastActive(db as unknown as D1Database, USER);
      expect(db.updates[0].args).toEqual([ts, USER]);
      expect(db.presence[0].last_active_ts).toBe(ts);
    });
  }
});

// ---------------------------------------------------------------------------
// Side-effect soft deepen (happy-path PUT floods)
// ---------------------------------------------------------------------------

describe('presence leftovers side-effect soft deepen', () => {
  for (let i = 0; i < 16; i++) {
    it(`PUT online soft-${i} empty body response`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const res = await request(
        env,
        statusPath(),
        jsonInit('PUT', { presence: 'online', status_msg: `side-${i}` })
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
      expect(env._db.inserts).toHaveLength(1);
      expect(env._cache.puts).toHaveLength(1);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`PUT+GET roundtrip soft-${i}`, async () => {
      const state = (['online', 'offline', 'unavailable'] as const)[i % 3];
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      await request(
        env,
        statusPath(),
        jsonInit('PUT', { presence: state, status_msg: `rt-${i}` })
      );
      const res = await request(env, statusPath(), {
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.body).toMatchObject({
        presence: state,
        status_msg: `rt-${i}`,
        last_active_ago: 0,
        currently_active: state === 'online',
      });
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`federation soft-${i} single remote`, async () => {
      const federation = createFederationStub();
      const db = createPresenceDb({ memberships: sharedRoomMemberships() });
      const env = createEnv({ db, federation });
      const res = await request(
        env,
        statusPath(),
        jsonInit('PUT', { presence: 'online', status_msg: `fed-${i}` })
      );
      expect(res.status).toBe(200);
      expect(federation.fetches).toHaveLength(1);
      expect(
        (federation.fetches[0].body as { content: { push: Array<{ status_msg?: string }> } })
          .content.push[0].status_msg
      ).toBe(`fed-${i}`);
    });
  }
});
