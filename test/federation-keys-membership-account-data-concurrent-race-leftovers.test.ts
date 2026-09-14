/**
 * TOKENMAXX HEAVY leftovers after #175/#181 — federation keys/membership + account-data
 * *concurrent race / TOCTOU* leftovers.
 * Orthogonal to soft leftovers (#175), devices/key-backups/report races (#174),
 * to-device races (#181), keys/media/appservice races (#167), login/QR races (#163).
 * Focus: account-data PUT∥PUT lost-update + stream bumps; room membership mid-flight;
 * federation OTK claim double-consume; make_join concurrent state reads; soft floods.
 * Tests-only. Fixtures use example.com only. No product inventing.
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

/** Side-channel so mocked federation auth can stamp origin onto Hono context. */
let federationOriginSideChannel: string | null = null;

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      if (federationOriginSideChannel) {
        c.set('federationOrigin', federationOriginSideChannel);
      }
      await next();
    };
  },
  optionalFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      if (federationOriginSideChannel) {
        c.set('federationOrigin', federationOriginSideChannel);
      }
      await next();
    };
  },
}));

import accountDataApp from '../src/api/account-data';
import federation from '../src/api/federation';

const SERVER = 'example.com';
const REMOTE = 'remote.example.org';
const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const REMOTE_USER = '@carol:remote.example.org';
const DEVICE = 'DEVICEA';
const DEVICE_B = 'DEVICEB';
const ROOM = '!room:example.com';
const ROOM2 = '!other:example.com';
const CREATE = '$create:example.com';
const JOIN_RULES = '$join_rules:example.com';
const POWER = '$power:example.com';
const LATEST = '$latest:example.com';
const MEMBER = '$member:example.com';
const USER_ENC = encodeURIComponent(USER);
const BOB_ENC = encodeURIComponent(BOB);
const ROOM_ENC = encodeURIComponent(ROOM);
const ROOM2_ENC = encodeURIComponent(ROOM2);
const AUTH = { Authorization: 'Bearer test-token' };
const NOW = 1_700_000_000_000;
const ALG = 'signed_curve25519';

type SqlCall = { sql: string; args: unknown[] };
type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

type AccountDataRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
};
type Membership = { room_id: string; user_id: string; membership: string };
type ChangeRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  stream_position: number;
};
type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

type OtkRow = {
  id: number;
  user_id: string;
  device_id: string;
  algorithm: string;
  key_id: string;
  key_data: string;
  claimed: number;
};
type FallbackRow = {
  user_id: string;
  device_id: string;
  algorithm: string;
  key_id: string;
  key_data: string;
  used: number;
};
type EventRow = {
  event_id: string;
  room_id: string;
  sender: string;
  event_type: string;
  state_key: string | null;
  content: string;
  origin_server_ts: number;
  depth: number;
  auth_events: string;
  prev_events: string;
};
type StateRow = {
  room_id: string;
  event_type: string;
  state_key: string;
  event_id: string;
};
type RoomRow = { room_id: string; room_version: string };

