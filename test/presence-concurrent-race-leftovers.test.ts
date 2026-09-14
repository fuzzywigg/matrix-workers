/**
 * TOKENMAXX HEAVY leftovers after #202 — presence *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by presence-api-routes,
 * presence-api-route-leftovers soft floods (#190), or presence-typing leftovers.
 *
 * Distinct domain — not sync (#202), voip/rtc/calls (#201), report/server-notices
 * (#200), search/spaces (#199), profile (#198/#197), tags (#196), workflows (#195),
 * rooms-mutate (#194), aliases (#193), rooms (#192), admin-mutate (#191).
 * Complements #190 concurrent PUT/GET soft races which lacked D1/KV/federation
 * SELECT→mutate barriers and write-through split TOCTOU coverage.
 *
 * Focus: D1 INSERT run barriers; KV put/get barriers; GET∥PUT mid write-through;
 * membership mutate mid federation discovery; updateLastActive∥PUT last_active_ts;
 * getPresenceForUsers∥PUT cache coherency; D1/KV failure soft; method/body/
 * foreign/lifecycle/charset soft floods; SQL/KV bind contracts under parallel.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
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
type KvBarrier = { match: (key: string) => boolean; count: number };
type SqlBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

type PresenceRow = {
  user_id: string;
  presence: string;
  status_msg: string | null;
  last_active_ts: number;
};

type Membership = { room_id: string; user_id: string; membership: string };
type SqlCall = { sql: string; args: unknown[] };
type FedFetch = { url: string; method: string; body?: unknown };

async function withSqlBarrier(
  barrier: SqlBarrier | undefined,
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

async function withKvBarrier(
  barrier: KvBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  key: string
) {
  if (!barrier || !barrier.match(key)) return;
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

function mockKv(
  initial: Record<string, string> = {},
  opts: {
    getBarrier?: KvBarrier;
    putBarrier?: KvBarrier;
    mutateAfterGets?: { after: number; next: Record<string, string> };
    failGetAfter?: number;
    failPutAfter?: number;
  } = {}
) {
  const data: Record<string, string> = { ...initial };
  const puts: KvPut[] = [];
  const gets: Array<{ key: string; type?: string }> = [];
  const events: string[] = [];

  let getBarrier = opts.getBarrier;
  let putBarrier = opts.putBarrier;
  const getWaiters = { list: [] as Array<() => void> };
  const putWaiters = { list: [] as Array<() => void> };
  let getCount = 0;
  let putCount = 0;
  const mutateAfterGets = opts.mutateAfterGets;

  return {
    data,
    puts,
    gets,
    events,
    get: async (key: string, type?: string) => {
      gets.push({ key, type });
      events.push(`get:${key}`);
      getCount += 1;
      await withKvBarrier(
        getBarrier,
        getWaiters,
        () => {
          getBarrier = undefined;
        },
        key
      );
      if (opts.failGetAfter !== undefined && getCount > opts.failGetAfter) {
        throw new Error('kv-get-fail');
      }
      if (mutateAfterGets && getCount === mutateAfterGets.after) {
        for (const [k, v] of Object.entries(mutateAfterGets.next)) {
          data[k] = v;
        }
        events.push('mutate:after-get');
      }
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
      await withKvBarrier(
        putBarrier,
        putWaiters,
        () => {
          putBarrier = undefined;
        },
        key
      );
      putCount += 1;
      if (opts.failPutAfter !== undefined && putCount > opts.failPutAfter) {
        throw new Error('kv-put-fail');
      }
      data[key] = value;
      puts.push({ key, value, options });
      events.push(`put:${key}`);
    },
    delete: async (key: string) => {
      delete data[key];
      events.push(`delete:${key}`);
    },
  } as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
    gets: Array<{ key: string; type?: string }>;
    events: string[];
  };
}

type RaceKv = ReturnType<typeof mockKv>;

function createPresenceDb(
  opts: {
    users?: string[];
    presence?: PresenceRow[];
    memberships?: Membership[];
    runBarrier?: SqlBarrier;
    selectBarrier?: SqlBarrier;
    allBarrier?: SqlBarrier;
    mutatePresenceAfterUserSelects?: { after: number; next: PresenceRow[] };
    mutateMembershipAfterServersAll?: { after: number; next: Membership[] };
    failInsertAfter?: number;
    failUpdateAfter?: number;
    failUserSelect?: boolean;
    failPresenceSelect?: boolean;
    failServersAll?: boolean;
  } = {}
) {
  const users = new Set(opts.users ?? [USER, BOB, CAROL, DAVE]);
  const presence = opts.presence ?? [];
  const memberships = opts.memberships ?? [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const alls: SqlCall[] = [];
  const runs: SqlCall[] = [];
  const events: string[] = [];

  let runBarrier = opts.runBarrier;
  let selectBarrier = opts.selectBarrier;
  let allBarrier = opts.allBarrier;
  const runWaiters = { list: [] as Array<() => void> };
  const selectWaiters = { list: [] as Array<() => void> };
  const allWaiters = { list: [] as Array<() => void> };

  let insertCount = 0;
  let updateCount = 0;
  let userSelectCount = 0;
  let serversAllCount = 0;

  const mutatePresence = opts.mutatePresenceAfterUserSelects;
  const mutateMembership = opts.mutateMembershipAfterServersAll;

  const db = {
    users,
    presence,
    memberships,
    inserts,
    updates,
    selects,
    alls,
    runs,
    events,
    failUserSelect: opts.failUserSelect ?? false,
    failPresenceSelect: opts.failPresenceSelect ?? false,
    failServersAll: opts.failServersAll ?? false,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              events.push(`first:${sql.slice(0, 48)}`);
              await withSqlBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );

              if (sql.includes('SELECT user_id FROM users WHERE user_id = ?')) {
                if (db.failUserSelect) throw new Error('d1-user-select-fail');
                const userId = args[0] as string;
                userSelectCount += 1;
                const snapshot = users.has(userId) ? { user_id: userId } : null;
                if (mutatePresence && userSelectCount === mutatePresence.after) {
                  presence.splice(0, presence.length, ...mutatePresence.next);
                  events.push('mutate:presence-after-user-select');
                }
                return snapshot as T;
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
              alls.push({ sql, args });
              selects.push({ sql, args });
              events.push(`all:${sql.slice(0, 48)}`);
              await withSqlBarrier(
                allBarrier,
                allWaiters,
                () => {
                  allBarrier = undefined;
                },
                sql,
                args
              );

              if (sql.includes('SUBSTR(rm2.user_id') && sql.includes('room_memberships rm1')) {
                if (db.failServersAll) throw new Error('d1-servers-all-fail');
                const requester = args[0] as string;
                serversAllCount += 1;
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
                if (mutateMembership && serversAllCount === mutateMembership.after) {
                  memberships.splice(0, memberships.length, ...mutateMembership.next);
                  events.push('mutate:membership-after-servers-all');
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
              await withSqlBarrier(
                runBarrier,
                runWaiters,
                () => {
                  runBarrier = undefined;
                },
                sql,
                args
              );

              if (sql.includes('INSERT INTO presence')) {
                inserts.push({ sql, args });
                insertCount += 1;
                events.push('run:insert-presence');
                if (
                  opts.failInsertAfter !== undefined &&
                  insertCount > opts.failInsertAfter
                ) {
                  throw new Error('d1-insert-fail');
                }
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
                updateCount += 1;
                events.push('run:update-last-active');
                if (
                  opts.failUpdateAfter !== undefined &&
                  updateCount > opts.failUpdateAfter
                ) {
                  throw new Error('d1-update-fail');
                }
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

function createEnv(opts: {
  db?: PresenceDb;
  cache?: RaceKv;
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

function seedPresence(
  overrides: Partial<PresenceRow> = {}
): PresenceRow {
  return {
    user_id: overrides.user_id ?? USER,
    presence: overrides.presence ?? 'offline',
    status_msg: overrides.status_msg ?? null,
    last_active_ts: overrides.last_active_ts ?? NOW - 5000,
  };
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
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
// D1 INSERT run barrier — dual PUT last-write-wins TOCTOU
// ---------------------------------------------------------------------------

describe('race PUT presence INSERT run barrier TOCTOU after #202', () => {
  it('parallel PUT distinct states under INSERT barrier: both 200, one survivor', async () => {
    const db = createPresenceDb({
      memberships: [],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('INSERT INTO presence'),
      },
    });
    const cache = mockKv();
    const env = createEnv({ db, cache });
    const results = await Promise.all([
      request(env, statusPath(), jsonInit('PUT', { presence: 'online', status_msg: 'a' })),
      request(env, statusPath(), jsonInit('PUT', { presence: 'unavailable', status_msg: 'b' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.inserts).toHaveLength(2);
    expect(db.presence).toHaveLength(1);
    expect(['online', 'unavailable']).toContain(db.presence[0].presence);
    expect(cache.puts).toHaveLength(2);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe(db.presence[0].presence);
  });

  it('sequential PUT preserves last write without barrier loss', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    expect(
      (await request(env, statusPath(), jsonInit('PUT', { presence: 'online', status_msg: '1' })))
        .status
    ).toBe(200);
    expect(
      (
        await request(
          env,
          statusPath(),
          jsonInit('PUT', { presence: 'offline', status_msg: '2' })
        )
      ).status
    ).toBe(200);
    expect(env._db.presence[0]).toMatchObject({
      presence: 'offline',
      status_msg: '2',
    });
  });

  for (let i = 0; i < 12; i++) {
    it(`INSERT barrier soft-${i}: dual PUT same state under barrier`, async () => {
      const db = createPresenceDb({
        memberships: [],
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('INSERT INTO presence'),
        },
      });
      const env = createEnv({ db });
      const a = (['online', 'offline', 'unavailable'] as const)[i % 3];
      const b = (['online', 'offline', 'unavailable'] as const)[(i + 1) % 3];
      const results = await Promise.all([
        request(env, statusPath(), jsonInit('PUT', { presence: a, status_msg: `sa-${i}` })),
        request(env, statusPath(), jsonInit('PUT', { presence: b, status_msg: `sb-${i}` })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.presence).toHaveLength(1);
      expect([a, b]).toContain(db.presence[0].presence);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`INSERT barrier triple soft-${i}: three PUTs one survivor`, async () => {
      const db = createPresenceDb({
        memberships: [],
        runBarrier: {
          count: 3,
          match: (sql) => sql.includes('INSERT INTO presence'),
        },
      });
      const env = createEnv({ db });
      const states = ['online', 'offline', 'unavailable'] as const;
      const results = await Promise.all(
        states.map((presence, idx) =>
          request(
            env,
            statusPath(),
            jsonInit('PUT', { presence, status_msg: `t-${i}-${idx}` })
          )
        )
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(db.presence).toHaveLength(1);
      expect(states).toContain(db.presence[0].presence as (typeof states)[number]);
    });
  }
});

// ---------------------------------------------------------------------------
// KV put barrier — write-through split TOCTOU (D1 written, KV delayed)
// ---------------------------------------------------------------------------

describe('race PUT KV put barrier write-through split after #202', () => {
  it('GET mid-flight while first PUT held at KV put (count=2) sees D1 write-through gap', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [seedPresence({ presence: 'offline', status_msg: 'old' })],
      memberships: [],
    });
    // Empty cache → GET falls back to D1 after INSERT completes but before KV put releases
    const cache = mockKv(
      {},
      {
        putBarrier: {
          count: 2,
          match: (key) => key === `presence:${USER}`,
        },
      }
    );
    const env = createEnv({ db, cache });

    const put1 = request(
      env,
      statusPath(),
      jsonInit('PUT', { presence: 'online', status_msg: 'new' })
    );
    // Flush until INSERT done and put1 waits on KV barrier
    for (let n = 0; n < 20 && db.inserts.length < 1; n++) {
      await Promise.resolve();
    }
    expect(db.inserts).toHaveLength(1);
    expect(cache.puts).toHaveLength(0);

    const getRes = await request(env, statusPath(), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(getRes.status).toBe(200);
    // D1 already has online; cache miss → GET reads D1
    expect((getRes.body as { presence: string }).presence).toBe('online');
    expect((getRes.body as { status_msg?: string }).status_msg).toBe('new');

    // Second PUT releases the shared put barrier
    const put2 = request(
      env,
      statusPath(),
      jsonInit('PUT', { presence: 'unavailable', status_msg: 'release' })
    );
    const [r1, r2] = await Promise.all([put1, put2]);
    expect(statusesOf([r1, r2])).toEqual([200, 200]);
    expect(cache.puts).toHaveLength(2);
  });

  it('stale KV wins GET while first PUT held at put barrier (cache-first)', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [seedPresence({ presence: 'offline', status_msg: 'stale' })],
      memberships: [],
    });
    const cache = mockKv(
      {
        [`presence:${USER}`]: JSON.stringify({
          presence: 'offline',
          status_msg: 'stale',
          last_active_ts: NOW - 1000,
        }),
      },
      {
        putBarrier: {
          count: 2,
          match: (key) => key === `presence:${USER}`,
        },
      }
    );
    const env = createEnv({ db, cache });
    const put1 = request(
      env,
      statusPath(),
      jsonInit('PUT', { presence: 'online', status_msg: 'fresh' })
    );
    for (let n = 0; n < 20 && db.inserts.length < 1; n++) {
      await Promise.resolve();
    }
    const getRes = await request(env, statusPath(), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(getRes.status).toBe(200);
    // Cache-first: GET still sees stale offline while put held
    expect((getRes.body as { presence: string }).presence).toBe('offline');
    expect((getRes.body as { status_msg?: string }).status_msg).toBe('stale');

    const put2 = request(
      env,
      statusPath(),
      jsonInit('PUT', { presence: 'unavailable', status_msg: 'release' })
    );
    await Promise.all([put1, put2]);
  });

  for (let i = 0; i < 10; i++) {
    it(`KV put barrier soft-${i}: dual PUT under put barrier`, async () => {
      const cache = mockKv(
        {},
        {
          putBarrier: {
            count: 2,
            match: (key) => key.startsWith('presence:'),
          },
        }
      );
      const env = createEnv({
        db: createPresenceDb({ memberships: [] }),
        cache,
      });
      const results = await Promise.all([
        request(
          env,
          statusPath(),
          jsonInit('PUT', { presence: 'online', status_msg: `ka-${i}` })
        ),
        request(
          env,
          statusPath(),
          jsonInit('PUT', { presence: 'unavailable', status_msg: `kb-${i}` })
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(cache.puts).toHaveLength(2);
      expect(JSON.parse(cache.data[`presence:${USER}`]).presence).toMatch(
        /online|unavailable/
      );
    });
  }
});

// ---------------------------------------------------------------------------
// KV get barrier — GET∥PUT mid-flight
// ---------------------------------------------------------------------------

describe('race GET∥PUT mid-flight + dual-GET get barrier after #202', () => {
  it('dual GET under get barrier count=2 while PUT write-through races', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [seedPresence({ presence: 'offline', status_msg: 'pre' })],
      memberships: [],
    });
    const cache = mockKv(
      {
        [`presence:${USER}`]: JSON.stringify({
          presence: 'offline',
          status_msg: 'pre',
          last_active_ts: NOW - 2000,
        }),
      },
      {
        getBarrier: {
          count: 2,
          match: (key) => key === `presence:${USER}`,
        },
      }
    );
    const env = createEnv({ db, cache });
    // PUT does not hit get barrier — races freely; dual GETs synchronize on get
    const results = await Promise.all([
      request(env, statusPath(), { headers: { Authorization: 'Bearer t' } }),
      request(env, statusPath(), { headers: { Authorization: 'Bearer t' } }),
      request(env, statusPath(), jsonInit('PUT', { presence: 'online', status_msg: 'post' })),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    const gets = results.slice(0, 2);
    for (const g of gets) {
      expect(['online', 'offline']).toContain((g.body as { presence: string }).presence);
    }
  });

  it('mutate-after-get injects cache mid GET; subsequent GET may see injected', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [
        seedPresence({ presence: 'online', status_msg: 'a', last_active_ts: NOW }),
      ],
      memberships: [],
    });
    const cache = mockKv(
      {
        [`presence:${USER}`]: JSON.stringify({
          presence: 'online',
          status_msg: 'a',
          last_active_ts: NOW,
        }),
      },
      {
        mutateAfterGets: {
          after: 1,
          next: {
            [`presence:${USER}`]: JSON.stringify({
              presence: 'offline',
              status_msg: 'injected',
              last_active_ts: NOW,
            }),
          },
        },
      }
    );
    const env = createEnv({ db, cache });
    const first = await request(env, statusPath(), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(first.status).toBe(200);
    expect(cache.events).toContain('mutate:after-get');
    const second = await request(env, statusPath(), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(second.status).toBe(200);
    expect((second.body as { status_msg?: string }).status_msg).toBe('injected');
    expect((second.body as { presence: string }).presence).toBe('offline');
  });

  for (let i = 0; i < 12; i++) {
    it(`GET∥PUT soft-${i} (no shared get barrier — PUT skips CACHE.get)`, async () => {
      const state = (['online', 'offline', 'unavailable'] as const)[i % 3];
      const db = createPresenceDb({
        users: [USER],
        presence: [seedPresence({ presence: 'offline', status_msg: `g-${i}` })],
        memberships: [],
      });
      const cache = mockKv({
        [`presence:${USER}`]: JSON.stringify({
          presence: 'offline',
          status_msg: `g-${i}`,
          last_active_ts: NOW - 100,
        }),
      });
      const env = createEnv({ db, cache });
      const [getRes, putRes] = await Promise.all([
        request(env, statusPath(), { headers: { Authorization: 'Bearer t' } }),
        request(
          env,
          statusPath(),
          jsonInit('PUT', { presence: state, status_msg: `p-${i}` })
        ),
      ]);
      expect(getRes.status).toBe(200);
      expect(putRes.status).toBe(200);
    });
  }
});

// ---------------------------------------------------------------------------
// GET user SELECT → presence mutate mid-flight TOCTOU
// ---------------------------------------------------------------------------

describe('race GET user SELECT→presence mutate TOCTOU after #202', () => {
  it('presence row replaced after user SELECT; GET reads injected D1 row', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [seedPresence({ presence: 'online', status_msg: 'before', last_active_ts: NOW })],
      memberships: [],
      mutatePresenceAfterUserSelects: {
        after: 1,
        next: [
          seedPresence({
            presence: 'unavailable',
            status_msg: 'after',
            last_active_ts: NOW - 10,
          }),
        ],
      },
    });
    // Force D1 path (no cache)
    const env = createEnv({ db, cache: mockKv() });
    const getRes = await request(env, statusPath(), {
      headers: { Authorization: 'Bearer t' },
    });
    expect(getRes.status).toBe(200);
    expect(db.events).toContain('mutate:presence-after-user-select');
    // Mutate runs after user SELECT, before presence SELECT → injected row
    expect((getRes.body as { presence: string }).presence).toBe('unavailable');
    expect((getRes.body as { status_msg?: string }).status_msg).toBe('after');
  });

  it('dual GET under user-select barrier both 200 after mutate on first', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [seedPresence({ presence: 'offline', status_msg: 'seed' })],
      memberships: [],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('SELECT user_id FROM users'),
      },
      mutatePresenceAfterUserSelects: {
        after: 1,
        next: [
          seedPresence({
            presence: 'online',
            status_msg: 'mut',
            last_active_ts: NOW,
          }),
        ],
      },
    });
    const env = createEnv({ db, cache: mockKv() });
    const results = await Promise.all([
      request(env, statusPath(), { headers: { Authorization: 'Bearer t' } }),
      request(env, statusPath(), { headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.events).toContain('mutate:presence-after-user-select');
  });

  for (let i = 0; i < 10; i++) {
    it(`user-select mutate soft-${i}: GET after injected presence`, async () => {
      const injected = (['online', 'offline', 'unavailable'] as const)[i % 3];
      const db = createPresenceDb({
        users: [USER],
        presence: [seedPresence({ presence: 'offline', status_msg: 'seed' })],
        memberships: [],
        mutatePresenceAfterUserSelects: {
          after: 1,
          next: [
            seedPresence({
              presence: injected,
              status_msg: `inj-${i}`,
              last_active_ts: NOW,
            }),
          ],
        },
      });
      const env = createEnv({ db, cache: mockKv() });
      const res = await request(env, statusPath(), {
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(200);
      expect((res.body as { presence: string }).presence).toBe(injected);
      expect((res.body as { status_msg?: string }).status_msg).toBe(`inj-${i}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Federation membership mutate mid servers ALL TOCTOU
// ---------------------------------------------------------------------------

describe('race federation servers ALL→membership mutate TOCTOU after #202', () => {
  it('membership cleared after servers discovery snapshot; EDU still fans out from snapshot', async () => {
    const federation = createFederationStub();
    const db = createPresenceDb({
      memberships: sharedRoomMemberships([REMOTE, REMOTE2], { includeBob: false }),
      mutateMembershipAfterServersAll: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      },
    });
    const env = createEnv({ db, federation });
    const res = await request(
      env,
      statusPath(),
      jsonInit('PUT', { presence: 'online', status_msg: 'fed-race' })
    );
    expect(res.status).toBe(200);
    expect(db.events).toContain('mutate:membership-after-servers-all');
    // Snapshot computed before mutate still had remotes
    expect(federation.fetches.length).toBeGreaterThanOrEqual(1);
    expect(env._idCalls).toEqual(expect.arrayContaining([REMOTE, REMOTE2]));
  });

  it('parallel PUT under servers ALL barrier both complete with fan-out', async () => {
    const federation = createFederationStub();
    const db = createPresenceDb({
      memberships: sharedRoomMemberships([REMOTE]),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('room_memberships rm1'),
      },
    });
    const env = createEnv({ db, federation });
    const results = await Promise.all([
      request(env, statusPath(), jsonInit('PUT', { presence: 'online', status_msg: 'f1' })),
      request(env, statusPath(), jsonInit('PUT', { presence: 'offline', status_msg: 'f2' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(federation.fetches.length).toBeGreaterThanOrEqual(2);
  });

  for (let i = 0; i < 8; i++) {
    it(`fed membership mutate soft-${i}`, async () => {
      const federation = createFederationStub();
      const db = createPresenceDb({
        memberships: sharedRoomMemberships([REMOTE]),
        mutateMembershipAfterServersAll: {
          after: 1,
          next: [
            { room_id: ROOM, user_id: USER, membership: 'join' },
            // remotes removed — only affects subsequent discoveries
          ],
        },
      });
      const env = createEnv({ db, federation });
      const res = await request(
        env,
        statusPath(),
        jsonInit('PUT', {
          presence: i % 2 ? 'unavailable' : 'online',
          status_msg: `fm-${i}`,
        })
      );
      expect(res.status).toBe(200);
      expect(federation.fetches.length).toBeGreaterThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// updateLastActive ∥ PUT last_active_ts race
// ---------------------------------------------------------------------------

describe('race updateLastActive∥PUT last_active_ts after #202', () => {
  it('parallel updateLastActive and PUT under shared run barrier both succeed', async () => {
    const db = createPresenceDb({
      presence: [seedPresence({ presence: 'online', last_active_ts: 0 })],
      memberships: [],
      runBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('INSERT INTO presence') ||
          sql.includes('UPDATE presence SET last_active_ts'),
      },
    });
    const env = createEnv({ db });
    const [putRes] = await Promise.all([
      request(env, statusPath(), jsonInit('PUT', { presence: 'online', status_msg: 'act' })),
      updateLastActive(db as unknown as D1Database, USER),
    ]);
    expect(putRes.status).toBe(200);
    expect(db.inserts.length + db.updates.length).toBeGreaterThanOrEqual(2);
    expect(db.presence[0].last_active_ts).toBe(NOW);
  });

  it('updateLastActive after PUT preserves row and advances ts', async () => {
    const db = createPresenceDb({ memberships: [] });
    const env = createEnv({ db });
    await request(env, statusPath(), jsonInit('PUT', { presence: 'online' }));
    vi.setSystemTime(NOW + 60_000);
    await updateLastActive(db as unknown as D1Database, USER);
    expect(db.presence[0].last_active_ts).toBe(NOW + 60_000);
    expect(db.presence[0].presence).toBe('online');
  });

  for (let i = 0; i < 10; i++) {
    it(`updateLastActive∥PUT soft-${i}`, async () => {
      const db = createPresenceDb({
        presence: [seedPresence({ presence: 'online', last_active_ts: i })],
        memberships: [],
      });
      const env = createEnv({ db });
      await Promise.all([
        request(
          env,
          statusPath(),
          jsonInit('PUT', {
            presence: (['online', 'unavailable'] as const)[i % 2],
            status_msg: `u-${i}`,
          })
        ),
        updateLastActive(db as unknown as D1Database, USER),
        updateLastActive(db as unknown as D1Database, USER),
      ]);
      expect(db.presence).toHaveLength(1);
      expect(db.presence[0].last_active_ts).toBe(NOW);
    });
  }
});

// ---------------------------------------------------------------------------
// getPresenceForUsers ∥ PUT cache coherency
// ---------------------------------------------------------------------------

describe('race getPresenceForUsers∥PUT cache coherency after #202', () => {
  it('batch helper races with PUT write-through without shared get deadlock', async () => {
    const db = createPresenceDb({
      presence: [
        seedPresence({ user_id: USER, presence: 'offline', status_msg: 'old' }),
        seedPresence({ user_id: BOB, presence: 'online', status_msg: 'bob', last_active_ts: NOW }),
      ],
      memberships: [],
    });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'offline',
        status_msg: 'old',
        last_active_ts: NOW - 1000,
      }),
      [`presence:${BOB}`]: JSON.stringify({
        presence: 'online',
        status_msg: 'bob',
        last_active_ts: NOW,
      }),
    });
    const env = createEnv({ db, cache });
    const [batch, putRes] = await Promise.all([
      getPresenceForUsers(db as unknown as D1Database, [USER, BOB], cache),
      request(env, statusPath(), jsonInit('PUT', { presence: 'online', status_msg: 'new' })),
    ]);
    expect(putRes.status).toBe(200);
    expect(batch[BOB]).toMatchObject({ presence: 'online', status_msg: 'bob' });
    expect(batch[USER]).toBeDefined();
    expect(['online', 'offline']).toContain(batch[USER].presence);
  });

  it('two helpers under get barrier count=2 while PUT races', async () => {
    const db = createPresenceDb({
      presence: [
        seedPresence({ user_id: USER, presence: 'online', status_msg: 'a', last_active_ts: NOW }),
      ],
      memberships: [],
    });
    const cache = mockKv(
      {
        [`presence:${USER}`]: JSON.stringify({
          presence: 'online',
          status_msg: 'a',
          last_active_ts: NOW,
        }),
      },
      {
        getBarrier: {
          count: 2,
          match: (key) => key === `presence:${USER}`,
        },
      }
    );
    const env = createEnv({ db, cache });
    const [b1, b2, putRes] = await Promise.all([
      getPresenceForUsers(db as unknown as D1Database, [USER], cache),
      getPresenceForUsers(db as unknown as D1Database, [USER], cache),
      request(env, statusPath(), jsonInit('PUT', { presence: 'offline', status_msg: 'p' })),
    ]);
    expect(putRes.status).toBe(200);
    expect(b1[USER]).toBeDefined();
    expect(b2[USER]).toBeDefined();
  });

  it('parallel getPresenceForUsers and dual PUT do not throw', async () => {
    const db = createPresenceDb({
      presence: [seedPresence({ presence: 'offline' })],
      memberships: [],
    });
    const cache = mockKv();
    const env = createEnv({ db, cache });
    const [batch, ...puts] = await Promise.all([
      getPresenceForUsers(db as unknown as D1Database, [USER, BOB, CAROL], cache),
      request(env, statusPath(), jsonInit('PUT', { presence: 'online' })),
      request(env, statusPath(), jsonInit('PUT', { presence: 'unavailable' })),
    ]);
    expect(puts.every((r) => r.status === 200)).toBe(true);
    expect(typeof batch).toBe('object');
  });

  for (let i = 0; i < 10; i++) {
    it(`helper∥PUT soft-${i}`, async () => {
      const ids = [USER, BOB, `@x${i}:example.com`];
      const db = createPresenceDb({
        users: ids,
        presence: ids.map((user_id, idx) =>
          seedPresence({
            user_id,
            presence: idx % 2 ? 'offline' : 'online',
            last_active_ts: NOW - idx,
          })
        ),
        memberships: [],
      });
      const cache = mockKv();
      const env = createEnv({ db, cache });
      const [batch, putRes] = await Promise.all([
        getPresenceForUsers(db as unknown as D1Database, ids, cache),
        request(
          env,
          statusPath(),
          jsonInit('PUT', {
            presence: (['online', 'offline', 'unavailable'] as const)[i % 3],
            status_msg: `h-${i}`,
          })
        ),
      ]);
      expect(putRes.status).toBe(200);
      expect(Object.keys(batch).length).toBeGreaterThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Store failure mid concurrent
// ---------------------------------------------------------------------------

describe('race presence store failure mid concurrent after #202', () => {
  it('first INSERT ok, second throws → one 200 one 500', async () => {
    const db = createPresenceDb({
      memberships: [],
      failInsertAfter: 1,
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('INSERT INTO presence'),
      },
    });
    // failInsertAfter: insertCount > 1 throws on second
    const env = createEnv({ db });
    const results = await Promise.all([
      request(env, statusPath(), jsonInit('PUT', { presence: 'online', status_msg: 'ok' })),
      request(env, statusPath(), jsonInit('PUT', { presence: 'offline', status_msg: 'boom' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 500]);
  });

  it('failInsertAfter=0 both 500 under barrier', async () => {
    const db = createPresenceDb({
      memberships: [],
      failInsertAfter: 0,
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('INSERT INTO presence'),
      },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      request(env, statusPath(), jsonInit('PUT', { presence: 'online' })),
      request(env, statusPath(), jsonInit('PUT', { presence: 'offline' })),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('KV put fail after D1 insert surfaces as 500', async () => {
    const cache = mockKv({}, { failPutAfter: 0 });
    const env = createEnv({
      db: createPresenceDb({ memberships: [] }),
      cache,
    });
    const res = await request(env, statusPath(), jsonInit('PUT', { presence: 'online' }));
    expect(res.status).toBe(500);
    expect(env._db.inserts).toHaveLength(1);
  });

  for (let i = 0; i < 8; i++) {
    it(`insert fail soft-${i}: failInsertAfter=0 parallel both 500`, async () => {
      const db = createPresenceDb({
        memberships: [],
        failInsertAfter: 0,
      });
      const env = createEnv({ db });
      const results = await Promise.all([
        request(env, statusPath(), jsonInit('PUT', { presence: 'online', status_msg: `a-${i}` })),
        request(env, statusPath(), jsonInit('PUT', { presence: 'offline', status_msg: `b-${i}` })),
      ]);
      expect(statusesOf(results)).toEqual([500, 500]);
    });
  }

  it('federation total fail still returns 200 after D1+KV write', async () => {
    const federation = createFederationStub({ fail: true });
    const db = createPresenceDb({ memberships: sharedRoomMemberships() });
    const env = createEnv({ db, federation });
    const results = await Promise.all([
      request(env, statusPath(), jsonInit('PUT', { presence: 'online' })),
      request(env, statusPath(), jsonInit('PUT', { presence: 'unavailable' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.presence).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Clock remap mid concurrent GET
// ---------------------------------------------------------------------------

describe('race clock remap mid concurrent GET after #202', () => {
  it('dual GET: one before timeout remap, one after advance', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [
        seedPresence({
          presence: 'online',
          status_msg: 'tick',
          last_active_ts: NOW,
        }),
      ],
      memberships: [],
    });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 'tick',
        last_active_ts: NOW,
      }),
    });
    const env = createEnv({ db, cache });
    const first = await request(env, statusPath(), {
      headers: { Authorization: 'Bearer t' },
    });
    expect((first.body as { presence: string }).presence).toBe('online');
    expect((first.body as { currently_active: boolean }).currently_active).toBe(true);

    vi.setSystemTime(NOW + PRESENCE_TIMEOUT + 1);
    const second = await request(env, statusPath(), {
      headers: { Authorization: 'Bearer t' },
    });
    expect((second.body as { presence: string }).presence).toBe('unavailable');
    expect((second.body as { currently_active: boolean }).currently_active).toBe(false);
  });

  for (let i = 0; i < 8; i++) {
    it(`clock remap soft-${i}: PUT online then GET past timeout`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      await request(
        env,
        statusPath(),
        jsonInit('PUT', { presence: 'online', status_msg: `clk-${i}` })
      );
      vi.setSystemTime(NOW + PRESENCE_TIMEOUT + i + 1);
      const res = await request(env, statusPath(), {
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(200);
      expect((res.body as { presence: string }).presence).toBe('unavailable');
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — invalid method matrix under parallel
// ---------------------------------------------------------------------------

describe('presence concurrent soft flood — invalid method matrix after #202', () => {
  const methods = ['POST', 'PATCH', 'DELETE', 'OPTIONS'] as const;
  for (const method of methods) {
    it(`rejects or no-routes ${method} under parallel load`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(env, statusPath(), {
            method,
            headers: {
              Authorization: 'Bearer t',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ presence: 'online' }),
          })
        )
      );
      expect(results.every((r) => r.status !== 200)).toBe(true);
      expect(env._db.inserts).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — bad JSON / body edges under parallel
// ---------------------------------------------------------------------------

describe('presence concurrent soft flood — bad JSON / body edges after #202', () => {
  const badBodies: Array<{ label: string; body: unknown; expectStatus: number }> = [
    { label: 'empty-obj', body: {}, expectStatus: 400 },
    { label: 'number-presence', body: { presence: 1 }, expectStatus: 400 },
    { label: 'array-root', body: ['online'], expectStatus: 400 },
    { label: 'string-root', body: 'online', expectStatus: 400 },
    { label: 'invalid-state', body: { presence: 'busy' }, expectStatus: 400 },
    { label: 'null-presence', body: { presence: null }, expectStatus: 400 },
  ];

  for (let i = 0; i < badBodies.length; i++) {
    const entry = badBodies[i];
    it(`PUT body soft-${i} (${entry.label}) parallel`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const results = await Promise.all([
        request(env, statusPath(), jsonInit('PUT', entry.body)),
        request(env, statusPath(), jsonInit('PUT', entry.body)),
      ]);
      expect(results.every((r) => r.status === entry.expectStatus)).toBe(true);
      expect(env._db.inserts).toHaveLength(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`truncated JSON soft-${i} parallel`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const results = await Promise.all([
        request(env, statusPath(), {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer t',
            'Content-Type': 'application/json',
          },
          body: '{"presence":"onlin',
        }),
        request(env, statusPath(), {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer t',
            'Content-Type': 'application/json',
          },
          body: '{',
        }),
      ]);
      expect(results.every((r) => r.status === 400)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — foreign user / own-user gate under parallel
// ---------------------------------------------------------------------------

describe('presence concurrent soft flood — foreign user / own-user gate after #202', () => {
  for (let i = 0; i < 10; i++) {
    it(`foreign user soft-${i}`, async () => {
      const db = createPresenceDb({ memberships: sharedRoomMemberships() });
      const env = createEnv({ db });
      const results = await Promise.all([
        request(env, statusPath(BOB), jsonInit('PUT', { presence: 'online' })),
        request(env, statusPath(CAROL), jsonInit('PUT', { presence: 'offline' })),
        request(env, statusPath(USER), jsonInit('PUT', { presence: 'online', status_msg: `ok-${i}` })),
      ]);
      expect(statusesOf(results)).toEqual([200, 403, 403]);
      expect(db.presence).toHaveLength(1);
      expect(db.presence[0].user_id).toBe(USER);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`encoded foreign soft-${i}`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const res = await request(
        env,
        `/_matrix/client/v3/presence/${BOB_ENC}/status`,
        jsonInit('PUT', { presence: 'online' })
      );
      expect(res.status).toBe(403);
      expect(env._db.inserts).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — charset / content-type under parallel
// ---------------------------------------------------------------------------

describe('presence concurrent soft flood — charset / content-type after #202', () => {
  const contentTypes = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json; charset=iso-8859-1',
  ];

  for (let i = 0; i < contentTypes.length; i++) {
    const ct = contentTypes[i];
    it(`content-type soft-${i}: ${ct}`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const results = await Promise.all([
        request(env, statusPath(), {
          method: 'PUT',
          headers: { Authorization: 'Bearer t', 'Content-Type': ct },
          body: JSON.stringify({ presence: 'online', status_msg: `ct-${i}` }),
        }),
        request(env, statusPath(), {
          method: 'PUT',
          headers: { Authorization: 'Bearer t', 'Content-Type': ct },
          body: JSON.stringify({ presence: 'offline', status_msg: `ct2-${i}` }),
        }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — lifecycle put→get under parallel + isolation
// ---------------------------------------------------------------------------

describe('presence concurrent soft flood — lifecycle put→get after #202', () => {
  for (let i = 0; i < 12; i++) {
    it(`lifecycle soft-${i}`, async () => {
      const state = (['online', 'offline', 'unavailable'] as const)[i % 3];
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const put = await request(
        env,
        statusPath(),
        jsonInit('PUT', { presence: state, status_msg: `life-${i}` })
      );
      expect(put.status).toBe(200);
      const get = await request(env, statusPath(), {
        headers: { Authorization: 'Bearer t' },
      });
      expect(get.status).toBe(200);
      expect((get.body as { presence: string }).presence).toBe(state);
      expect((get.body as { status_msg?: string }).status_msg).toBe(`life-${i}`);
      const again = await request(
        env,
        statusPath(),
        jsonInit('PUT', { presence: 'offline', status_msg: 'again' })
      );
      expect(again.status).toBe(200);
      expect(env._db.presence[0].presence).toBe('offline');
    });
  }

  it('cross-user GET isolation under parallel PUTs for alice', async () => {
    const db = createPresenceDb({
      users: [USER, BOB],
      presence: [
        seedPresence({
          user_id: BOB,
          presence: 'unavailable',
          status_msg: 'bob-only',
          last_active_ts: NOW,
        }),
      ],
      memberships: [],
    });
    const env = createEnv({ db });
    const [putRes, bobGet, aliceGet] = await Promise.all([
      request(env, statusPath(), jsonInit('PUT', { presence: 'online', status_msg: 'alice' })),
      request(env, statusPath(BOB), { headers: { Authorization: 'Bearer t' } }),
      request(env, statusPath(USER), { headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(putRes.status).toBe(200);
    expect(bobGet.status).toBe(200);
    expect((bobGet.body as { status_msg?: string }).status_msg).toBe('bob-only');
    expect(aliceGet.status).toBe(200);
  });

  for (let i = 0; i < 6; i++) {
    it(`multi-room membership isolation soft-${i} (fed servers)`, async () => {
      const federation = createFederationStub();
      const db = createPresenceDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM, user_id: `@r:${REMOTE}`, membership: 'join' },
          { room_id: ROOM2, user_id: USER, membership: 'join' },
          { room_id: ROOM2, user_id: `@r2:${REMOTE2}`, membership: 'join' },
        ],
      });
      const env = createEnv({ db, federation });
      const results = await Promise.all([
        request(
          env,
          statusPath(),
          jsonInit('PUT', { presence: 'online', status_msg: `mr-${i}` })
        ),
        request(
          env,
          statusPath(),
          jsonInit('PUT', { presence: 'unavailable', status_msg: `mr2-${i}` })
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(new Set(env._idCalls)).toEqual(new Set([REMOTE, REMOTE2]));
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — status_msg edges under parallel
// ---------------------------------------------------------------------------

describe('presence concurrent soft flood — status_msg edges after #202', () => {
  const msgs: Array<{ label: string; status_msg: unknown; expected: string | null }> = [
    { label: 'empty', status_msg: '', expected: null },
    { label: 'unicode', status_msg: 'café ☕', expected: 'café ☕' },
    { label: 'long', status_msg: 'x'.repeat(200), expected: 'x'.repeat(200) },
    { label: 'zero', status_msg: 0, expected: null },
    { label: 'false', status_msg: false, expected: null },
  ];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    it(`status_msg soft-${i} (${m.label}) parallel last-write-wins`, async () => {
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      const results = await Promise.all([
        request(
          env,
          statusPath(),
          jsonInit('PUT', { presence: 'online', status_msg: m.status_msg })
        ),
        request(
          env,
          statusPath(),
          jsonInit('PUT', { presence: 'online', status_msg: m.status_msg })
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(env._db.presence[0].status_msg).toBe(m.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Bind contracts under parallel
// ---------------------------------------------------------------------------

describe('presence concurrent SQL/KV bind contracts after #202', () => {
  it('parallel PUT bind contracts stay per-user ON CONFLICT order', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    await Promise.all([
      request(env, statusPath(), jsonInit('PUT', { presence: 'online', status_msg: 'b1' })),
      request(env, statusPath(), jsonInit('PUT', { presence: 'offline', status_msg: 'b2' })),
    ]);
    expect(env._db.inserts).toHaveLength(2);
    for (const ins of env._db.inserts) {
      expect(ins.sql).toContain('ON CONFLICT');
      expect(ins.args[0]).toBe(USER);
      expect(['online', 'offline']).toContain(ins.args[1]);
      expect(ins.args[3]).toBe(NOW);
    }
    expect(env._cache.puts.every((p) => p.options?.expirationTtl === 300)).toBe(true);
    expect(env._cache.puts.every((p) => p.key === `presence:${USER}`)).toBe(true);
  });

  it('URL-encoded path binds decoded user id under parallel', async () => {
    const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
    const results = await Promise.all([
      request(
        env,
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'online' })
      ),
      request(
        env,
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'unavailable' })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(env._db.inserts.every((c) => c.args[0] === USER)).toBe(true);
  });

  it('updateLastActive binds ts then user_id under parallel', async () => {
    const db = createPresenceDb({
      presence: [
        seedPresence({ user_id: USER, presence: 'online', last_active_ts: 0 }),
        seedPresence({ user_id: BOB, presence: 'online', last_active_ts: 0 }),
      ],
    });
    await Promise.all([
      updateLastActive(db as unknown as D1Database, USER),
      updateLastActive(db as unknown as D1Database, BOB),
    ]);
    expect(db.updates).toHaveLength(2);
    expect(
      db.updates.map((u) => u.args).sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    ).toEqual([
      [NOW, USER],
      [NOW, BOB],
    ]);
  });

  for (let i = 0; i < 8; i++) {
    it(`bind soft-${i}: PUT then GET cache key`, async () => {
      const state = (['online', 'offline', 'unavailable'] as const)[i % 3];
      const env = createEnv({ db: createPresenceDb({ memberships: [] }) });
      await request(
        env,
        statusPath(),
        jsonInit('PUT', { presence: state, status_msg: `bind-${i}` })
      );
      expect(env._cache.puts[0].key).toBe(`presence:${USER}`);
      expect(JSON.parse(env._cache.puts[0].value)).toEqual({
        presence: state,
        status_msg: `bind-${i}`,
        last_active_ts: NOW,
      });
      const get = await request(env, statusPath(), {
        headers: { Authorization: 'Bearer t' },
      });
      expect((get.body as { presence: string }).presence).toBe(state);
    });
  }
});

// ---------------------------------------------------------------------------
// Unknown user / default offline under concurrent GET
// ---------------------------------------------------------------------------

describe('race GET unknown / default-offline concurrent after #202', () => {
  it('parallel GET unknown user all 404 without presence side effects', async () => {
    const db = createPresenceDb({ users: [USER], presence: [], memberships: [] });
    const env = createEnv({ db });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(env, statusPath('@ghost:example.com'), {
          headers: { Authorization: 'Bearer t' },
        })
      )
    );
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.inserts).toHaveLength(0);
    expect(env._cache.puts).toHaveLength(0);
  });

  for (let i = 0; i < 8; i++) {
    it(`default-offline soft-${i} parallel GET for user without presence`, async () => {
      const uid = `@nopres-${i}:example.com`;
      const db = createPresenceDb({ users: [uid], presence: [], memberships: [] });
      const env = createEnv({ db, cache: mockKv() });
      const results = await Promise.all([
        request(env, statusPath(uid), { headers: { Authorization: 'Bearer t' } }),
        request(env, statusPath(uid), { headers: { Authorization: 'Bearer t' } }),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.every((r) => (r.body as { presence: string }).presence === 'offline')).toBe(
        true
      );
      expect(
        results.every((r) => (r.body as { currently_active: boolean }).currently_active === false)
      ).toBe(true);
    });
  }
});