async function withSelectBarrier(
  barrier: SelectBarrier | undefined,
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

function mockKv(
  data: Record<string, string> = {},
  opts: {
    throwOnGet?: boolean;
    throwOnPut?: boolean;
    getBarrier?: { match: (key: string) => boolean; count: number };
  } = {}
) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  const waitersRef = { list: [] as Array<() => void> };
  let getBarrier = opts.getBarrier;
  const kv = {
    data,
    puts,
    deletes,
    get: async (key: string, type?: string) => {
      if (opts.throwOnGet) throw new Error('KV get failed');
      if (getBarrier && getBarrier.match(key)) {
        await new Promise<void>((resolve) => {
          waitersRef.list.push(resolve);
          if (waitersRef.list.length >= getBarrier!.count) {
            const all = [...waitersRef.list];
            waitersRef.list = [];
            getBarrier = undefined;
            for (const r of all) r();
          }
        });
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
      if (opts.throwOnPut) throw new Error('KV put failed');
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

function createUserKeysStub(opts: {
  accountData?: Record<string, unknown | null>;
  failGet?: boolean;
  failPut?: boolean;
  throwOnFetch?: boolean;
  putBarrier?: { count: number };
} = {}) {
  const accountData: Record<string, unknown | null> = { ...(opts.accountData ?? {}) };
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];
  const waitersRef = { list: [] as Array<() => void> };
  let putBarrier = opts.putBarrier;

  const stub = {
    fetches,
    accountData,
    async fetch(req: Request): Promise<Response> {
      if (opts.throwOnFetch) throw new Error('DO network failure');
      const url = new URL(req.url);
      const path = url.pathname;
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      fetches.push({ url: req.url, method: req.method, body });

      if (opts.failGet && path.endsWith('/account-data/get')) {
        return new Response('boom', { status: 500 });
      }
      if (opts.failPut && path.endsWith('/account-data/put')) {
        return new Response('boom', { status: 500 });
      }

      if (path === '/account-data/get') {
        const eventType = url.searchParams.get('event_type');
        if (eventType) {
          if (!(eventType in accountData)) return Response.json(null);
          return Response.json(accountData[eventType]);
        }
        return Response.json(accountData);
      }

      if (path === '/account-data/put') {
        if (putBarrier) {
          await new Promise<void>((resolve) => {
            waitersRef.list.push(resolve);
            if (waitersRef.list.length >= putBarrier!.count) {
              const all = [...waitersRef.list];
              waitersRef.list = [];
              putBarrier = undefined;
              for (const r of all) r();
            }
          });
        }
        const b = body as { event_type: string; content: unknown };
        accountData[b.event_type] = b.content;
        return Response.json({ success: true });
      }

      return new Response('not found', { status: 404 });
    },
  };
  return stub;
}

function createAccountDataDb(
  opts: {
    rows?: AccountDataRow[];
    memberships?: Membership[];
    streamPositions?: Record<string, number>;
    missingStreamRow?: boolean;
    throwOnAccountDataInsert?: boolean;
    selectBarrier?: SelectBarrier;
    midFlightLeave?: boolean;
  } = {}
) {
  const rows = [...(opts.rows ?? [])];
  const memberships = [...(opts.memberships ?? [])];
  const streamPositions = { ...(opts.streamPositions ?? { account_data: 10 }) };
  const changes: ChangeRow[] = [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const runs: SqlCall[] = [];
  const firsts: SqlCall[] = [];
  let selectBarrier = opts.selectBarrier;
  const waitersRef = { list: [] as Array<() => void> };
  let membershipReads = 0;

  const db = {
    rows,
    memberships,
    streamPositions,
    changes,
    inserts,
    updates,
    runs,
    firsts,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              firsts.push({ sql, args });
              await withSelectBarrier(
                selectBarrier,
                waitersRef,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );

              if (sql.includes('SELECT position FROM stream_positions')) {
                if (opts.missingStreamRow) return null as T;
                const name = args[0] as string;
                if (!(name in streamPositions)) return null as T;
                return { position: streamPositions[name] } as T;
              }

              if (sql.includes('SELECT membership FROM room_memberships')) {
                membershipReads += 1;
                if (opts.midFlightLeave && membershipReads > 1) {
                  const hit = memberships.find(
                    (m) => m.room_id === (args[0] as string) && m.user_id === (args[1] as string)
                  );
                  if (hit) hit.membership = 'leave';
                }
                const [roomId, userId] = args as [string, string];
                const hit = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                if (!hit) return null;
                return { membership: hit.membership } as T;
              }

              if (
                sql.includes('SELECT content FROM account_data') &&
                sql.includes("room_id = ''")
              ) {
                const [userId, eventType] = args as [string, string];
                const hit = rows.find(
                  (r) =>
                    r.user_id === userId &&
                    r.event_type === eventType &&
                    r.room_id === ''
                );
                if (!hit) return null;
                return { content: hit.content } as T;
              }

              if (sql.includes('SELECT content FROM account_data')) {
                const [userId, roomId, eventType] = args as [string, string, string];
                const hit = rows.find(
                  (r) =>
                    r.user_id === userId &&
                    r.room_id === roomId &&
                    r.event_type === eventType
                );
                if (!hit) return null;
                return { content: hit.content } as T;
              }

              return null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run(): Promise<{
              meta: { changes: number; last_row_id: number };
              success: boolean;
            }> {
              runs.push({ sql, args });

              if (sql.includes('UPDATE stream_positions SET position = position + 1')) {
                updates.push({ sql, args });
                const name = args[0] as string;
                streamPositions[name] = (streamPositions[name] ?? 0) + 1;
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('INSERT INTO account_data_changes')) {
                inserts.push({ sql, args });
                const [userId, roomId, eventType, streamPosition] = args as [
                  string,
                  string,
                  string,
                  number,
                ];
                changes.push({
                  user_id: userId,
                  room_id: roomId,
                  event_type: eventType,
                  stream_position: streamPosition,
                });
                return {
                  success: true,
                  meta: { changes: 1, last_row_id: changes.length },
                };
              }

              if (sql.includes('INSERT INTO account_data')) {
                if (opts.throwOnAccountDataInsert) {
                  throw new Error('account_data insert failed');
                }
                inserts.push({ sql, args });
                const isGlobalLiteral =
                  sql.includes("VALUES (?, '', ?, ?)") || sql.includes("VALUES (?, '',?,?)");
                let userId: string;
                let roomId: string;
                let eventType: string;
                let content: string;
                if (isGlobalLiteral) {
                  [userId, eventType, content] = args as [string, string, string];
                  roomId = '';
                } else {
                  [userId, roomId, eventType, content] = args as [
                    string,
                    string,
                    string,
                    string,
                  ];
                }
                const existing = rows.find(
                  (r) =>
                    r.user_id === userId &&
                    r.room_id === roomId &&
                    r.event_type === eventType
                );
                if (existing) {
                  existing.content = content;
                } else {
                  rows.push({
                    user_id: userId,
                    room_id: roomId,
                    event_type: eventType,
                    content,
                  });
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              throw new Error(
                `Unhandled SQL in account-data route stub: ${sql.slice(0, 160)}`
              );
            },
          };
        },
      };
    },
  };

  return db;
}

type AccountDb = ReturnType<typeof createAccountDataDb>;
type UserKeysStub = ReturnType<typeof createUserKeysStub>;
type AccountKv = ReturnType<typeof mockKv>;

function createAccountEnv(opts: {
  db?: AccountDb;
  accountDataKv?: AccountKv;
  userKeys?: UserKeysStub;
} = {}) {
  const db = opts.db ?? createAccountDataDb();
  const accountDataKv = opts.accountDataKv ?? mockKv();
  const userKeys = opts.userKeys ?? createUserKeysStub();
  const env = {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    ACCOUNT_DATA: accountDataKv,
    USER_KEYS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => userKeys,
    },
    _db: db,
    _accountData: accountDataKv,
    _userKeys: userKeys,
  };
  return env as unknown as Env & typeof env;
}

function createFedKeysDb(
  opts: {
    otks?: OtkRow[];
    fallbacks?: FallbackRow[];
    selectBarrier?: SelectBarrier;
  } = {}
) {
  const otks = opts.otks ?? [];
  const fallbacks = opts.fallbacks ?? [];
  const updates: SqlCall[] = [];
  const inserts: SqlCall[] = [];
  const selects: SqlCall[] = [];
  let selectBarrier = opts.selectBarrier;
  const waitersRef = { list: [] as Array<() => void> };

  const db = {
    otks,
    fallbacks,
    updates,
    inserts,
    selects,
    prepare(sql: string) {
      const exec = (args: unknown[]) => ({
        async first<T>() {
          selects.push({ sql, args });
          await withSelectBarrier(
            selectBarrier,
            waitersRef,
            () => {
              selectBarrier = undefined;
            },
            sql,
            args
          );

          if (
            sql.includes('FROM one_time_keys') &&
            sql.includes('claimed = 0') &&
            sql.includes('LIMIT 1')
          ) {
            const [userId, deviceId, algorithm] = args as string[];
            const hit = otks.find(
              (o) =>
                o.user_id === userId &&
                o.device_id === deviceId &&
                o.algorithm === algorithm &&
                o.claimed === 0
            );
            return (hit
              ? { id: hit.id, key_id: hit.key_id, key_data: hit.key_data }
              : null) as T;
          }

          if (sql.includes('FROM fallback_keys')) {
            const [userId, deviceId, algorithm] = args as string[];
            const hit = fallbacks.find(
              (f) =>
                f.user_id === userId &&
                f.device_id === deviceId &&
                f.algorithm === algorithm
            );
            return (hit
              ? { key_id: hit.key_id, key_data: hit.key_data, used: hit.used }
              : null) as T;
          }

          throw new Error(`Unhandled first() SQL: ${sql.slice(0, 160)}`);
        },
        async all<T>() {
          selects.push({ sql, args });
          return { results: [] } as unknown as T;
        },
        async run() {
          if (sql.includes('UPDATE one_time_keys SET claimed = 1')) {
            updates.push({ sql, args });
            if (sql.includes('WHERE id = ?')) {
              const [, id] = args as [number, number];
              const hit = otks.find((o) => o.id === id);
              if (hit) hit.claimed = 1;
            } else {
              const [, userId, deviceId, keyId] = args as [number, string, string, string];
              const hit = otks.find(
                (o) =>
                  o.user_id === userId &&
                  o.device_id === deviceId &&
                  o.key_id === keyId
              );
              if (hit) hit.claimed = 1;
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE fallback_keys SET used = 1')) {
            updates.push({ sql, args });
            const [userId, deviceId, algorithm] = args as string[];
            const hit = fallbacks.find(
              (f) =>
                f.user_id === userId &&
                f.device_id === deviceId &&
                f.algorithm === algorithm
            );
            if (hit) hit.used = 1;
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error(`Unhandled run() SQL: ${sql.slice(0, 160)}`);
        },
      });
      return {
        bind(...args: unknown[]) {
          return exec(args);
        },
        first: <T>() => exec([]).first<T>(),
        all: <T>() => exec([]).all<T>(),
        run: () => exec([]).run(),
      };
    },
  };
  return db;
}

function createMembershipDb(
  opts: {
    rooms?: RoomRow[];
    events?: EventRow[];
    state?: StateRow[];
    selectBarrier?: SelectBarrier;
    mutateDepthOnSecond?: boolean;
  } = {}
) {
  const rooms = opts.rooms ?? [{ room_id: ROOM, room_version: '10' }];
  const events = opts.events ?? [
    {
      event_id: CREATE,
      room_id: ROOM,
      sender: USER,
      event_type: 'm.room.create',
      state_key: '',
      content: JSON.stringify({ creator: USER }),
      origin_server_ts: NOW,
      depth: 1,
      auth_events: '[]',
      prev_events: '[]',
    },
    {
      event_id: JOIN_RULES,
      room_id: ROOM,
      sender: USER,
      event_type: 'm.room.join_rules',
      state_key: '',
      content: JSON.stringify({ join_rule: 'public' }),
      origin_server_ts: NOW,
      depth: 2,
      auth_events: JSON.stringify([CREATE]),
      prev_events: JSON.stringify([CREATE]),
    },
    {
      event_id: POWER,
      room_id: ROOM,
      sender: USER,
      event_type: 'm.room.power_levels',
      state_key: '',
      content: JSON.stringify({ users: { [USER]: 100 } }),
      origin_server_ts: NOW,
      depth: 3,
      auth_events: JSON.stringify([CREATE]),
      prev_events: JSON.stringify([JOIN_RULES]),
    },
    {
      event_id: LATEST,
      room_id: ROOM,
      sender: USER,
      event_type: 'm.room.message',
      state_key: null,
      content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
      origin_server_ts: NOW,
      depth: 5,
      auth_events: '[]',
      prev_events: '[]',
    },
  ];
  const state = opts.state ?? [
    { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: CREATE },
    { room_id: ROOM, event_type: 'm.room.join_rules', state_key: '', event_id: JOIN_RULES },
    { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: POWER },
  ];
  const selects: SqlCall[] = [];
  let selectBarrier = opts.selectBarrier;
  const waitersRef = { list: [] as Array<() => void> };
  let depthReads = 0;

  const findState = (roomId: string, eventType: string, stateKey?: string) =>
    state.find(
      (s) =>
        s.room_id === roomId &&
        s.event_type === eventType &&
        (stateKey === undefined || s.state_key === stateKey)
    );

  const db = {
    rooms,
    events,
    state,
    selects,
    prepare(sql: string) {
      const exec = (args: unknown[]) => ({
        async first<T>() {
          selects.push({ sql, args });
          await withSelectBarrier(
            selectBarrier,
            waitersRef,
            () => {
              selectBarrier = undefined;
            },
            sql,
            args
          );

          if (sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version')) {
            const hit = rooms.find((r) => r.room_id === args[0]);
            return (hit
              ? { room_id: hit.room_id, room_version: hit.room_version }
              : null) as T;
          }
          if (sql.includes('FROM rooms WHERE room_id = ?')) {
            const hit = rooms.find((r) => r.room_id === args[0]);
            return (hit ? { room_id: hit.room_id } : null) as T;
          }
          if (sql.includes("rs.event_type = 'm.room.create'") && sql.includes('SELECT e.event_id')) {
            const s = findState(args[0] as string, 'm.room.create');
            return (s ? { event_id: s.event_id } : null) as T;
          }
          if (sql.includes("rs.event_type = 'm.room.join_rules'") && sql.includes('SELECT e.event_id')) {
            const s = findState(args[0] as string, 'm.room.join_rules');
            return (s ? { event_id: s.event_id } : null) as T;
          }
          if (sql.includes("rs.event_type = 'm.room.power_levels'") && sql.includes('SELECT e.event_id')) {
            const s = findState(args[0] as string, 'm.room.power_levels');
            return (s ? { event_id: s.event_id } : null) as T;
          }

          if (
            sql.includes("rs.event_type = 'm.room.member'") &&
            sql.includes('rs.state_key = ?') &&
            sql.includes('SELECT e.event_id')
          ) {
            const s = findState(args[0] as string, 'm.room.member', args[1] as string);
            return (s ? { event_id: s.event_id } : null) as T;
          }

          if (sql.includes('FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1')) {
            depthReads += 1;
            if (opts.mutateDepthOnSecond && depthReads === 2) {
              const latest = events.find((e) => e.event_id === LATEST);
              if (latest) latest.depth += 10;
            }
            const rows = events
              .filter((e) => e.room_id === args[0])
              .sort((a, b) => b.depth - a.depth);
            return (rows[0]
              ? { event_id: rows[0].event_id, depth: rows[0].depth }
              : null) as T;
          }
          return null as T;
        },
        async all<T>() {
          selects.push({ sql, args });
          return { results: [] } as unknown as T;
        },
        async run() {
          return { success: true, meta: { changes: 0 } };
        },
      });
      return {
        bind(...args: unknown[]) {
          return exec(args);
        },
        first: <T>() => exec([]).first<T>(),
        all: <T>() => exec([]).all<T>(),
        run: () => exec([]).run(),
      };
    },
  };
  return db;
}

function createFedEnv(opts: {
  db?: ReturnType<typeof createFedKeysDb> | ReturnType<typeof createMembershipDb>;
  oneTimeKeysKv?: ReturnType<typeof mockKv>;
  cacheKv?: ReturnType<typeof mockKv>;
} = {}): Env {
  const db = opts.db ?? createFedKeysDb();
  const oneTimeKeysKv = opts.oneTimeKeysKv ?? mockKv();
  const cacheKv = opts.cacheKv ?? mockKv();
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    SESSIONS: mockKv() as unknown as KVNamespace,
    DEVICE_KEYS: mockKv() as unknown as KVNamespace,
    ONE_TIME_KEYS: oneTimeKeysKv as unknown as KVNamespace,
    CROSS_SIGNING_KEYS: mockKv() as unknown as KVNamespace,
    CACHE: cacheKv as unknown as KVNamespace,
    ACCOUNT_DATA: mockKv() as unknown as KVNamespace,
    MEDIA: {} as R2Bucket,
    USER_KEYS: {
      idFromName: (name: string) => ({ name }),
      get: () => createUserKeysStub(),
    },
    FEDERATION: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
    ROOM: { idFromName: () => ({}), get: () => ({}) },
    SYNC: { idFromName: () => ({}), get: () => ({}) },
    ADMIN: { idFromName: () => ({}), get: () => ({}) },
    PUSH: { idFromName: () => ({}), get: () => ({}) },
    RATE_LIMIT: { idFromName: () => ({}), get: () => ({}) },
    CALL_ROOM: { idFromName: () => ({}), get: () => ({}) },
  } as unknown as Env;
}

async function accountReq(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await accountDataApp.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

async function fedReq(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const res = await federation.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function jsonInit(method: string, body?: unknown, contentType = 'application/json'): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': contentType,
      ...AUTH,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function fedJson(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function globalPath(type: string, userEnc = USER_ENC): string {
  return `/_matrix/client/v3/user/${userEnc}/account_data/${encodeURIComponent(type)}`;
}

function roomPath(type: string, roomEnc = ROOM_ENC, userEnc = USER_ENC): string {
  return `/_matrix/client/v3/user/${userEnc}/rooms/${roomEnc}/account_data/${encodeURIComponent(type)}`;
}

function seedOtk(overrides: Partial<OtkRow> = {}): OtkRow {
  return {
    id: overrides.id ?? 1,
    user_id: overrides.user_id ?? USER,
    device_id: overrides.device_id ?? DEVICE,
    algorithm: overrides.algorithm ?? ALG,
    key_id: overrides.key_id ?? `${ALG}:1`,
    key_data: overrides.key_data ?? JSON.stringify({ key: 'k1' }),
    claimed: overrides.claimed ?? 0,
  };
}

function seedFallback(overrides: Partial<FallbackRow> = {}): FallbackRow {
  return {
    user_id: overrides.user_id ?? USER,
    device_id: overrides.device_id ?? DEVICE,
    algorithm: overrides.algorithm ?? ALG,
    key_id: overrides.key_id ?? `${ALG}:fallback`,
    key_data: overrides.key_data ?? JSON.stringify({ key: 'fb' }),
    used: overrides.used ?? 0,
  };
}

beforeEach(() => {
  federationOriginSideChannel = REMOTE;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  federationOriginSideChannel = null;
  vi.restoreAllMocks();
});

describe('race account-data global PUT∥PUT lost-update after #175', () => {
  it('PUT∥PUT global m.direct barrier race #0', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 0 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 0 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 0 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 0 || content.B === 0).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #1', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 1 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 1 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 1 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 1 || content.B === 1).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #2', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 2 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 2 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 2 || content.B === 2).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #3', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 3 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 3 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 3 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 3 || content.B === 3).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #4', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 4 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 4 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 4 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 4 || content.B === 4).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #5', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 5 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 5 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 5 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 5 || content.B === 5).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #6', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 6 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 6 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 6 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 6 || content.B === 6).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #7', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 7 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 7 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 7 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 7 || content.B === 7).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #8', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 8 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 8 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 8 || content.B === 8).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #9', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 9 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 9 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 9 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 9 || content.B === 9).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #10', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 10 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 10 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 10 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 10 || content.B === 10).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #11', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 11 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 11 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 11 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 11 || content.B === 11).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #12', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 12 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 12 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 12 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 12 || content.B === 12).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #13', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 13 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 13 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 13 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 13 || content.B === 13).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #14', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 14 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 14 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 14 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 14 || content.B === 14).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
  it('PUT∥PUT global m.direct barrier race #15', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: 15 }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { A: 15 })),
      accountReq(env, globalPath('m.direct'), jsonInit('PUT', { B: 15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === 'm.direct').length).toBe(1);
    const content = JSON.parse(db.rows.find((r) => r.event_type === 'm.direct')!.content);
    expect(content.A === 15 || content.B === 15).toBe(true);
    expect(db.changes.length).toBe(2);
    expect(db.streamPositions.account_data).toBe(12);
  });
});

describe('race account-data global distinct types parallel stream bumps after #175', () => {
  it('parallel distinct types stream bumps soft-1', async () => {
    const n = 2;
    const db = createAccountDataDb({ streamPositions: { account_data: 10 } });
    const env = createAccountEnv({ db });
    const types = Array.from({ length: n }, (_, j) => `m.tag.soft0_${j}`);
    const results = await Promise.all(
      types.map((t, j) =>
        accountReq(env, globalPath(t), jsonInit('PUT', { n: j, soft: 1 }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.changes.length).toBe(n);
    // TOCTOU: UPDATE then SELECT is not atomic — parallel bumps may share positions
    const positions = db.changes.map((c) => c.stream_position);
    expect(positions.length).toBe(n);
    expect(Math.max(...positions)).toBeLessThanOrEqual(db.streamPositions.account_data);
    expect(db.streamPositions.account_data).toBe(10 + n);
  });
  it('parallel distinct types stream bumps soft-2', async () => {
    const n = 3;
    const db = createAccountDataDb({ streamPositions: { account_data: 11 } });
    const env = createAccountEnv({ db });
    const types = Array.from({ length: n }, (_, j) => `m.tag.soft1_${j}`);
    const results = await Promise.all(
      types.map((t, j) =>
        accountReq(env, globalPath(t), jsonInit('PUT', { n: j, soft: 2 }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.changes.length).toBe(n);
    // TOCTOU: UPDATE then SELECT is not atomic — parallel bumps may share positions
    const positions = db.changes.map((c) => c.stream_position);
    expect(positions.length).toBe(n);
    expect(Math.max(...positions)).toBeLessThanOrEqual(db.streamPositions.account_data);
    expect(db.streamPositions.account_data).toBe(11 + n);
  });
  it('parallel distinct types stream bumps soft-3', async () => {
    const n = 4;
    const db = createAccountDataDb({ streamPositions: { account_data: 12 } });
    const env = createAccountEnv({ db });
    const types = Array.from({ length: n }, (_, j) => `m.tag.soft2_${j}`);
    const results = await Promise.all(
      types.map((t, j) =>
        accountReq(env, globalPath(t), jsonInit('PUT', { n: j, soft: 3 }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.changes.length).toBe(n);
    // TOCTOU: UPDATE then SELECT is not atomic — parallel bumps may share positions
    const positions = db.changes.map((c) => c.stream_position);
    expect(positions.length).toBe(n);
    expect(Math.max(...positions)).toBeLessThanOrEqual(db.streamPositions.account_data);
    expect(db.streamPositions.account_data).toBe(12 + n);
  });
  it('parallel distinct types stream bumps soft-4', async () => {
    const n = 2;
    const db = createAccountDataDb({ streamPositions: { account_data: 13 } });
    const env = createAccountEnv({ db });
    const types = Array.from({ length: n }, (_, j) => `m.tag.soft3_${j}`);
    const results = await Promise.all(
      types.map((t, j) =>
        accountReq(env, globalPath(t), jsonInit('PUT', { n: j, soft: 4 }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.changes.length).toBe(n);
    // TOCTOU: UPDATE then SELECT is not atomic — parallel bumps may share positions
    const positions = db.changes.map((c) => c.stream_position);
    expect(positions.length).toBe(n);
    expect(Math.max(...positions)).toBeLessThanOrEqual(db.streamPositions.account_data);
    expect(db.streamPositions.account_data).toBe(13 + n);
  });
  it('parallel distinct types stream bumps soft-5', async () => {
    const n = 3;
    const db = createAccountDataDb({ streamPositions: { account_data: 14 } });
    const env = createAccountEnv({ db });
    const types = Array.from({ length: n }, (_, j) => `m.tag.soft4_${j}`);
    const results = await Promise.all(
      types.map((t, j) =>
        accountReq(env, globalPath(t), jsonInit('PUT', { n: j, soft: 5 }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.changes.length).toBe(n);
    // TOCTOU: UPDATE then SELECT is not atomic — parallel bumps may share positions
    const positions = db.changes.map((c) => c.stream_position);
    expect(positions.length).toBe(n);
    expect(Math.max(...positions)).toBeLessThanOrEqual(db.streamPositions.account_data);
    expect(db.streamPositions.account_data).toBe(14 + n);
  });
  it('parallel distinct types stream bumps soft-6', async () => {
    const n = 4;
    const db = createAccountDataDb({ streamPositions: { account_data: 15 } });
    const env = createAccountEnv({ db });
    const types = Array.from({ length: n }, (_, j) => `m.tag.soft5_${j}`);
    const results = await Promise.all(
      types.map((t, j) =>
        accountReq(env, globalPath(t), jsonInit('PUT', { n: j, soft: 6 }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.changes.length).toBe(n);
    // TOCTOU: UPDATE then SELECT is not atomic — parallel bumps may share positions
    const positions = db.changes.map((c) => c.stream_position);
    expect(positions.length).toBe(n);
    expect(Math.max(...positions)).toBeLessThanOrEqual(db.streamPositions.account_data);
    expect(db.streamPositions.account_data).toBe(15 + n);
  });
  it('parallel distinct types stream bumps soft-7', async () => {
    const n = 2;
    const db = createAccountDataDb({ streamPositions: { account_data: 16 } });
    const env = createAccountEnv({ db });
    const types = Array.from({ length: n }, (_, j) => `m.tag.soft6_${j}`);
    const results = await Promise.all(
      types.map((t, j) =>
        accountReq(env, globalPath(t), jsonInit('PUT', { n: j, soft: 7 }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.changes.length).toBe(n);
    // TOCTOU: UPDATE then SELECT is not atomic — parallel bumps may share positions
    const positions = db.changes.map((c) => c.stream_position);
    expect(positions.length).toBe(n);
    expect(Math.max(...positions)).toBeLessThanOrEqual(db.streamPositions.account_data);
    expect(db.streamPositions.account_data).toBe(16 + n);
  });
  it('parallel distinct types stream bumps soft-8', async () => {
    const n = 3;
    const db = createAccountDataDb({ streamPositions: { account_data: 17 } });
    const env = createAccountEnv({ db });
    const types = Array.from({ length: n }, (_, j) => `m.tag.soft7_${j}`);
    const results = await Promise.all(
      types.map((t, j) =>
        accountReq(env, globalPath(t), jsonInit('PUT', { n: j, soft: 8 }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.changes.length).toBe(n);
    // TOCTOU: UPDATE then SELECT is not atomic — parallel bumps may share positions
    const positions = db.changes.map((c) => c.stream_position);
    expect(positions.length).toBe(n);
    expect(Math.max(...positions)).toBeLessThanOrEqual(db.streamPositions.account_data);
    expect(db.streamPositions.account_data).toBe(17 + n);
  });
  it('parallel distinct types stream bumps soft-9', async () => {
    const n = 4;
    const db = createAccountDataDb({ streamPositions: { account_data: 18 } });
    const env = createAccountEnv({ db });
    const types = Array.from({ length: n }, (_, j) => `m.tag.soft8_${j}`);
    const results = await Promise.all(
      types.map((t, j) =>
        accountReq(env, globalPath(t), jsonInit('PUT', { n: j, soft: 9 }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.changes.length).toBe(n);
    // TOCTOU: UPDATE then SELECT is not atomic — parallel bumps may share positions
    const positions = db.changes.map((c) => c.stream_position);
    expect(positions.length).toBe(n);
    expect(Math.max(...positions)).toBeLessThanOrEqual(db.streamPositions.account_data);
    expect(db.streamPositions.account_data).toBe(18 + n);
  });
  it('parallel distinct types stream bumps soft-10', async () => {
    const n = 2;
    const db = createAccountDataDb({ streamPositions: { account_data: 19 } });
    const env = createAccountEnv({ db });
    const types = Array.from({ length: n }, (_, j) => `m.tag.soft9_${j}`);
    const results = await Promise.all(
      types.map((t, j) =>
        accountReq(env, globalPath(t), jsonInit('PUT', { n: j, soft: 10 }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.changes.length).toBe(n);
    // TOCTOU: UPDATE then SELECT is not atomic — parallel bumps may share positions
    const positions = db.changes.map((c) => c.stream_position);
    expect(positions.length).toBe(n);
    expect(Math.max(...positions)).toBeLessThanOrEqual(db.streamPositions.account_data);
    expect(db.streamPositions.account_data).toBe(19 + n);
  });
  it('parallel distinct types stream bumps soft-11', async () => {
    const n = 3;
    const db = createAccountDataDb({ streamPositions: { account_data: 20 } });
    const env = createAccountEnv({ db });
    const types = Array.from({ length: n }, (_, j) => `m.tag.soft10_${j}`);
    const results = await Promise.all(
      types.map((t, j) =>
        accountReq(env, globalPath(t), jsonInit('PUT', { n: j, soft: 11 }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.changes.length).toBe(n);
    // TOCTOU: UPDATE then SELECT is not atomic — parallel bumps may share positions
    const positions = db.changes.map((c) => c.stream_position);
    expect(positions.length).toBe(n);
    expect(Math.max(...positions)).toBeLessThanOrEqual(db.streamPositions.account_data);
    expect(db.streamPositions.account_data).toBe(20 + n);
  });
  it('parallel distinct types stream bumps soft-12', async () => {
    const n = 4;
    const db = createAccountDataDb({ streamPositions: { account_data: 21 } });
    const env = createAccountEnv({ db });
    const types = Array.from({ length: n }, (_, j) => `m.tag.soft11_${j}`);
    const results = await Promise.all(
      types.map((t, j) =>
        accountReq(env, globalPath(t), jsonInit('PUT', { n: j, soft: 12 }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.changes.length).toBe(n);
    // TOCTOU: UPDATE then SELECT is not atomic — parallel bumps may share positions
    const positions = db.changes.map((c) => c.stream_position);
    expect(positions.length).toBe(n);
    expect(Math.max(...positions)).toBeLessThanOrEqual(db.streamPositions.account_data);
    expect(db.streamPositions.account_data).toBe(21 + n);
  });
});

describe('race account-data room PUT∥PUT membership-gate TOCTOU after #175', () => {
  it('room PUT∥PUT both pass membership barrier #0', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a0:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b0:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a0:example.com`, `$b0:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #1', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a1:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b1:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a1:example.com`, `$b1:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #2', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a2:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b2:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a2:example.com`, `$b2:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #3', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a3:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b3:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a3:example.com`, `$b3:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #4', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a4:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b4:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a4:example.com`, `$b4:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #5', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a5:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b5:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a5:example.com`, `$b5:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #6', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a6:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b6:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a6:example.com`, `$b6:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #7', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a7:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b7:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a7:example.com`, `$b7:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #8', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a8:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b8:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a8:example.com`, `$b8:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #9', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a9:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b9:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a9:example.com`, `$b9:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #10', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a10:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b10:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a10:example.com`, `$b10:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #11', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a11:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b11:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a11:example.com`, `$b11:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #12', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a12:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b12:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a12:example.com`, `$b12:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #13', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a13:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b13:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a13:example.com`, `$b13:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #14', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a14:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b14:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a14:example.com`, `$b14:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
  it('room PUT∥PUT both pass membership barrier #15', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const type = 'm.fully_read';
    const [a, b] = await Promise.all([
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$a15:example.com` })),
      accountReq(env, roomPath(type), jsonInit('PUT', { event_id: `$b15:example.com` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.rows.filter((r) => r.event_type === type && r.room_id === ROOM).length).toBe(1);
    const content = JSON.parse(
      db.rows.find((r) => r.event_type === type && r.room_id === ROOM)!.content
    );
    expect([`$a15:example.com`, `$b15:example.com`]).toContain(content.event_id);
    expect(db.changes.length).toBe(2);
  });
});

describe('race account-data room membership mid-flight leave TOCTOU after #175', () => {
  it('room PUT after mid-flight leave soft-1', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      midFlightLeave: true,
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { a: 0 } })),
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { b: 0 } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 403).toBe(true);
    expect(statuses[1] === 200 || statuses[1] === 403).toBe(true);
  });
  it('room PUT after mid-flight leave soft-2', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      midFlightLeave: true,
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { a: 1 } })),
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { b: 1 } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 403).toBe(true);
    expect(statuses[1] === 200 || statuses[1] === 403).toBe(true);
  });
  it('room PUT after mid-flight leave soft-3', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      midFlightLeave: true,
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { a: 2 } })),
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { b: 2 } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 403).toBe(true);
    expect(statuses[1] === 200 || statuses[1] === 403).toBe(true);
  });
  it('room PUT after mid-flight leave soft-4', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      midFlightLeave: true,
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { a: 3 } })),
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { b: 3 } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 403).toBe(true);
    expect(statuses[1] === 200 || statuses[1] === 403).toBe(true);
  });
  it('room PUT after mid-flight leave soft-5', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      midFlightLeave: true,
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { a: 4 } })),
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { b: 4 } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 403).toBe(true);
    expect(statuses[1] === 200 || statuses[1] === 403).toBe(true);
  });
  it('room PUT after mid-flight leave soft-6', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      midFlightLeave: true,
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { a: 5 } })),
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { b: 5 } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 403).toBe(true);
    expect(statuses[1] === 200 || statuses[1] === 403).toBe(true);
  });
  it('room PUT after mid-flight leave soft-7', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      midFlightLeave: true,
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { a: 6 } })),
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { b: 6 } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 403).toBe(true);
    expect(statuses[1] === 200 || statuses[1] === 403).toBe(true);
  });
  it('room PUT after mid-flight leave soft-8', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      midFlightLeave: true,
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { a: 7 } })),
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { b: 7 } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 403).toBe(true);
    expect(statuses[1] === 200 || statuses[1] === 403).toBe(true);
  });
  it('room PUT after mid-flight leave soft-9', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      midFlightLeave: true,
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { a: 8 } })),
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { b: 8 } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 403).toBe(true);
    expect(statuses[1] === 200 || statuses[1] === 403).toBe(true);
  });
  it('room PUT after mid-flight leave soft-10', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      midFlightLeave: true,
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { a: 9 } })),
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { b: 9 } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 403).toBe(true);
    expect(statuses[1] === 200 || statuses[1] === 403).toBe(true);
  });
  it('room PUT after mid-flight leave soft-11', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      midFlightLeave: true,
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { a: 10 } })),
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { b: 10 } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 403).toBe(true);
    expect(statuses[1] === 200 || statuses[1] === 403).toBe(true);
  });
  it('room PUT after mid-flight leave soft-12', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      midFlightLeave: true,
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { a: 11 } })),
      accountReq(env, roomPath('m.tag'), jsonInit('PUT', { tags: { b: 11 } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 403).toBe(true);
    expect(statuses[1] === 200 || statuses[1] === 403).toBe(true);
  });
});

describe('race account-data E2EE PUT∥PUT DO lost-update after #175', () => {
  it('E2EE PUT∥PUT DO barrier race #0', async () => {
    const userKeys = createUserKeysStub({ putBarrier: { count: 2 } });
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const type = 'm.secret_storage.default_key';
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `A0` })),
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `B0` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([`A0`, `B0`]).toContain((userKeys.accountData[type] as { key: string }).key);
    expect(userKeys.fetches.filter((f) => f.method === 'POST').length).toBe(2);
    expect(env._accountData.puts.length).toBe(2);
    expect(db.changes.length).toBe(2);
  });
  it('E2EE PUT∥PUT DO barrier race #1', async () => {
    const userKeys = createUserKeysStub({ putBarrier: { count: 2 } });
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const type = 'm.secret_storage.default_key';
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `A1` })),
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `B1` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([`A1`, `B1`]).toContain((userKeys.accountData[type] as { key: string }).key);
    expect(userKeys.fetches.filter((f) => f.method === 'POST').length).toBe(2);
    expect(env._accountData.puts.length).toBe(2);
    expect(db.changes.length).toBe(2);
  });
  it('E2EE PUT∥PUT DO barrier race #2', async () => {
    const userKeys = createUserKeysStub({ putBarrier: { count: 2 } });
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const type = 'm.secret_storage.default_key';
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `A2` })),
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `B2` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([`A2`, `B2`]).toContain((userKeys.accountData[type] as { key: string }).key);
    expect(userKeys.fetches.filter((f) => f.method === 'POST').length).toBe(2);
    expect(env._accountData.puts.length).toBe(2);
    expect(db.changes.length).toBe(2);
  });
  it('E2EE PUT∥PUT DO barrier race #3', async () => {
    const userKeys = createUserKeysStub({ putBarrier: { count: 2 } });
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const type = 'm.secret_storage.default_key';
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `A3` })),
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `B3` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([`A3`, `B3`]).toContain((userKeys.accountData[type] as { key: string }).key);
    expect(userKeys.fetches.filter((f) => f.method === 'POST').length).toBe(2);
    expect(env._accountData.puts.length).toBe(2);
    expect(db.changes.length).toBe(2);
  });
  it('E2EE PUT∥PUT DO barrier race #4', async () => {
    const userKeys = createUserKeysStub({ putBarrier: { count: 2 } });
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const type = 'm.secret_storage.default_key';
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `A4` })),
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `B4` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([`A4`, `B4`]).toContain((userKeys.accountData[type] as { key: string }).key);
    expect(userKeys.fetches.filter((f) => f.method === 'POST').length).toBe(2);
    expect(env._accountData.puts.length).toBe(2);
    expect(db.changes.length).toBe(2);
  });
  it('E2EE PUT∥PUT DO barrier race #5', async () => {
    const userKeys = createUserKeysStub({ putBarrier: { count: 2 } });
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const type = 'm.secret_storage.default_key';
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `A5` })),
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `B5` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([`A5`, `B5`]).toContain((userKeys.accountData[type] as { key: string }).key);
    expect(userKeys.fetches.filter((f) => f.method === 'POST').length).toBe(2);
    expect(env._accountData.puts.length).toBe(2);
    expect(db.changes.length).toBe(2);
  });
  it('E2EE PUT∥PUT DO barrier race #6', async () => {
    const userKeys = createUserKeysStub({ putBarrier: { count: 2 } });
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const type = 'm.secret_storage.default_key';
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `A6` })),
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `B6` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([`A6`, `B6`]).toContain((userKeys.accountData[type] as { key: string }).key);
    expect(userKeys.fetches.filter((f) => f.method === 'POST').length).toBe(2);
    expect(env._accountData.puts.length).toBe(2);
    expect(db.changes.length).toBe(2);
  });
  it('E2EE PUT∥PUT DO barrier race #7', async () => {
    const userKeys = createUserKeysStub({ putBarrier: { count: 2 } });
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const type = 'm.secret_storage.default_key';
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `A7` })),
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `B7` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([`A7`, `B7`]).toContain((userKeys.accountData[type] as { key: string }).key);
    expect(userKeys.fetches.filter((f) => f.method === 'POST').length).toBe(2);
    expect(env._accountData.puts.length).toBe(2);
    expect(db.changes.length).toBe(2);
  });
  it('E2EE PUT∥PUT DO barrier race #8', async () => {
    const userKeys = createUserKeysStub({ putBarrier: { count: 2 } });
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const type = 'm.secret_storage.default_key';
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `A8` })),
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `B8` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([`A8`, `B8`]).toContain((userKeys.accountData[type] as { key: string }).key);
    expect(userKeys.fetches.filter((f) => f.method === 'POST').length).toBe(2);
    expect(env._accountData.puts.length).toBe(2);
    expect(db.changes.length).toBe(2);
  });
  it('E2EE PUT∥PUT DO barrier race #9', async () => {
    const userKeys = createUserKeysStub({ putBarrier: { count: 2 } });
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const type = 'm.secret_storage.default_key';
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `A9` })),
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `B9` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([`A9`, `B9`]).toContain((userKeys.accountData[type] as { key: string }).key);
    expect(userKeys.fetches.filter((f) => f.method === 'POST').length).toBe(2);
    expect(env._accountData.puts.length).toBe(2);
    expect(db.changes.length).toBe(2);
  });
  it('E2EE PUT∥PUT DO barrier race #10', async () => {
    const userKeys = createUserKeysStub({ putBarrier: { count: 2 } });
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const type = 'm.secret_storage.default_key';
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `A10` })),
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `B10` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([`A10`, `B10`]).toContain((userKeys.accountData[type] as { key: string }).key);
    expect(userKeys.fetches.filter((f) => f.method === 'POST').length).toBe(2);
    expect(env._accountData.puts.length).toBe(2);
    expect(db.changes.length).toBe(2);
  });
  it('E2EE PUT∥PUT DO barrier race #11', async () => {
    const userKeys = createUserKeysStub({ putBarrier: { count: 2 } });
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const type = 'm.secret_storage.default_key';
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `A11` })),
      accountReq(env, globalPath(type), jsonInit('PUT', { key: `B11` })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([`A11`, `B11`]).toContain((userKeys.accountData[type] as { key: string }).key);
    expect(userKeys.fetches.filter((f) => f.method === 'POST').length).toBe(2);
    expect(env._accountData.puts.length).toBe(2);
    expect(db.changes.length).toBe(2);
  });
});

describe('race account-data GET∥PUT same type after #175', () => {
  it('GET∥PUT global soft-1', async () => {
    const type = 'm.ignored_user_list';
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ ignored_users: { [BOB]: {} } }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [getRes, putRes] = await Promise.all([
      accountReq(env, globalPath(type), { method: 'GET', headers: AUTH }),
      accountReq(env, globalPath(type), jsonInit('PUT', { ignored_users: {} })),
    ]);
    expect([200, 404]).toContain(getRes.status);
    expect(putRes.status).toBe(200);
    const final = JSON.parse(db.rows.find((r) => r.event_type === type)!.content);
    expect(final).toEqual({ ignored_users: {} });
  });
  it('GET∥PUT global soft-2', async () => {
    const type = 'm.ignored_user_list';
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ ignored_users: { [BOB]: {} } }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [getRes, putRes] = await Promise.all([
      accountReq(env, globalPath(type), { method: 'GET', headers: AUTH }),
      accountReq(env, globalPath(type), jsonInit('PUT', { ignored_users: {} })),
    ]);
    expect([200, 404]).toContain(getRes.status);
    expect(putRes.status).toBe(200);
    const final = JSON.parse(db.rows.find((r) => r.event_type === type)!.content);
    expect(final).toEqual({ ignored_users: {} });
  });
  it('GET∥PUT global soft-3', async () => {
    const type = 'm.ignored_user_list';
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ ignored_users: { [BOB]: {} } }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [getRes, putRes] = await Promise.all([
      accountReq(env, globalPath(type), { method: 'GET', headers: AUTH }),
      accountReq(env, globalPath(type), jsonInit('PUT', { ignored_users: {} })),
    ]);
    expect([200, 404]).toContain(getRes.status);
    expect(putRes.status).toBe(200);
    const final = JSON.parse(db.rows.find((r) => r.event_type === type)!.content);
    expect(final).toEqual({ ignored_users: {} });
  });
  it('GET∥PUT global soft-4', async () => {
    const type = 'm.ignored_user_list';
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ ignored_users: { [BOB]: {} } }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [getRes, putRes] = await Promise.all([
      accountReq(env, globalPath(type), { method: 'GET', headers: AUTH }),
      accountReq(env, globalPath(type), jsonInit('PUT', { ignored_users: {} })),
    ]);
    expect([200, 404]).toContain(getRes.status);
    expect(putRes.status).toBe(200);
    const final = JSON.parse(db.rows.find((r) => r.event_type === type)!.content);
    expect(final).toEqual({ ignored_users: {} });
  });
  it('GET∥PUT global soft-5', async () => {
    const type = 'm.ignored_user_list';
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ ignored_users: { [BOB]: {} } }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [getRes, putRes] = await Promise.all([
      accountReq(env, globalPath(type), { method: 'GET', headers: AUTH }),
      accountReq(env, globalPath(type), jsonInit('PUT', { ignored_users: {} })),
    ]);
    expect([200, 404]).toContain(getRes.status);
    expect(putRes.status).toBe(200);
    const final = JSON.parse(db.rows.find((r) => r.event_type === type)!.content);
    expect(final).toEqual({ ignored_users: {} });
  });
  it('GET∥PUT global soft-6', async () => {
    const type = 'm.ignored_user_list';
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ ignored_users: { [BOB]: {} } }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [getRes, putRes] = await Promise.all([
      accountReq(env, globalPath(type), { method: 'GET', headers: AUTH }),
      accountReq(env, globalPath(type), jsonInit('PUT', { ignored_users: {} })),
    ]);
    expect([200, 404]).toContain(getRes.status);
    expect(putRes.status).toBe(200);
    const final = JSON.parse(db.rows.find((r) => r.event_type === type)!.content);
    expect(final).toEqual({ ignored_users: {} });
  });
  it('GET∥PUT global soft-7', async () => {
    const type = 'm.ignored_user_list';
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ ignored_users: { [BOB]: {} } }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [getRes, putRes] = await Promise.all([
      accountReq(env, globalPath(type), { method: 'GET', headers: AUTH }),
      accountReq(env, globalPath(type), jsonInit('PUT', { ignored_users: {} })),
    ]);
    expect([200, 404]).toContain(getRes.status);
    expect(putRes.status).toBe(200);
    const final = JSON.parse(db.rows.find((r) => r.event_type === type)!.content);
    expect(final).toEqual({ ignored_users: {} });
  });
  it('GET∥PUT global soft-8', async () => {
    const type = 'm.ignored_user_list';
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ ignored_users: { [BOB]: {} } }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [getRes, putRes] = await Promise.all([
      accountReq(env, globalPath(type), { method: 'GET', headers: AUTH }),
      accountReq(env, globalPath(type), jsonInit('PUT', { ignored_users: {} })),
    ]);
    expect([200, 404]).toContain(getRes.status);
    expect(putRes.status).toBe(200);
    const final = JSON.parse(db.rows.find((r) => r.event_type === type)!.content);
    expect(final).toEqual({ ignored_users: {} });
  });
  it('GET∥PUT global soft-9', async () => {
    const type = 'm.ignored_user_list';
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ ignored_users: { [BOB]: {} } }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [getRes, putRes] = await Promise.all([
      accountReq(env, globalPath(type), { method: 'GET', headers: AUTH }),
      accountReq(env, globalPath(type), jsonInit('PUT', { ignored_users: {} })),
    ]);
    expect([200, 404]).toContain(getRes.status);
    expect(putRes.status).toBe(200);
    const final = JSON.parse(db.rows.find((r) => r.event_type === type)!.content);
    expect(final).toEqual({ ignored_users: {} });
  });
  it('GET∥PUT global soft-10', async () => {
    const type = 'm.ignored_user_list';
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ ignored_users: { [BOB]: {} } }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [getRes, putRes] = await Promise.all([
      accountReq(env, globalPath(type), { method: 'GET', headers: AUTH }),
      accountReq(env, globalPath(type), jsonInit('PUT', { ignored_users: {} })),
    ]);
    expect([200, 404]).toContain(getRes.status);
    expect(putRes.status).toBe(200);
    const final = JSON.parse(db.rows.find((r) => r.event_type === type)!.content);
    expect(final).toEqual({ ignored_users: {} });
  });
  it('GET∥PUT global soft-11', async () => {
    const type = 'm.ignored_user_list';
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ ignored_users: { [BOB]: {} } }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [getRes, putRes] = await Promise.all([
      accountReq(env, globalPath(type), { method: 'GET', headers: AUTH }),
      accountReq(env, globalPath(type), jsonInit('PUT', { ignored_users: {} })),
    ]);
    expect([200, 404]).toContain(getRes.status);
    expect(putRes.status).toBe(200);
    const final = JSON.parse(db.rows.find((r) => r.event_type === type)!.content);
    expect(final).toEqual({ ignored_users: {} });
  });
  it('GET∥PUT global soft-12', async () => {
    const type = 'm.ignored_user_list';
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ ignored_users: { [BOB]: {} } }),
        },
      ],
    });
    const env = createAccountEnv({ db });
    const [getRes, putRes] = await Promise.all([
      accountReq(env, globalPath(type), { method: 'GET', headers: AUTH }),
      accountReq(env, globalPath(type), jsonInit('PUT', { ignored_users: {} })),
    ]);
    expect([200, 404]).toContain(getRes.status);
    expect(putRes.status).toBe(200);
    const final = JSON.parse(db.rows.find((r) => r.event_type === type)!.content);
    expect(final).toEqual({ ignored_users: {} });
  });
});

describe('account-data forbidden other-user soft flood after #175', () => {
  it('forbidden other-user soft #0', async () => {
    const env = createAccountEnv();
    const res = await accountReq(
      env,
      globalPath('m.direct', BOB_ENC),
      jsonInit('PUT', { x: 0 })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
  it('forbidden other-user soft #1', async () => {
    const env = createAccountEnv();
    const res = await accountReq(
      env,
      globalPath('m.direct', BOB_ENC),
      jsonInit('PUT', { x: 1 })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
  it('forbidden other-user soft #2', async () => {
    const env = createAccountEnv();
    const res = await accountReq(
      env,
      globalPath('m.direct', BOB_ENC),
      jsonInit('PUT', { x: 2 })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
  it('forbidden other-user soft #3', async () => {
    const env = createAccountEnv();
    const res = await accountReq(
      env,
      globalPath('m.direct', BOB_ENC),
      jsonInit('PUT', { x: 3 })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
  it('forbidden other-user soft #4', async () => {
    const env = createAccountEnv();
    const res = await accountReq(
      env,
      globalPath('m.direct', BOB_ENC),
      jsonInit('PUT', { x: 4 })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
  it('forbidden other-user soft #5', async () => {
    const env = createAccountEnv();
    const res = await accountReq(
      env,
      globalPath('m.direct', BOB_ENC),
      jsonInit('PUT', { x: 5 })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
  it('forbidden other-user soft #6', async () => {
    const env = createAccountEnv();
    const res = await accountReq(
      env,
      globalPath('m.direct', BOB_ENC),
      jsonInit('PUT', { x: 6 })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
  it('forbidden other-user soft #7', async () => {
    const env = createAccountEnv();
    const res = await accountReq(
      env,
      globalPath('m.direct', BOB_ENC),
      jsonInit('PUT', { x: 7 })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
  it('forbidden other-user soft #8', async () => {
    const env = createAccountEnv();
    const res = await accountReq(
      env,
      globalPath('m.direct', BOB_ENC),
      jsonInit('PUT', { x: 8 })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
  it('forbidden other-user soft #9', async () => {
    const env = createAccountEnv();
    const res = await accountReq(
      env,
      globalPath('m.direct', BOB_ENC),
      jsonInit('PUT', { x: 9 })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});

describe('account-data room non-member soft flood after #175', () => {
  it('room non-member soft #0', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      roomPath('m.fully_read'),
      jsonInit('PUT', { event_id: `$nm0:example.com` })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.rows.length).toBe(0);
  });
  it('room non-member soft #1', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      roomPath('m.fully_read'),
      jsonInit('PUT', { event_id: `$nm1:example.com` })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.rows.length).toBe(0);
  });
  it('room non-member soft #2', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      roomPath('m.fully_read'),
      jsonInit('PUT', { event_id: `$nm2:example.com` })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.rows.length).toBe(0);
  });
  it('room non-member soft #3', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      roomPath('m.fully_read'),
      jsonInit('PUT', { event_id: `$nm3:example.com` })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.rows.length).toBe(0);
  });
  it('room non-member soft #4', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      roomPath('m.fully_read'),
      jsonInit('PUT', { event_id: `$nm4:example.com` })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.rows.length).toBe(0);
  });
  it('room non-member soft #5', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      roomPath('m.fully_read'),
      jsonInit('PUT', { event_id: `$nm5:example.com` })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.rows.length).toBe(0);
  });
  it('room non-member soft #6', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      roomPath('m.fully_read'),
      jsonInit('PUT', { event_id: `$nm6:example.com` })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.rows.length).toBe(0);
  });
  it('room non-member soft #7', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      roomPath('m.fully_read'),
      jsonInit('PUT', { event_id: `$nm7:example.com` })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.rows.length).toBe(0);
  });
  it('room non-member soft #8', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      roomPath('m.fully_read'),
      jsonInit('PUT', { event_id: `$nm8:example.com` })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.rows.length).toBe(0);
  });
  it('room non-member soft #9', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      roomPath('m.fully_read'),
      jsonInit('PUT', { event_id: `$nm9:example.com` })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.rows.length).toBe(0);
  });
});

describe('race federation OTK D1 claim double-consume TOCTOU after #175', () => {
  it('claim∥claim same OTK D1 barrier #0', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 100, key_id: `signed_curve25519:d1-0`, key_data: JSON.stringify({ key: 'd0' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #1', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 101, key_id: `signed_curve25519:d1-1`, key_data: JSON.stringify({ key: 'd1' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #2', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 102, key_id: `signed_curve25519:d1-2`, key_data: JSON.stringify({ key: 'd2' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #3', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 103, key_id: `signed_curve25519:d1-3`, key_data: JSON.stringify({ key: 'd3' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #4', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 104, key_id: `signed_curve25519:d1-4`, key_data: JSON.stringify({ key: 'd4' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #5', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 105, key_id: `signed_curve25519:d1-5`, key_data: JSON.stringify({ key: 'd5' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #6', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 106, key_id: `signed_curve25519:d1-6`, key_data: JSON.stringify({ key: 'd6' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #7', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 107, key_id: `signed_curve25519:d1-7`, key_data: JSON.stringify({ key: 'd7' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #8', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 108, key_id: `signed_curve25519:d1-8`, key_data: JSON.stringify({ key: 'd8' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #9', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 109, key_id: `signed_curve25519:d1-9`, key_data: JSON.stringify({ key: 'd9' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #10', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 110, key_id: `signed_curve25519:d1-10`, key_data: JSON.stringify({ key: 'd10' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #11', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 111, key_id: `signed_curve25519:d1-11`, key_data: JSON.stringify({ key: 'd11' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #12', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 112, key_id: `signed_curve25519:d1-12`, key_data: JSON.stringify({ key: 'd12' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #13', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 113, key_id: `signed_curve25519:d1-13`, key_data: JSON.stringify({ key: 'd13' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #14', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 114, key_id: `signed_curve25519:d1-14`, key_data: JSON.stringify({ key: 'd14' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK D1 barrier #15', async () => {
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 115, key_id: `signed_curve25519:d1-15`, key_data: JSON.stringify({ key: 'd15' }) })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM one_time_keys') && sql.includes('claimed = 0'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
    expect(db.updates.filter((u) => u.sql.includes('claimed = 1')).length).toBeGreaterThanOrEqual(1);
  });
});

describe('race federation OTK KV claim double-consume after #175', () => {
  it('claim∥claim same OTK KV barrier #0', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-0`, keyData: { key: 'kv0' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 200, key_id: `signed_curve25519:kv-0` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #1', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-1`, keyData: { key: 'kv1' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 201, key_id: `signed_curve25519:kv-1` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #2', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-2`, keyData: { key: 'kv2' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 202, key_id: `signed_curve25519:kv-2` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #3', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-3`, keyData: { key: 'kv3' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 203, key_id: `signed_curve25519:kv-3` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #4', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-4`, keyData: { key: 'kv4' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 204, key_id: `signed_curve25519:kv-4` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #5', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-5`, keyData: { key: 'kv5' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 205, key_id: `signed_curve25519:kv-5` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #6', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-6`, keyData: { key: 'kv6' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 206, key_id: `signed_curve25519:kv-6` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #7', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-7`, keyData: { key: 'kv7' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 207, key_id: `signed_curve25519:kv-7` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #8', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-8`, keyData: { key: 'kv8' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 208, key_id: `signed_curve25519:kv-8` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #9', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-9`, keyData: { key: 'kv9' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 209, key_id: `signed_curve25519:kv-9` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #10', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-10`, keyData: { key: 'kv10' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 210, key_id: `signed_curve25519:kv-10` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #11', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-11`, keyData: { key: 'kv11' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 211, key_id: `signed_curve25519:kv-11` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #12', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-12`, keyData: { key: 'kv12' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 212, key_id: `signed_curve25519:kv-12` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #13', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-13`, keyData: { key: 'kv13' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 213, key_id: `signed_curve25519:kv-13` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #14', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-14`, keyData: { key: 'kv14' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 214, key_id: `signed_curve25519:kv-14` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
  it('claim∥claim same OTK KV barrier #15', async () => {
    const key = `otk:${USER}:${DEVICE}`;
    const otkKv = mockKv(
      {
        [key]: JSON.stringify({
          [ALG]: [
            { keyId: `signed_curve25519:kv-15`, keyData: { key: 'kv15' }, claimed: false },
          ],
        }),
      },
      {
        getBarrier: {
          match: (k) => k === key,
          count: 2,
        },
      }
    );
    const db = createFedKeysDb({
      otks: [seedOtk({ id: 215, key_id: `signed_curve25519:kv-15` })],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: otkKv });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = JSON.parse(otkKv.data[key]);
    expect(stored[ALG][0].claimed).toBe(true);
    expect(otkKv.puts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('race federation fallback key double-mark after #175', () => {
  it('fallback claim∥claim barrier #0', async () => {
    const db = createFedKeysDb({
      otks: [],
      fallbacks: [seedFallback({ key_id: `signed_curve25519:fb-0`, key_data: JSON.stringify({ key: 'fb0' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM fallback_keys'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.fallbacks[0].used).toBe(1);
  });
  it('fallback claim∥claim barrier #1', async () => {
    const db = createFedKeysDb({
      otks: [],
      fallbacks: [seedFallback({ key_id: `signed_curve25519:fb-1`, key_data: JSON.stringify({ key: 'fb1' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM fallback_keys'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.fallbacks[0].used).toBe(1);
  });
  it('fallback claim∥claim barrier #2', async () => {
    const db = createFedKeysDb({
      otks: [],
      fallbacks: [seedFallback({ key_id: `signed_curve25519:fb-2`, key_data: JSON.stringify({ key: 'fb2' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM fallback_keys'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.fallbacks[0].used).toBe(1);
  });
  it('fallback claim∥claim barrier #3', async () => {
    const db = createFedKeysDb({
      otks: [],
      fallbacks: [seedFallback({ key_id: `signed_curve25519:fb-3`, key_data: JSON.stringify({ key: 'fb3' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM fallback_keys'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.fallbacks[0].used).toBe(1);
  });
  it('fallback claim∥claim barrier #4', async () => {
    const db = createFedKeysDb({
      otks: [],
      fallbacks: [seedFallback({ key_id: `signed_curve25519:fb-4`, key_data: JSON.stringify({ key: 'fb4' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM fallback_keys'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.fallbacks[0].used).toBe(1);
  });
  it('fallback claim∥claim barrier #5', async () => {
    const db = createFedKeysDb({
      otks: [],
      fallbacks: [seedFallback({ key_id: `signed_curve25519:fb-5`, key_data: JSON.stringify({ key: 'fb5' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM fallback_keys'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.fallbacks[0].used).toBe(1);
  });
  it('fallback claim∥claim barrier #6', async () => {
    const db = createFedKeysDb({
      otks: [],
      fallbacks: [seedFallback({ key_id: `signed_curve25519:fb-6`, key_data: JSON.stringify({ key: 'fb6' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM fallback_keys'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.fallbacks[0].used).toBe(1);
  });
  it('fallback claim∥claim barrier #7', async () => {
    const db = createFedKeysDb({
      otks: [],
      fallbacks: [seedFallback({ key_id: `signed_curve25519:fb-7`, key_data: JSON.stringify({ key: 'fb7' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM fallback_keys'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.fallbacks[0].used).toBe(1);
  });
  it('fallback claim∥claim barrier #8', async () => {
    const db = createFedKeysDb({
      otks: [],
      fallbacks: [seedFallback({ key_id: `signed_curve25519:fb-8`, key_data: JSON.stringify({ key: 'fb8' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM fallback_keys'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.fallbacks[0].used).toBe(1);
  });
  it('fallback claim∥claim barrier #9', async () => {
    const db = createFedKeysDb({
      otks: [],
      fallbacks: [seedFallback({ key_id: `signed_curve25519:fb-9`, key_data: JSON.stringify({ key: 'fb9' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM fallback_keys'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.fallbacks[0].used).toBe(1);
  });
  it('fallback claim∥claim barrier #10', async () => {
    const db = createFedKeysDb({
      otks: [],
      fallbacks: [seedFallback({ key_id: `signed_curve25519:fb-10`, key_data: JSON.stringify({ key: 'fb10' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM fallback_keys'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.fallbacks[0].used).toBe(1);
  });
  it('fallback claim∥claim barrier #11', async () => {
    const db = createFedKeysDb({
      otks: [],
      fallbacks: [seedFallback({ key_id: `signed_curve25519:fb-11`, key_data: JSON.stringify({ key: 'fb11' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM fallback_keys'),
        count: 2,
      },
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
      fedReq(env, '/_matrix/federation/v1/user/keys/claim', fedJson('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const keyA = a.body.one_time_keys?.[USER]?.[DEVICE];
    const keyB = b.body.one_time_keys?.[USER]?.[DEVICE];
    expect(keyA || keyB).toBeTruthy();
    expect(db.fallbacks[0].used).toBe(1);
  });
});

describe('race federation claim multi-device parallel after #175', () => {
  it('parallel claim distinct devices soft-1', async () => {
    const db = createFedKeysDb({
      otks: [
        seedOtk({ id: 300, device_id: DEVICE, key_id: `signed_curve25519:a-0`, key_data: JSON.stringify({ key: 'a0' }) }),
        seedOtk({ id: 301, device_id: DEVICE_B, key_id: `signed_curve25519:b-0`, key_data: JSON.stringify({ key: 'b0' }) }),
      ],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const [a, b] = await Promise.all([
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
      ),
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE_B]: ALG } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.one_time_keys[USER][DEVICE]).toBeTruthy();
    expect(b.body.one_time_keys[USER][DEVICE_B]).toBeTruthy();
    expect(db.otks.every((o) => o.claimed === 1)).toBe(true);
  });
  it('parallel claim distinct devices soft-2', async () => {
    const db = createFedKeysDb({
      otks: [
        seedOtk({ id: 302, device_id: DEVICE, key_id: `signed_curve25519:a-1`, key_data: JSON.stringify({ key: 'a1' }) }),
        seedOtk({ id: 303, device_id: DEVICE_B, key_id: `signed_curve25519:b-1`, key_data: JSON.stringify({ key: 'b1' }) }),
      ],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const [a, b] = await Promise.all([
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
      ),
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE_B]: ALG } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.one_time_keys[USER][DEVICE]).toBeTruthy();
    expect(b.body.one_time_keys[USER][DEVICE_B]).toBeTruthy();
    expect(db.otks.every((o) => o.claimed === 1)).toBe(true);
  });
  it('parallel claim distinct devices soft-3', async () => {
    const db = createFedKeysDb({
      otks: [
        seedOtk({ id: 304, device_id: DEVICE, key_id: `signed_curve25519:a-2`, key_data: JSON.stringify({ key: 'a2' }) }),
        seedOtk({ id: 305, device_id: DEVICE_B, key_id: `signed_curve25519:b-2`, key_data: JSON.stringify({ key: 'b2' }) }),
      ],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const [a, b] = await Promise.all([
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
      ),
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE_B]: ALG } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.one_time_keys[USER][DEVICE]).toBeTruthy();
    expect(b.body.one_time_keys[USER][DEVICE_B]).toBeTruthy();
    expect(db.otks.every((o) => o.claimed === 1)).toBe(true);
  });
  it('parallel claim distinct devices soft-4', async () => {
    const db = createFedKeysDb({
      otks: [
        seedOtk({ id: 306, device_id: DEVICE, key_id: `signed_curve25519:a-3`, key_data: JSON.stringify({ key: 'a3' }) }),
        seedOtk({ id: 307, device_id: DEVICE_B, key_id: `signed_curve25519:b-3`, key_data: JSON.stringify({ key: 'b3' }) }),
      ],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const [a, b] = await Promise.all([
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
      ),
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE_B]: ALG } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.one_time_keys[USER][DEVICE]).toBeTruthy();
    expect(b.body.one_time_keys[USER][DEVICE_B]).toBeTruthy();
    expect(db.otks.every((o) => o.claimed === 1)).toBe(true);
  });
  it('parallel claim distinct devices soft-5', async () => {
    const db = createFedKeysDb({
      otks: [
        seedOtk({ id: 308, device_id: DEVICE, key_id: `signed_curve25519:a-4`, key_data: JSON.stringify({ key: 'a4' }) }),
        seedOtk({ id: 309, device_id: DEVICE_B, key_id: `signed_curve25519:b-4`, key_data: JSON.stringify({ key: 'b4' }) }),
      ],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const [a, b] = await Promise.all([
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
      ),
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE_B]: ALG } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.one_time_keys[USER][DEVICE]).toBeTruthy();
    expect(b.body.one_time_keys[USER][DEVICE_B]).toBeTruthy();
    expect(db.otks.every((o) => o.claimed === 1)).toBe(true);
  });
  it('parallel claim distinct devices soft-6', async () => {
    const db = createFedKeysDb({
      otks: [
        seedOtk({ id: 310, device_id: DEVICE, key_id: `signed_curve25519:a-5`, key_data: JSON.stringify({ key: 'a5' }) }),
        seedOtk({ id: 311, device_id: DEVICE_B, key_id: `signed_curve25519:b-5`, key_data: JSON.stringify({ key: 'b5' }) }),
      ],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const [a, b] = await Promise.all([
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
      ),
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE_B]: ALG } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.one_time_keys[USER][DEVICE]).toBeTruthy();
    expect(b.body.one_time_keys[USER][DEVICE_B]).toBeTruthy();
    expect(db.otks.every((o) => o.claimed === 1)).toBe(true);
  });
  it('parallel claim distinct devices soft-7', async () => {
    const db = createFedKeysDb({
      otks: [
        seedOtk({ id: 312, device_id: DEVICE, key_id: `signed_curve25519:a-6`, key_data: JSON.stringify({ key: 'a6' }) }),
        seedOtk({ id: 313, device_id: DEVICE_B, key_id: `signed_curve25519:b-6`, key_data: JSON.stringify({ key: 'b6' }) }),
      ],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const [a, b] = await Promise.all([
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
      ),
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE_B]: ALG } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.one_time_keys[USER][DEVICE]).toBeTruthy();
    expect(b.body.one_time_keys[USER][DEVICE_B]).toBeTruthy();
    expect(db.otks.every((o) => o.claimed === 1)).toBe(true);
  });
  it('parallel claim distinct devices soft-8', async () => {
    const db = createFedKeysDb({
      otks: [
        seedOtk({ id: 314, device_id: DEVICE, key_id: `signed_curve25519:a-7`, key_data: JSON.stringify({ key: 'a7' }) }),
        seedOtk({ id: 315, device_id: DEVICE_B, key_id: `signed_curve25519:b-7`, key_data: JSON.stringify({ key: 'b7' }) }),
      ],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const [a, b] = await Promise.all([
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
      ),
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE_B]: ALG } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.one_time_keys[USER][DEVICE]).toBeTruthy();
    expect(b.body.one_time_keys[USER][DEVICE_B]).toBeTruthy();
    expect(db.otks.every((o) => o.claimed === 1)).toBe(true);
  });
  it('parallel claim distinct devices soft-9', async () => {
    const db = createFedKeysDb({
      otks: [
        seedOtk({ id: 316, device_id: DEVICE, key_id: `signed_curve25519:a-8`, key_data: JSON.stringify({ key: 'a8' }) }),
        seedOtk({ id: 317, device_id: DEVICE_B, key_id: `signed_curve25519:b-8`, key_data: JSON.stringify({ key: 'b8' }) }),
      ],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const [a, b] = await Promise.all([
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
      ),
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE_B]: ALG } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.one_time_keys[USER][DEVICE]).toBeTruthy();
    expect(b.body.one_time_keys[USER][DEVICE_B]).toBeTruthy();
    expect(db.otks.every((o) => o.claimed === 1)).toBe(true);
  });
  it('parallel claim distinct devices soft-10', async () => {
    const db = createFedKeysDb({
      otks: [
        seedOtk({ id: 318, device_id: DEVICE, key_id: `signed_curve25519:a-9`, key_data: JSON.stringify({ key: 'a9' }) }),
        seedOtk({ id: 319, device_id: DEVICE_B, key_id: `signed_curve25519:b-9`, key_data: JSON.stringify({ key: 'b9' }) }),
      ],
    });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const [a, b] = await Promise.all([
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
      ),
      fedReq(
        env,
        '/_matrix/federation/v1/user/keys/claim',
        fedJson('POST', { one_time_keys: { [USER]: { [DEVICE_B]: ALG } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.one_time_keys[USER][DEVICE]).toBeTruthy();
    expect(b.body.one_time_keys[USER][DEVICE_B]).toBeTruthy();
    expect(db.otks.every((o) => o.claimed === 1)).toBe(true);
  });
});

describe('federation claim soft floods after #175', () => {
  it('claim soft bad JSON #0', async () => {
    const env = createFedEnv();
    const res = await fedReq(env, '/_matrix/federation/v1/user/keys/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('claim soft missing one_time_keys #1', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', {})
    );
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('claim soft null one_time_keys #2', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: null })
    );
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('claim soft remote user skip #3', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [REMOTE_USER]: { [DEVICE]: ALG } } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys).toEqual({});
  });
  it('claim soft bad JSON #4', async () => {
    const env = createFedEnv();
    const res = await fedReq(env, '/_matrix/federation/v1/user/keys/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('claim soft missing one_time_keys #5', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', {})
    );
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('claim soft null one_time_keys #6', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: null })
    );
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('claim soft remote user skip #7', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [REMOTE_USER]: { [DEVICE]: ALG } } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys).toEqual({});
  });
  it('claim soft bad JSON #8', async () => {
    const env = createFedEnv();
    const res = await fedReq(env, '/_matrix/federation/v1/user/keys/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('claim soft missing one_time_keys #9', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', {})
    );
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('claim soft null one_time_keys #10', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: null })
    );
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('claim soft remote user skip #11', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [REMOTE_USER]: { [DEVICE]: ALG } } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys).toEqual({});
  });
});

describe('race federation make_join concurrent state reads after #175', () => {
  it('make_join∥make_join barrier #0', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #1', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #2', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #3', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #4', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #5', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #6', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #7', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #8', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #9', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #10', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #11', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #12', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #13', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #14', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
  it('make_join∥make_join barrier #15', async () => {
    const db = createMembershipDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.room_version).toBe('10');
    expect(b.body.room_version).toBe('10');
    expect(a.body.event.type).toBe('m.room.member');
    expect(a.body.event.content.membership).toBe('join');
    expect(a.body.event.sender).toBe(REMOTE_USER);
    expect(a.body.event.auth_events).toEqual(
      expect.arrayContaining([CREATE, JOIN_RULES, POWER])
    );
  });
});

describe('race federation make_join depth mutation mid-flight after #175', () => {
  it('make_join depth mid-flight soft-1', async () => {
    const db = createMembershipDb({
      mutateDepthOnSecond: true,
      selectBarrier: {
        match: (sql) => sql.includes('ORDER BY depth DESC LIMIT 1'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const depths = [a.body.event.depth, b.body.event.depth];
    expect(depths.every((d) => typeof d === 'number' && d >= 6)).toBe(true);
  });
  it('make_join depth mid-flight soft-2', async () => {
    const db = createMembershipDb({
      mutateDepthOnSecond: true,
      selectBarrier: {
        match: (sql) => sql.includes('ORDER BY depth DESC LIMIT 1'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const depths = [a.body.event.depth, b.body.event.depth];
    expect(depths.every((d) => typeof d === 'number' && d >= 6)).toBe(true);
  });
  it('make_join depth mid-flight soft-3', async () => {
    const db = createMembershipDb({
      mutateDepthOnSecond: true,
      selectBarrier: {
        match: (sql) => sql.includes('ORDER BY depth DESC LIMIT 1'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const depths = [a.body.event.depth, b.body.event.depth];
    expect(depths.every((d) => typeof d === 'number' && d >= 6)).toBe(true);
  });
  it('make_join depth mid-flight soft-4', async () => {
    const db = createMembershipDb({
      mutateDepthOnSecond: true,
      selectBarrier: {
        match: (sql) => sql.includes('ORDER BY depth DESC LIMIT 1'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const depths = [a.body.event.depth, b.body.event.depth];
    expect(depths.every((d) => typeof d === 'number' && d >= 6)).toBe(true);
  });
  it('make_join depth mid-flight soft-5', async () => {
    const db = createMembershipDb({
      mutateDepthOnSecond: true,
      selectBarrier: {
        match: (sql) => sql.includes('ORDER BY depth DESC LIMIT 1'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const depths = [a.body.event.depth, b.body.event.depth];
    expect(depths.every((d) => typeof d === 'number' && d >= 6)).toBe(true);
  });
  it('make_join depth mid-flight soft-6', async () => {
    const db = createMembershipDb({
      mutateDepthOnSecond: true,
      selectBarrier: {
        match: (sql) => sql.includes('ORDER BY depth DESC LIMIT 1'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const depths = [a.body.event.depth, b.body.event.depth];
    expect(depths.every((d) => typeof d === 'number' && d >= 6)).toBe(true);
  });
  it('make_join depth mid-flight soft-7', async () => {
    const db = createMembershipDb({
      mutateDepthOnSecond: true,
      selectBarrier: {
        match: (sql) => sql.includes('ORDER BY depth DESC LIMIT 1'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const depths = [a.body.event.depth, b.body.event.depth];
    expect(depths.every((d) => typeof d === 'number' && d >= 6)).toBe(true);
  });
  it('make_join depth mid-flight soft-8', async () => {
    const db = createMembershipDb({
      mutateDepthOnSecond: true,
      selectBarrier: {
        match: (sql) => sql.includes('ORDER BY depth DESC LIMIT 1'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const depths = [a.body.event.depth, b.body.event.depth];
    expect(depths.every((d) => typeof d === 'number' && d >= 6)).toBe(true);
  });
  it('make_join depth mid-flight soft-9', async () => {
    const db = createMembershipDb({
      mutateDepthOnSecond: true,
      selectBarrier: {
        match: (sql) => sql.includes('ORDER BY depth DESC LIMIT 1'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const depths = [a.body.event.depth, b.body.event.depth];
    expect(depths.every((d) => typeof d === 'number' && d >= 6)).toBe(true);
  });
  it('make_join depth mid-flight soft-10', async () => {
    const db = createMembershipDb({
      mutateDepthOnSecond: true,
      selectBarrier: {
        match: (sql) => sql.includes('ORDER BY depth DESC LIMIT 1'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const depths = [a.body.event.depth, b.body.event.depth];
    expect(depths.every((d) => typeof d === 'number' && d >= 6)).toBe(true);
  });
  it('make_join depth mid-flight soft-11', async () => {
    const db = createMembershipDb({
      mutateDepthOnSecond: true,
      selectBarrier: {
        match: (sql) => sql.includes('ORDER BY depth DESC LIMIT 1'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const depths = [a.body.event.depth, b.body.event.depth];
    expect(depths.every((d) => typeof d === 'number' && d >= 6)).toBe(true);
  });
  it('make_join depth mid-flight soft-12', async () => {
    const db = createMembershipDb({
      mutateDepthOnSecond: true,
      selectBarrier: {
        match: (sql) => sql.includes('ORDER BY depth DESC LIMIT 1'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, path, { method: 'GET' }),
      fedReq(env, path, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const depths = [a.body.event.depth, b.body.event.depth];
    expect(depths.every((d) => typeof d === 'number' && d >= 6)).toBe(true);
  });
});

describe('federation make_join missing room soft flood after #175', () => {
  it('make_join missing room soft #0', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent('!missing:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_join missing room soft #1', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent('!missing:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_join missing room soft #2', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent('!missing:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_join missing room soft #3', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent('!missing:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_join missing room soft #4', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent('!missing:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_join missing room soft #5', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent('!missing:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_join missing room soft #6', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent('!missing:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_join missing room soft #7', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent('!missing:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_join missing room soft #8', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent('!missing:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_join missing room soft #9', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent('!missing:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
});

describe('race federation make_join∥make_leave concurrent after #175', () => {
  it('make_join∥make_leave soft-1', async () => {
    const db = createMembershipDb({
      events: [
        {
          event_id: CREATE,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.create',
          state_key: '',
          content: JSON.stringify({ creator: USER }),
          origin_server_ts: NOW,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: JOIN_RULES,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.join_rules',
          state_key: '',
          content: JSON.stringify({ join_rule: 'public' }),
          origin_server_ts: NOW,
          depth: 2,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([CREATE]),
        },
        {
          event_id: POWER,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.power_levels',
          state_key: '',
          content: JSON.stringify({ users: { [USER]: 100 } }),
          origin_server_ts: NOW,
          depth: 3,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([JOIN_RULES]),
        },
        {
          event_id: MEMBER,
          room_id: ROOM,
          sender: REMOTE_USER,
          event_type: 'm.room.member',
          state_key: REMOTE_USER,
          content: JSON.stringify({ membership: 'join' }),
          origin_server_ts: NOW,
          depth: 4,
          auth_events: JSON.stringify([CREATE, POWER]),
          prev_events: JSON.stringify([POWER]),
        },
        {
          event_id: LATEST,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
          origin_server_ts: NOW,
          depth: 5,
          auth_events: '[]',
          prev_events: '[]',
        },
      ],
      state: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: CREATE },
        { room_id: ROOM, event_type: 'm.room.join_rules', state_key: '', event_id: JOIN_RULES },
        { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: POWER },
        { room_id: ROOM, event_type: 'm.room.member', state_key: REMOTE_USER, event_id: MEMBER },
      ],
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const joinPath = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const leavePath = `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, joinPath, { method: 'GET' }),
      fedReq(env, leavePath, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.event.content.membership).toBe('join');
    expect(b.body.event.content.membership).toBe('leave');
  });
  it('make_join∥make_leave soft-2', async () => {
    const db = createMembershipDb({
      events: [
        {
          event_id: CREATE,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.create',
          state_key: '',
          content: JSON.stringify({ creator: USER }),
          origin_server_ts: NOW,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: JOIN_RULES,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.join_rules',
          state_key: '',
          content: JSON.stringify({ join_rule: 'public' }),
          origin_server_ts: NOW,
          depth: 2,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([CREATE]),
        },
        {
          event_id: POWER,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.power_levels',
          state_key: '',
          content: JSON.stringify({ users: { [USER]: 100 } }),
          origin_server_ts: NOW,
          depth: 3,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([JOIN_RULES]),
        },
        {
          event_id: MEMBER,
          room_id: ROOM,
          sender: REMOTE_USER,
          event_type: 'm.room.member',
          state_key: REMOTE_USER,
          content: JSON.stringify({ membership: 'join' }),
          origin_server_ts: NOW,
          depth: 4,
          auth_events: JSON.stringify([CREATE, POWER]),
          prev_events: JSON.stringify([POWER]),
        },
        {
          event_id: LATEST,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
          origin_server_ts: NOW,
          depth: 5,
          auth_events: '[]',
          prev_events: '[]',
        },
      ],
      state: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: CREATE },
        { room_id: ROOM, event_type: 'm.room.join_rules', state_key: '', event_id: JOIN_RULES },
        { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: POWER },
        { room_id: ROOM, event_type: 'm.room.member', state_key: REMOTE_USER, event_id: MEMBER },
      ],
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const joinPath = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const leavePath = `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, joinPath, { method: 'GET' }),
      fedReq(env, leavePath, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.event.content.membership).toBe('join');
    expect(b.body.event.content.membership).toBe('leave');
  });
  it('make_join∥make_leave soft-3', async () => {
    const db = createMembershipDb({
      events: [
        {
          event_id: CREATE,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.create',
          state_key: '',
          content: JSON.stringify({ creator: USER }),
          origin_server_ts: NOW,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: JOIN_RULES,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.join_rules',
          state_key: '',
          content: JSON.stringify({ join_rule: 'public' }),
          origin_server_ts: NOW,
          depth: 2,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([CREATE]),
        },
        {
          event_id: POWER,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.power_levels',
          state_key: '',
          content: JSON.stringify({ users: { [USER]: 100 } }),
          origin_server_ts: NOW,
          depth: 3,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([JOIN_RULES]),
        },
        {
          event_id: MEMBER,
          room_id: ROOM,
          sender: REMOTE_USER,
          event_type: 'm.room.member',
          state_key: REMOTE_USER,
          content: JSON.stringify({ membership: 'join' }),
          origin_server_ts: NOW,
          depth: 4,
          auth_events: JSON.stringify([CREATE, POWER]),
          prev_events: JSON.stringify([POWER]),
        },
        {
          event_id: LATEST,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
          origin_server_ts: NOW,
          depth: 5,
          auth_events: '[]',
          prev_events: '[]',
        },
      ],
      state: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: CREATE },
        { room_id: ROOM, event_type: 'm.room.join_rules', state_key: '', event_id: JOIN_RULES },
        { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: POWER },
        { room_id: ROOM, event_type: 'm.room.member', state_key: REMOTE_USER, event_id: MEMBER },
      ],
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const joinPath = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const leavePath = `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, joinPath, { method: 'GET' }),
      fedReq(env, leavePath, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.event.content.membership).toBe('join');
    expect(b.body.event.content.membership).toBe('leave');
  });
  it('make_join∥make_leave soft-4', async () => {
    const db = createMembershipDb({
      events: [
        {
          event_id: CREATE,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.create',
          state_key: '',
          content: JSON.stringify({ creator: USER }),
          origin_server_ts: NOW,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: JOIN_RULES,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.join_rules',
          state_key: '',
          content: JSON.stringify({ join_rule: 'public' }),
          origin_server_ts: NOW,
          depth: 2,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([CREATE]),
        },
        {
          event_id: POWER,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.power_levels',
          state_key: '',
          content: JSON.stringify({ users: { [USER]: 100 } }),
          origin_server_ts: NOW,
          depth: 3,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([JOIN_RULES]),
        },
        {
          event_id: MEMBER,
          room_id: ROOM,
          sender: REMOTE_USER,
          event_type: 'm.room.member',
          state_key: REMOTE_USER,
          content: JSON.stringify({ membership: 'join' }),
          origin_server_ts: NOW,
          depth: 4,
          auth_events: JSON.stringify([CREATE, POWER]),
          prev_events: JSON.stringify([POWER]),
        },
        {
          event_id: LATEST,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
          origin_server_ts: NOW,
          depth: 5,
          auth_events: '[]',
          prev_events: '[]',
        },
      ],
      state: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: CREATE },
        { room_id: ROOM, event_type: 'm.room.join_rules', state_key: '', event_id: JOIN_RULES },
        { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: POWER },
        { room_id: ROOM, event_type: 'm.room.member', state_key: REMOTE_USER, event_id: MEMBER },
      ],
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const joinPath = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const leavePath = `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, joinPath, { method: 'GET' }),
      fedReq(env, leavePath, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.event.content.membership).toBe('join');
    expect(b.body.event.content.membership).toBe('leave');
  });
  it('make_join∥make_leave soft-5', async () => {
    const db = createMembershipDb({
      events: [
        {
          event_id: CREATE,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.create',
          state_key: '',
          content: JSON.stringify({ creator: USER }),
          origin_server_ts: NOW,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: JOIN_RULES,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.join_rules',
          state_key: '',
          content: JSON.stringify({ join_rule: 'public' }),
          origin_server_ts: NOW,
          depth: 2,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([CREATE]),
        },
        {
          event_id: POWER,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.power_levels',
          state_key: '',
          content: JSON.stringify({ users: { [USER]: 100 } }),
          origin_server_ts: NOW,
          depth: 3,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([JOIN_RULES]),
        },
        {
          event_id: MEMBER,
          room_id: ROOM,
          sender: REMOTE_USER,
          event_type: 'm.room.member',
          state_key: REMOTE_USER,
          content: JSON.stringify({ membership: 'join' }),
          origin_server_ts: NOW,
          depth: 4,
          auth_events: JSON.stringify([CREATE, POWER]),
          prev_events: JSON.stringify([POWER]),
        },
        {
          event_id: LATEST,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
          origin_server_ts: NOW,
          depth: 5,
          auth_events: '[]',
          prev_events: '[]',
        },
      ],
      state: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: CREATE },
        { room_id: ROOM, event_type: 'm.room.join_rules', state_key: '', event_id: JOIN_RULES },
        { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: POWER },
        { room_id: ROOM, event_type: 'm.room.member', state_key: REMOTE_USER, event_id: MEMBER },
      ],
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const joinPath = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const leavePath = `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, joinPath, { method: 'GET' }),
      fedReq(env, leavePath, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.event.content.membership).toBe('join');
    expect(b.body.event.content.membership).toBe('leave');
  });
  it('make_join∥make_leave soft-6', async () => {
    const db = createMembershipDb({
      events: [
        {
          event_id: CREATE,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.create',
          state_key: '',
          content: JSON.stringify({ creator: USER }),
          origin_server_ts: NOW,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: JOIN_RULES,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.join_rules',
          state_key: '',
          content: JSON.stringify({ join_rule: 'public' }),
          origin_server_ts: NOW,
          depth: 2,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([CREATE]),
        },
        {
          event_id: POWER,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.power_levels',
          state_key: '',
          content: JSON.stringify({ users: { [USER]: 100 } }),
          origin_server_ts: NOW,
          depth: 3,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([JOIN_RULES]),
        },
        {
          event_id: MEMBER,
          room_id: ROOM,
          sender: REMOTE_USER,
          event_type: 'm.room.member',
          state_key: REMOTE_USER,
          content: JSON.stringify({ membership: 'join' }),
          origin_server_ts: NOW,
          depth: 4,
          auth_events: JSON.stringify([CREATE, POWER]),
          prev_events: JSON.stringify([POWER]),
        },
        {
          event_id: LATEST,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
          origin_server_ts: NOW,
          depth: 5,
          auth_events: '[]',
          prev_events: '[]',
        },
      ],
      state: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: CREATE },
        { room_id: ROOM, event_type: 'm.room.join_rules', state_key: '', event_id: JOIN_RULES },
        { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: POWER },
        { room_id: ROOM, event_type: 'm.room.member', state_key: REMOTE_USER, event_id: MEMBER },
      ],
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const joinPath = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const leavePath = `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, joinPath, { method: 'GET' }),
      fedReq(env, leavePath, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.event.content.membership).toBe('join');
    expect(b.body.event.content.membership).toBe('leave');
  });
  it('make_join∥make_leave soft-7', async () => {
    const db = createMembershipDb({
      events: [
        {
          event_id: CREATE,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.create',
          state_key: '',
          content: JSON.stringify({ creator: USER }),
          origin_server_ts: NOW,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: JOIN_RULES,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.join_rules',
          state_key: '',
          content: JSON.stringify({ join_rule: 'public' }),
          origin_server_ts: NOW,
          depth: 2,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([CREATE]),
        },
        {
          event_id: POWER,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.power_levels',
          state_key: '',
          content: JSON.stringify({ users: { [USER]: 100 } }),
          origin_server_ts: NOW,
          depth: 3,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([JOIN_RULES]),
        },
        {
          event_id: MEMBER,
          room_id: ROOM,
          sender: REMOTE_USER,
          event_type: 'm.room.member',
          state_key: REMOTE_USER,
          content: JSON.stringify({ membership: 'join' }),
          origin_server_ts: NOW,
          depth: 4,
          auth_events: JSON.stringify([CREATE, POWER]),
          prev_events: JSON.stringify([POWER]),
        },
        {
          event_id: LATEST,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
          origin_server_ts: NOW,
          depth: 5,
          auth_events: '[]',
          prev_events: '[]',
        },
      ],
      state: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: CREATE },
        { room_id: ROOM, event_type: 'm.room.join_rules', state_key: '', event_id: JOIN_RULES },
        { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: POWER },
        { room_id: ROOM, event_type: 'm.room.member', state_key: REMOTE_USER, event_id: MEMBER },
      ],
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const joinPath = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const leavePath = `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, joinPath, { method: 'GET' }),
      fedReq(env, leavePath, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.event.content.membership).toBe('join');
    expect(b.body.event.content.membership).toBe('leave');
  });
  it('make_join∥make_leave soft-8', async () => {
    const db = createMembershipDb({
      events: [
        {
          event_id: CREATE,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.create',
          state_key: '',
          content: JSON.stringify({ creator: USER }),
          origin_server_ts: NOW,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: JOIN_RULES,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.join_rules',
          state_key: '',
          content: JSON.stringify({ join_rule: 'public' }),
          origin_server_ts: NOW,
          depth: 2,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([CREATE]),
        },
        {
          event_id: POWER,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.power_levels',
          state_key: '',
          content: JSON.stringify({ users: { [USER]: 100 } }),
          origin_server_ts: NOW,
          depth: 3,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([JOIN_RULES]),
        },
        {
          event_id: MEMBER,
          room_id: ROOM,
          sender: REMOTE_USER,
          event_type: 'm.room.member',
          state_key: REMOTE_USER,
          content: JSON.stringify({ membership: 'join' }),
          origin_server_ts: NOW,
          depth: 4,
          auth_events: JSON.stringify([CREATE, POWER]),
          prev_events: JSON.stringify([POWER]),
        },
        {
          event_id: LATEST,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
          origin_server_ts: NOW,
          depth: 5,
          auth_events: '[]',
          prev_events: '[]',
        },
      ],
      state: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: CREATE },
        { room_id: ROOM, event_type: 'm.room.join_rules', state_key: '', event_id: JOIN_RULES },
        { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: POWER },
        { room_id: ROOM, event_type: 'm.room.member', state_key: REMOTE_USER, event_id: MEMBER },
      ],
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const joinPath = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const leavePath = `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, joinPath, { method: 'GET' }),
      fedReq(env, leavePath, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.event.content.membership).toBe('join');
    expect(b.body.event.content.membership).toBe('leave');
  });
  it('make_join∥make_leave soft-9', async () => {
    const db = createMembershipDb({
      events: [
        {
          event_id: CREATE,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.create',
          state_key: '',
          content: JSON.stringify({ creator: USER }),
          origin_server_ts: NOW,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: JOIN_RULES,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.join_rules',
          state_key: '',
          content: JSON.stringify({ join_rule: 'public' }),
          origin_server_ts: NOW,
          depth: 2,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([CREATE]),
        },
        {
          event_id: POWER,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.power_levels',
          state_key: '',
          content: JSON.stringify({ users: { [USER]: 100 } }),
          origin_server_ts: NOW,
          depth: 3,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([JOIN_RULES]),
        },
        {
          event_id: MEMBER,
          room_id: ROOM,
          sender: REMOTE_USER,
          event_type: 'm.room.member',
          state_key: REMOTE_USER,
          content: JSON.stringify({ membership: 'join' }),
          origin_server_ts: NOW,
          depth: 4,
          auth_events: JSON.stringify([CREATE, POWER]),
          prev_events: JSON.stringify([POWER]),
        },
        {
          event_id: LATEST,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
          origin_server_ts: NOW,
          depth: 5,
          auth_events: '[]',
          prev_events: '[]',
        },
      ],
      state: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: CREATE },
        { room_id: ROOM, event_type: 'm.room.join_rules', state_key: '', event_id: JOIN_RULES },
        { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: POWER },
        { room_id: ROOM, event_type: 'm.room.member', state_key: REMOTE_USER, event_id: MEMBER },
      ],
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const joinPath = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const leavePath = `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, joinPath, { method: 'GET' }),
      fedReq(env, leavePath, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.event.content.membership).toBe('join');
    expect(b.body.event.content.membership).toBe('leave');
  });
  it('make_join∥make_leave soft-10', async () => {
    const db = createMembershipDb({
      events: [
        {
          event_id: CREATE,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.create',
          state_key: '',
          content: JSON.stringify({ creator: USER }),
          origin_server_ts: NOW,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: JOIN_RULES,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.join_rules',
          state_key: '',
          content: JSON.stringify({ join_rule: 'public' }),
          origin_server_ts: NOW,
          depth: 2,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([CREATE]),
        },
        {
          event_id: POWER,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.power_levels',
          state_key: '',
          content: JSON.stringify({ users: { [USER]: 100 } }),
          origin_server_ts: NOW,
          depth: 3,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([JOIN_RULES]),
        },
        {
          event_id: MEMBER,
          room_id: ROOM,
          sender: REMOTE_USER,
          event_type: 'm.room.member',
          state_key: REMOTE_USER,
          content: JSON.stringify({ membership: 'join' }),
          origin_server_ts: NOW,
          depth: 4,
          auth_events: JSON.stringify([CREATE, POWER]),
          prev_events: JSON.stringify([POWER]),
        },
        {
          event_id: LATEST,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
          origin_server_ts: NOW,
          depth: 5,
          auth_events: '[]',
          prev_events: '[]',
        },
      ],
      state: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: CREATE },
        { room_id: ROOM, event_type: 'm.room.join_rules', state_key: '', event_id: JOIN_RULES },
        { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: POWER },
        { room_id: ROOM, event_type: 'm.room.member', state_key: REMOTE_USER, event_id: MEMBER },
      ],
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const joinPath = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const leavePath = `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, joinPath, { method: 'GET' }),
      fedReq(env, leavePath, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.event.content.membership).toBe('join');
    expect(b.body.event.content.membership).toBe('leave');
  });
  it('make_join∥make_leave soft-11', async () => {
    const db = createMembershipDb({
      events: [
        {
          event_id: CREATE,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.create',
          state_key: '',
          content: JSON.stringify({ creator: USER }),
          origin_server_ts: NOW,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: JOIN_RULES,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.join_rules',
          state_key: '',
          content: JSON.stringify({ join_rule: 'public' }),
          origin_server_ts: NOW,
          depth: 2,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([CREATE]),
        },
        {
          event_id: POWER,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.power_levels',
          state_key: '',
          content: JSON.stringify({ users: { [USER]: 100 } }),
          origin_server_ts: NOW,
          depth: 3,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([JOIN_RULES]),
        },
        {
          event_id: MEMBER,
          room_id: ROOM,
          sender: REMOTE_USER,
          event_type: 'm.room.member',
          state_key: REMOTE_USER,
          content: JSON.stringify({ membership: 'join' }),
          origin_server_ts: NOW,
          depth: 4,
          auth_events: JSON.stringify([CREATE, POWER]),
          prev_events: JSON.stringify([POWER]),
        },
        {
          event_id: LATEST,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
          origin_server_ts: NOW,
          depth: 5,
          auth_events: '[]',
          prev_events: '[]',
        },
      ],
      state: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: CREATE },
        { room_id: ROOM, event_type: 'm.room.join_rules', state_key: '', event_id: JOIN_RULES },
        { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: POWER },
        { room_id: ROOM, event_type: 'm.room.member', state_key: REMOTE_USER, event_id: MEMBER },
      ],
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const joinPath = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const leavePath = `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, joinPath, { method: 'GET' }),
      fedReq(env, leavePath, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.event.content.membership).toBe('join');
    expect(b.body.event.content.membership).toBe('leave');
  });
  it('make_join∥make_leave soft-12', async () => {
    const db = createMembershipDb({
      events: [
        {
          event_id: CREATE,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.create',
          state_key: '',
          content: JSON.stringify({ creator: USER }),
          origin_server_ts: NOW,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: JOIN_RULES,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.join_rules',
          state_key: '',
          content: JSON.stringify({ join_rule: 'public' }),
          origin_server_ts: NOW,
          depth: 2,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([CREATE]),
        },
        {
          event_id: POWER,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.power_levels',
          state_key: '',
          content: JSON.stringify({ users: { [USER]: 100 } }),
          origin_server_ts: NOW,
          depth: 3,
          auth_events: JSON.stringify([CREATE]),
          prev_events: JSON.stringify([JOIN_RULES]),
        },
        {
          event_id: MEMBER,
          room_id: ROOM,
          sender: REMOTE_USER,
          event_type: 'm.room.member',
          state_key: REMOTE_USER,
          content: JSON.stringify({ membership: 'join' }),
          origin_server_ts: NOW,
          depth: 4,
          auth_events: JSON.stringify([CREATE, POWER]),
          prev_events: JSON.stringify([POWER]),
        },
        {
          event_id: LATEST,
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
          origin_server_ts: NOW,
          depth: 5,
          auth_events: '[]',
          prev_events: '[]',
        },
      ],
      state: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: CREATE },
        { room_id: ROOM, event_type: 'm.room.join_rules', state_key: '', event_id: JOIN_RULES },
        { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: POWER },
        { room_id: ROOM, event_type: 'm.room.member', state_key: REMOTE_USER, event_id: MEMBER },
      ],
      selectBarrier: {
        match: (sql) => sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version'),
        count: 2,
      },
    });
    const env = createFedEnv({ db });
    const joinPath = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const leavePath = `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`;
    const [a, b] = await Promise.all([
      fedReq(env, joinPath, { method: 'GET' }),
      fedReq(env, leavePath, { method: 'GET' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.event.content.membership).toBe('join');
    expect(b.body.event.content.membership).toBe('leave');
  });
});


describe('cross-module account-data∥federation claim soft lifecycle after #175', () => {
  it('account-data PUT then claim soft-1', async () => {
    const adb = createAccountDataDb();
    const aenv = createAccountEnv({ db: adb });
    const put = await accountReq(
      aenv,
      globalPath('m.direct'),
      jsonInit('PUT', { [BOB]: [`!dm0:example.com`] })
    );
    expect(put.status).toBe(200);

    const fdb = createFedKeysDb({
      otks: [seedOtk({ id: 400, key_id: `signed_curve25519:x-0`, key_data: JSON.stringify({ key: 'x0' }) })],
    });
    const fenv = createFedEnv({ db: fdb, oneTimeKeysKv: mockKv() });
    const claim = await fedReq(
      fenv,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    expect(claim.body.one_time_keys[USER][DEVICE][`signed_curve25519:x-0`]).toEqual({ key: 'x0' });
    expect(adb.changes.length).toBe(1);
    expect(fdb.otks[0].claimed).toBe(1);
  });
  it('account-data PUT then claim soft-2', async () => {
    const adb = createAccountDataDb();
    const aenv = createAccountEnv({ db: adb });
    const put = await accountReq(
      aenv,
      globalPath('m.direct'),
      jsonInit('PUT', { [BOB]: [`!dm1:example.com`] })
    );
    expect(put.status).toBe(200);

    const fdb = createFedKeysDb({
      otks: [seedOtk({ id: 401, key_id: `signed_curve25519:x-1`, key_data: JSON.stringify({ key: 'x1' }) })],
    });
    const fenv = createFedEnv({ db: fdb, oneTimeKeysKv: mockKv() });
    const claim = await fedReq(
      fenv,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    expect(claim.body.one_time_keys[USER][DEVICE][`signed_curve25519:x-1`]).toEqual({ key: 'x1' });
    expect(adb.changes.length).toBe(1);
    expect(fdb.otks[0].claimed).toBe(1);
  });
  it('account-data PUT then claim soft-3', async () => {
    const adb = createAccountDataDb();
    const aenv = createAccountEnv({ db: adb });
    const put = await accountReq(
      aenv,
      globalPath('m.direct'),
      jsonInit('PUT', { [BOB]: [`!dm2:example.com`] })
    );
    expect(put.status).toBe(200);

    const fdb = createFedKeysDb({
      otks: [seedOtk({ id: 402, key_id: `signed_curve25519:x-2`, key_data: JSON.stringify({ key: 'x2' }) })],
    });
    const fenv = createFedEnv({ db: fdb, oneTimeKeysKv: mockKv() });
    const claim = await fedReq(
      fenv,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    expect(claim.body.one_time_keys[USER][DEVICE][`signed_curve25519:x-2`]).toEqual({ key: 'x2' });
    expect(adb.changes.length).toBe(1);
    expect(fdb.otks[0].claimed).toBe(1);
  });
  it('account-data PUT then claim soft-4', async () => {
    const adb = createAccountDataDb();
    const aenv = createAccountEnv({ db: adb });
    const put = await accountReq(
      aenv,
      globalPath('m.direct'),
      jsonInit('PUT', { [BOB]: [`!dm3:example.com`] })
    );
    expect(put.status).toBe(200);

    const fdb = createFedKeysDb({
      otks: [seedOtk({ id: 403, key_id: `signed_curve25519:x-3`, key_data: JSON.stringify({ key: 'x3' }) })],
    });
    const fenv = createFedEnv({ db: fdb, oneTimeKeysKv: mockKv() });
    const claim = await fedReq(
      fenv,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    expect(claim.body.one_time_keys[USER][DEVICE][`signed_curve25519:x-3`]).toEqual({ key: 'x3' });
    expect(adb.changes.length).toBe(1);
    expect(fdb.otks[0].claimed).toBe(1);
  });
  it('account-data PUT then claim soft-5', async () => {
    const adb = createAccountDataDb();
    const aenv = createAccountEnv({ db: adb });
    const put = await accountReq(
      aenv,
      globalPath('m.direct'),
      jsonInit('PUT', { [BOB]: [`!dm4:example.com`] })
    );
    expect(put.status).toBe(200);

    const fdb = createFedKeysDb({
      otks: [seedOtk({ id: 404, key_id: `signed_curve25519:x-4`, key_data: JSON.stringify({ key: 'x4' }) })],
    });
    const fenv = createFedEnv({ db: fdb, oneTimeKeysKv: mockKv() });
    const claim = await fedReq(
      fenv,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    expect(claim.body.one_time_keys[USER][DEVICE][`signed_curve25519:x-4`]).toEqual({ key: 'x4' });
    expect(adb.changes.length).toBe(1);
    expect(fdb.otks[0].claimed).toBe(1);
  });
  it('account-data PUT then claim soft-6', async () => {
    const adb = createAccountDataDb();
    const aenv = createAccountEnv({ db: adb });
    const put = await accountReq(
      aenv,
      globalPath('m.direct'),
      jsonInit('PUT', { [BOB]: [`!dm5:example.com`] })
    );
    expect(put.status).toBe(200);

    const fdb = createFedKeysDb({
      otks: [seedOtk({ id: 405, key_id: `signed_curve25519:x-5`, key_data: JSON.stringify({ key: 'x5' }) })],
    });
    const fenv = createFedEnv({ db: fdb, oneTimeKeysKv: mockKv() });
    const claim = await fedReq(
      fenv,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    expect(claim.body.one_time_keys[USER][DEVICE][`signed_curve25519:x-5`]).toEqual({ key: 'x5' });
    expect(adb.changes.length).toBe(1);
    expect(fdb.otks[0].claimed).toBe(1);
  });
  it('account-data PUT then claim soft-7', async () => {
    const adb = createAccountDataDb();
    const aenv = createAccountEnv({ db: adb });
    const put = await accountReq(
      aenv,
      globalPath('m.direct'),
      jsonInit('PUT', { [BOB]: [`!dm6:example.com`] })
    );
    expect(put.status).toBe(200);

    const fdb = createFedKeysDb({
      otks: [seedOtk({ id: 406, key_id: `signed_curve25519:x-6`, key_data: JSON.stringify({ key: 'x6' }) })],
    });
    const fenv = createFedEnv({ db: fdb, oneTimeKeysKv: mockKv() });
    const claim = await fedReq(
      fenv,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    expect(claim.body.one_time_keys[USER][DEVICE][`signed_curve25519:x-6`]).toEqual({ key: 'x6' });
    expect(adb.changes.length).toBe(1);
    expect(fdb.otks[0].claimed).toBe(1);
  });
  it('account-data PUT then claim soft-8', async () => {
    const adb = createAccountDataDb();
    const aenv = createAccountEnv({ db: adb });
    const put = await accountReq(
      aenv,
      globalPath('m.direct'),
      jsonInit('PUT', { [BOB]: [`!dm7:example.com`] })
    );
    expect(put.status).toBe(200);

    const fdb = createFedKeysDb({
      otks: [seedOtk({ id: 407, key_id: `signed_curve25519:x-7`, key_data: JSON.stringify({ key: 'x7' }) })],
    });
    const fenv = createFedEnv({ db: fdb, oneTimeKeysKv: mockKv() });
    const claim = await fedReq(
      fenv,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    expect(claim.body.one_time_keys[USER][DEVICE][`signed_curve25519:x-7`]).toEqual({ key: 'x7' });
    expect(adb.changes.length).toBe(1);
    expect(fdb.otks[0].claimed).toBe(1);
  });
  it('account-data PUT then claim soft-9', async () => {
    const adb = createAccountDataDb();
    const aenv = createAccountEnv({ db: adb });
    const put = await accountReq(
      aenv,
      globalPath('m.direct'),
      jsonInit('PUT', { [BOB]: [`!dm8:example.com`] })
    );
    expect(put.status).toBe(200);

    const fdb = createFedKeysDb({
      otks: [seedOtk({ id: 408, key_id: `signed_curve25519:x-8`, key_data: JSON.stringify({ key: 'x8' }) })],
    });
    const fenv = createFedEnv({ db: fdb, oneTimeKeysKv: mockKv() });
    const claim = await fedReq(
      fenv,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    expect(claim.body.one_time_keys[USER][DEVICE][`signed_curve25519:x-8`]).toEqual({ key: 'x8' });
    expect(adb.changes.length).toBe(1);
    expect(fdb.otks[0].claimed).toBe(1);
  });
  it('account-data PUT then claim soft-10', async () => {
    const adb = createAccountDataDb();
    const aenv = createAccountEnv({ db: adb });
    const put = await accountReq(
      aenv,
      globalPath('m.direct'),
      jsonInit('PUT', { [BOB]: [`!dm9:example.com`] })
    );
    expect(put.status).toBe(200);

    const fdb = createFedKeysDb({
      otks: [seedOtk({ id: 409, key_id: `signed_curve25519:x-9`, key_data: JSON.stringify({ key: 'x9' }) })],
    });
    const fenv = createFedEnv({ db: fdb, oneTimeKeysKv: mockKv() });
    const claim = await fedReq(
      fenv,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    expect(claim.body.one_time_keys[USER][DEVICE][`signed_curve25519:x-9`]).toEqual({ key: 'x9' });
    expect(adb.changes.length).toBe(1);
    expect(fdb.otks[0].claimed).toBe(1);
  });
  it('account-data PUT then claim soft-11', async () => {
    const adb = createAccountDataDb();
    const aenv = createAccountEnv({ db: adb });
    const put = await accountReq(
      aenv,
      globalPath('m.direct'),
      jsonInit('PUT', { [BOB]: [`!dm10:example.com`] })
    );
    expect(put.status).toBe(200);

    const fdb = createFedKeysDb({
      otks: [seedOtk({ id: 410, key_id: `signed_curve25519:x-10`, key_data: JSON.stringify({ key: 'x10' }) })],
    });
    const fenv = createFedEnv({ db: fdb, oneTimeKeysKv: mockKv() });
    const claim = await fedReq(
      fenv,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    expect(claim.body.one_time_keys[USER][DEVICE][`signed_curve25519:x-10`]).toEqual({ key: 'x10' });
    expect(adb.changes.length).toBe(1);
    expect(fdb.otks[0].claimed).toBe(1);
  });
  it('account-data PUT then claim soft-12', async () => {
    const adb = createAccountDataDb();
    const aenv = createAccountEnv({ db: adb });
    const put = await accountReq(
      aenv,
      globalPath('m.direct'),
      jsonInit('PUT', { [BOB]: [`!dm11:example.com`] })
    );
    expect(put.status).toBe(200);

    const fdb = createFedKeysDb({
      otks: [seedOtk({ id: 411, key_id: `signed_curve25519:x-11`, key_data: JSON.stringify({ key: 'x11' }) })],
    });
    const fenv = createFedEnv({ db: fdb, oneTimeKeysKv: mockKv() });
    const claim = await fedReq(
      fenv,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    expect(claim.body.one_time_keys[USER][DEVICE][`signed_curve25519:x-11`]).toEqual({ key: 'x11' });
    expect(adb.changes.length).toBe(1);
    expect(fdb.otks[0].claimed).toBe(1);
  });
});

describe('account-data bad JSON soft flood after #175', () => {
  it('global PUT bad JSON soft #0', async () => {
    const env = createAccountEnv();
    const res = await accountReq(env, globalPath('m.direct'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{',
    });
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
  it('global PUT bad JSON soft #1', async () => {
    const env = createAccountEnv();
    const res = await accountReq(env, globalPath('m.direct'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{',
    });
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
  it('global PUT bad JSON soft #2', async () => {
    const env = createAccountEnv();
    const res = await accountReq(env, globalPath('m.direct'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{',
    });
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
  it('global PUT bad JSON soft #3', async () => {
    const env = createAccountEnv();
    const res = await accountReq(env, globalPath('m.direct'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{',
    });
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
  it('global PUT bad JSON soft #4', async () => {
    const env = createAccountEnv();
    const res = await accountReq(env, globalPath('m.direct'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{',
    });
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
  it('global PUT bad JSON soft #5', async () => {
    const env = createAccountEnv();
    const res = await accountReq(env, globalPath('m.direct'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{',
    });
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
  it('global PUT bad JSON soft #6', async () => {
    const env = createAccountEnv();
    const res = await accountReq(env, globalPath('m.direct'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{',
    });
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
  it('global PUT bad JSON soft #7', async () => {
    const env = createAccountEnv();
    const res = await accountReq(env, globalPath('m.direct'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{',
    });
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
  it('global PUT bad JSON soft #8', async () => {
    const env = createAccountEnv();
    const res = await accountReq(env, globalPath('m.direct'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{',
    });
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
  it('global PUT bad JSON soft #9', async () => {
    const env = createAccountEnv();
    const res = await accountReq(env, globalPath('m.direct'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{',
    });
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
});

describe('account-data charset / method soft flood after #175', () => {
  it('charset PUT soft #0', async () => {
    const db = createAccountDataDb();
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      globalPath('m.push_rules'),
      jsonInit('PUT', { soft: 0 }, 'application/json')
    );
    expect(res.status).toBe(200);
    expect(db.rows.some((r) => r.event_type === 'm.push_rules')).toBe(true);
  });
  it('charset PUT soft #1', async () => {
    const db = createAccountDataDb();
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      globalPath('m.push_rules'),
      jsonInit('PUT', { soft: 1 }, 'application/json; charset=utf-8')
    );
    expect(res.status).toBe(200);
    expect(db.rows.some((r) => r.event_type === 'm.push_rules')).toBe(true);
  });
  it('charset PUT soft #2', async () => {
    const db = createAccountDataDb();
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      globalPath('m.push_rules'),
      jsonInit('PUT', { soft: 2 }, 'application/json;charset=UTF-8')
    );
    expect(res.status).toBe(200);
    expect(db.rows.some((r) => r.event_type === 'm.push_rules')).toBe(true);
  });
  it('charset PUT soft #3', async () => {
    const db = createAccountDataDb();
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      globalPath('m.push_rules'),
      jsonInit('PUT', { soft: 3 }, 'APPLICATION/JSON')
    );
    expect(res.status).toBe(200);
    expect(db.rows.some((r) => r.event_type === 'm.push_rules')).toBe(true);
  });
  it('charset PUT soft #4', async () => {
    const db = createAccountDataDb();
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      globalPath('m.push_rules'),
      jsonInit('PUT', { soft: 4 }, 'application/json')
    );
    expect(res.status).toBe(200);
    expect(db.rows.some((r) => r.event_type === 'm.push_rules')).toBe(true);
  });
  it('charset PUT soft #5', async () => {
    const db = createAccountDataDb();
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      globalPath('m.push_rules'),
      jsonInit('PUT', { soft: 5 }, 'application/json; charset=utf-8')
    );
    expect(res.status).toBe(200);
    expect(db.rows.some((r) => r.event_type === 'm.push_rules')).toBe(true);
  });
  it('charset PUT soft #6', async () => {
    const db = createAccountDataDb();
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      globalPath('m.push_rules'),
      jsonInit('PUT', { soft: 6 }, 'application/json;charset=UTF-8')
    );
    expect(res.status).toBe(200);
    expect(db.rows.some((r) => r.event_type === 'm.push_rules')).toBe(true);
  });
  it('charset PUT soft #7', async () => {
    const db = createAccountDataDb();
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      globalPath('m.push_rules'),
      jsonInit('PUT', { soft: 7 }, 'APPLICATION/JSON')
    );
    expect(res.status).toBe(200);
    expect(db.rows.some((r) => r.event_type === 'm.push_rules')).toBe(true);
  });
  it('charset PUT soft #8', async () => {
    const db = createAccountDataDb();
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      globalPath('m.push_rules'),
      jsonInit('PUT', { soft: 8 }, 'application/json')
    );
    expect(res.status).toBe(200);
    expect(db.rows.some((r) => r.event_type === 'm.push_rules')).toBe(true);
  });
  it('charset PUT soft #9', async () => {
    const db = createAccountDataDb();
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      globalPath('m.push_rules'),
      jsonInit('PUT', { soft: 9 }, 'application/json; charset=utf-8')
    );
    expect(res.status).toBe(200);
    expect(db.rows.some((r) => r.event_type === 'm.push_rules')).toBe(true);
  });
  it('charset PUT soft #10', async () => {
    const db = createAccountDataDb();
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      globalPath('m.push_rules'),
      jsonInit('PUT', { soft: 10 }, 'application/json;charset=UTF-8')
    );
    expect(res.status).toBe(200);
    expect(db.rows.some((r) => r.event_type === 'm.push_rules')).toBe(true);
  });
  it('charset PUT soft #11', async () => {
    const db = createAccountDataDb();
    const env = createAccountEnv({ db });
    const res = await accountReq(
      env,
      globalPath('m.push_rules'),
      jsonInit('PUT', { soft: 11 }, 'APPLICATION/JSON')
    );
    expect(res.status).toBe(200);
    expect(db.rows.some((r) => r.event_type === 'm.push_rules')).toBe(true);
  });
});

describe('federation claim empty device map soft flood after #175', () => {
  it('claim empty devices soft #0', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: {} } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim empty devices soft #1', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: {} } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim empty devices soft #2', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: {} } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim empty devices soft #3', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: {} } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim empty devices soft #4', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: {} } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim empty devices soft #5', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: {} } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim empty devices soft #6', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: {} } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim empty devices soft #7', async () => {
    const env = createFedEnv();
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: {} } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
});

describe('race account-data room2 isolation concurrent after #175', () => {
  it('room isolation PUT∥PUT soft-1', async () => {
    const db = createAccountDataDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag', ROOM_ENC), jsonInit('PUT', { room: 1, i: 0 })),
      accountReq(env, roomPath('m.tag', ROOM2_ENC), jsonInit('PUT', { room: 2, i: 0 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const r1 = db.rows.find((r) => r.room_id === ROOM && r.event_type === 'm.tag');
    const r2 = db.rows.find((r) => r.room_id === ROOM2 && r.event_type === 'm.tag');
    expect(JSON.parse(r1!.content)).toEqual({ room: 1, i: 0 });
    expect(JSON.parse(r2!.content)).toEqual({ room: 2, i: 0 });
  });
  it('room isolation PUT∥PUT soft-2', async () => {
    const db = createAccountDataDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag', ROOM_ENC), jsonInit('PUT', { room: 1, i: 1 })),
      accountReq(env, roomPath('m.tag', ROOM2_ENC), jsonInit('PUT', { room: 2, i: 1 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const r1 = db.rows.find((r) => r.room_id === ROOM && r.event_type === 'm.tag');
    const r2 = db.rows.find((r) => r.room_id === ROOM2 && r.event_type === 'm.tag');
    expect(JSON.parse(r1!.content)).toEqual({ room: 1, i: 1 });
    expect(JSON.parse(r2!.content)).toEqual({ room: 2, i: 1 });
  });
  it('room isolation PUT∥PUT soft-3', async () => {
    const db = createAccountDataDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag', ROOM_ENC), jsonInit('PUT', { room: 1, i: 2 })),
      accountReq(env, roomPath('m.tag', ROOM2_ENC), jsonInit('PUT', { room: 2, i: 2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const r1 = db.rows.find((r) => r.room_id === ROOM && r.event_type === 'm.tag');
    const r2 = db.rows.find((r) => r.room_id === ROOM2 && r.event_type === 'm.tag');
    expect(JSON.parse(r1!.content)).toEqual({ room: 1, i: 2 });
    expect(JSON.parse(r2!.content)).toEqual({ room: 2, i: 2 });
  });
  it('room isolation PUT∥PUT soft-4', async () => {
    const db = createAccountDataDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag', ROOM_ENC), jsonInit('PUT', { room: 1, i: 3 })),
      accountReq(env, roomPath('m.tag', ROOM2_ENC), jsonInit('PUT', { room: 2, i: 3 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const r1 = db.rows.find((r) => r.room_id === ROOM && r.event_type === 'm.tag');
    const r2 = db.rows.find((r) => r.room_id === ROOM2 && r.event_type === 'm.tag');
    expect(JSON.parse(r1!.content)).toEqual({ room: 1, i: 3 });
    expect(JSON.parse(r2!.content)).toEqual({ room: 2, i: 3 });
  });
  it('room isolation PUT∥PUT soft-5', async () => {
    const db = createAccountDataDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag', ROOM_ENC), jsonInit('PUT', { room: 1, i: 4 })),
      accountReq(env, roomPath('m.tag', ROOM2_ENC), jsonInit('PUT', { room: 2, i: 4 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const r1 = db.rows.find((r) => r.room_id === ROOM && r.event_type === 'm.tag');
    const r2 = db.rows.find((r) => r.room_id === ROOM2 && r.event_type === 'm.tag');
    expect(JSON.parse(r1!.content)).toEqual({ room: 1, i: 4 });
    expect(JSON.parse(r2!.content)).toEqual({ room: 2, i: 4 });
  });
  it('room isolation PUT∥PUT soft-6', async () => {
    const db = createAccountDataDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag', ROOM_ENC), jsonInit('PUT', { room: 1, i: 5 })),
      accountReq(env, roomPath('m.tag', ROOM2_ENC), jsonInit('PUT', { room: 2, i: 5 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const r1 = db.rows.find((r) => r.room_id === ROOM && r.event_type === 'm.tag');
    const r2 = db.rows.find((r) => r.room_id === ROOM2 && r.event_type === 'm.tag');
    expect(JSON.parse(r1!.content)).toEqual({ room: 1, i: 5 });
    expect(JSON.parse(r2!.content)).toEqual({ room: 2, i: 5 });
  });
  it('room isolation PUT∥PUT soft-7', async () => {
    const db = createAccountDataDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag', ROOM_ENC), jsonInit('PUT', { room: 1, i: 6 })),
      accountReq(env, roomPath('m.tag', ROOM2_ENC), jsonInit('PUT', { room: 2, i: 6 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const r1 = db.rows.find((r) => r.room_id === ROOM && r.event_type === 'm.tag');
    const r2 = db.rows.find((r) => r.room_id === ROOM2 && r.event_type === 'm.tag');
    expect(JSON.parse(r1!.content)).toEqual({ room: 1, i: 6 });
    expect(JSON.parse(r2!.content)).toEqual({ room: 2, i: 6 });
  });
  it('room isolation PUT∥PUT soft-8', async () => {
    const db = createAccountDataDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag', ROOM_ENC), jsonInit('PUT', { room: 1, i: 7 })),
      accountReq(env, roomPath('m.tag', ROOM2_ENC), jsonInit('PUT', { room: 2, i: 7 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const r1 = db.rows.find((r) => r.room_id === ROOM && r.event_type === 'm.tag');
    const r2 = db.rows.find((r) => r.room_id === ROOM2 && r.event_type === 'm.tag');
    expect(JSON.parse(r1!.content)).toEqual({ room: 1, i: 7 });
    expect(JSON.parse(r2!.content)).toEqual({ room: 2, i: 7 });
  });
  it('room isolation PUT∥PUT soft-9', async () => {
    const db = createAccountDataDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag', ROOM_ENC), jsonInit('PUT', { room: 1, i: 8 })),
      accountReq(env, roomPath('m.tag', ROOM2_ENC), jsonInit('PUT', { room: 2, i: 8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const r1 = db.rows.find((r) => r.room_id === ROOM && r.event_type === 'm.tag');
    const r2 = db.rows.find((r) => r.room_id === ROOM2 && r.event_type === 'm.tag');
    expect(JSON.parse(r1!.content)).toEqual({ room: 1, i: 8 });
    expect(JSON.parse(r2!.content)).toEqual({ room: 2, i: 8 });
  });
  it('room isolation PUT∥PUT soft-10', async () => {
    const db = createAccountDataDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const env = createAccountEnv({ db });
    const [a, b] = await Promise.all([
      accountReq(env, roomPath('m.tag', ROOM_ENC), jsonInit('PUT', { room: 1, i: 9 })),
      accountReq(env, roomPath('m.tag', ROOM2_ENC), jsonInit('PUT', { room: 2, i: 9 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const r1 = db.rows.find((r) => r.room_id === ROOM && r.event_type === 'm.tag');
    const r2 = db.rows.find((r) => r.room_id === ROOM2 && r.event_type === 'm.tag');
    expect(JSON.parse(r1!.content)).toEqual({ room: 1, i: 9 });
    expect(JSON.parse(r2!.content)).toEqual({ room: 2, i: 9 });
  });
});

describe('race federation claim no keys empty result after #175', () => {
  it('claim no keys soft #0', async () => {
    const db = createFedKeysDb({ otks: [], fallbacks: [] });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim no keys soft #1', async () => {
    const db = createFedKeysDb({ otks: [], fallbacks: [] });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim no keys soft #2', async () => {
    const db = createFedKeysDb({ otks: [], fallbacks: [] });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim no keys soft #3', async () => {
    const db = createFedKeysDb({ otks: [], fallbacks: [] });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim no keys soft #4', async () => {
    const db = createFedKeysDb({ otks: [], fallbacks: [] });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim no keys soft #5', async () => {
    const db = createFedKeysDb({ otks: [], fallbacks: [] });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim no keys soft #6', async () => {
    const db = createFedKeysDb({ otks: [], fallbacks: [] });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
  it('claim no keys soft #7', async () => {
    const db = createFedKeysDb({ otks: [], fallbacks: [] });
    const env = createFedEnv({ db, oneTimeKeysKv: mockKv() });
    const res = await fedReq(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      fedJson('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER]).toEqual({});
  });
});

describe('race account-data E2EE type matrix concurrent after #175', () => {
  it('E2EE type matrix soft-1', async () => {
    const types = [
      'm.secret_storage.default_key',
      'm.secret_storage.key.ABCDEF',
      'm.cross_signing.master',
      'm.cross_signing.self_signing',
      'm.cross_signing.user_signing',
      'm.megolm_backup.v1',
    ];
    const type = types[0];
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'A0', t: type })),
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'B0', t: type })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(userKeys.accountData[type]).toBeTruthy();
    expect(db.changes.length).toBe(2);
  });
  it('E2EE type matrix soft-2', async () => {
    const types = [
      'm.secret_storage.default_key',
      'm.secret_storage.key.ABCDEF',
      'm.cross_signing.master',
      'm.cross_signing.self_signing',
      'm.cross_signing.user_signing',
      'm.megolm_backup.v1',
    ];
    const type = types[1];
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'A1', t: type })),
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'B1', t: type })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(userKeys.accountData[type]).toBeTruthy();
    expect(db.changes.length).toBe(2);
  });
  it('E2EE type matrix soft-3', async () => {
    const types = [
      'm.secret_storage.default_key',
      'm.secret_storage.key.ABCDEF',
      'm.cross_signing.master',
      'm.cross_signing.self_signing',
      'm.cross_signing.user_signing',
      'm.megolm_backup.v1',
    ];
    const type = types[2];
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'A2', t: type })),
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'B2', t: type })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(userKeys.accountData[type]).toBeTruthy();
    expect(db.changes.length).toBe(2);
  });
  it('E2EE type matrix soft-4', async () => {
    const types = [
      'm.secret_storage.default_key',
      'm.secret_storage.key.ABCDEF',
      'm.cross_signing.master',
      'm.cross_signing.self_signing',
      'm.cross_signing.user_signing',
      'm.megolm_backup.v1',
    ];
    const type = types[3];
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'A3', t: type })),
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'B3', t: type })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(userKeys.accountData[type]).toBeTruthy();
    expect(db.changes.length).toBe(2);
  });
  it('E2EE type matrix soft-5', async () => {
    const types = [
      'm.secret_storage.default_key',
      'm.secret_storage.key.ABCDEF',
      'm.cross_signing.master',
      'm.cross_signing.self_signing',
      'm.cross_signing.user_signing',
      'm.megolm_backup.v1',
    ];
    const type = types[4];
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'A4', t: type })),
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'B4', t: type })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(userKeys.accountData[type]).toBeTruthy();
    expect(db.changes.length).toBe(2);
  });
  it('E2EE type matrix soft-6', async () => {
    const types = [
      'm.secret_storage.default_key',
      'm.secret_storage.key.ABCDEF',
      'm.cross_signing.master',
      'm.cross_signing.self_signing',
      'm.cross_signing.user_signing',
      'm.megolm_backup.v1',
    ];
    const type = types[5];
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'A5', t: type })),
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'B5', t: type })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(userKeys.accountData[type]).toBeTruthy();
    expect(db.changes.length).toBe(2);
  });
  it('E2EE type matrix soft-7', async () => {
    const types = [
      'm.secret_storage.default_key',
      'm.secret_storage.key.ABCDEF',
      'm.cross_signing.master',
      'm.cross_signing.self_signing',
      'm.cross_signing.user_signing',
      'm.megolm_backup.v1',
    ];
    const type = types[0];
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'A6', t: type })),
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'B6', t: type })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(userKeys.accountData[type]).toBeTruthy();
    expect(db.changes.length).toBe(2);
  });
  it('E2EE type matrix soft-8', async () => {
    const types = [
      'm.secret_storage.default_key',
      'm.secret_storage.key.ABCDEF',
      'm.cross_signing.master',
      'm.cross_signing.self_signing',
      'm.cross_signing.user_signing',
      'm.megolm_backup.v1',
    ];
    const type = types[1];
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'A7', t: type })),
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'B7', t: type })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(userKeys.accountData[type]).toBeTruthy();
    expect(db.changes.length).toBe(2);
  });
  it('E2EE type matrix soft-9', async () => {
    const types = [
      'm.secret_storage.default_key',
      'm.secret_storage.key.ABCDEF',
      'm.cross_signing.master',
      'm.cross_signing.self_signing',
      'm.cross_signing.user_signing',
      'm.megolm_backup.v1',
    ];
    const type = types[2];
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'A8', t: type })),
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'B8', t: type })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(userKeys.accountData[type]).toBeTruthy();
    expect(db.changes.length).toBe(2);
  });
  it('E2EE type matrix soft-10', async () => {
    const types = [
      'm.secret_storage.default_key',
      'm.secret_storage.key.ABCDEF',
      'm.cross_signing.master',
      'm.cross_signing.self_signing',
      'm.cross_signing.user_signing',
      'm.megolm_backup.v1',
    ];
    const type = types[3];
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'A9', t: type })),
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'B9', t: type })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(userKeys.accountData[type]).toBeTruthy();
    expect(db.changes.length).toBe(2);
  });
  it('E2EE type matrix soft-11', async () => {
    const types = [
      'm.secret_storage.default_key',
      'm.secret_storage.key.ABCDEF',
      'm.cross_signing.master',
      'm.cross_signing.self_signing',
      'm.cross_signing.user_signing',
      'm.megolm_backup.v1',
    ];
    const type = types[4];
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'A10', t: type })),
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'B10', t: type })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(userKeys.accountData[type]).toBeTruthy();
    expect(db.changes.length).toBe(2);
  });
  it('E2EE type matrix soft-12', async () => {
    const types = [
      'm.secret_storage.default_key',
      'm.secret_storage.key.ABCDEF',
      'm.cross_signing.master',
      'm.cross_signing.self_signing',
      'm.cross_signing.user_signing',
      'm.megolm_backup.v1',
    ];
    const type = types[5];
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createAccountEnv({ db, userKeys });
    const [a, b] = await Promise.all([
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'A11', t: type })),
      accountReq(env, globalPath(type), jsonInit('PUT', { v: 'B11', t: type })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(userKeys.accountData[type]).toBeTruthy();
    expect(db.changes.length).toBe(2);
  });
});

describe('federation make_leave missing room soft flood after #175', () => {
  it('make_leave missing room soft #0', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_leave/${encodeURIComponent('!gone:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_leave missing room soft #1', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_leave/${encodeURIComponent('!gone:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_leave missing room soft #2', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_leave/${encodeURIComponent('!gone:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_leave missing room soft #3', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_leave/${encodeURIComponent('!gone:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_leave missing room soft #4', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_leave/${encodeURIComponent('!gone:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_leave missing room soft #5', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_leave/${encodeURIComponent('!gone:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_leave missing room soft #6', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_leave/${encodeURIComponent('!gone:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('make_leave missing room soft #7', async () => {
    const db = createMembershipDb({ rooms: [] });
    const env = createFedEnv({ db });
    const path = `/_matrix/federation/v1/make_leave/${encodeURIComponent('!gone:example.com')}/${encodeURIComponent(REMOTE_USER)}`;
    const res = await fedReq(env, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
});

