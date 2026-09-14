/**
 * TOKENMAXX HEAVY leftovers after #153 — presence/receipts/typing/to-device soft/edge/reliability.
 * Complements presence/receipts/typing/to-device route suites. Tests-only — no product inventing.
 * Fixtures use example.com only.
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
import receiptsApp from '../src/api/receipts';
import typingApp from '../src/api/typing';
import toDeviceApp from '../src/api/to-device';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const SERVER = 'example.com';
const ROOM = '!r:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const USER_ENC = encodeURIComponent(USER);
const BOB_ENC = encodeURIComponent(BOB);
const EVENT = '$event1:example.com';
const EVENT_TYPE = 'm.room_key_request';
const NOW = 1_700_000_000_000;
const PRESENCE_TIMEOUT = 5 * 60 * 1000;

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type SqlCall = { sql: string; args: unknown[] };
type Membership = { room_id: string; user_id: string; membership: string };
type RoomFetch = { url: string; method: string; body?: unknown };
type AccountDataRow = { user_id: string; room_id: string; event_type: string; content: string };
type PresenceRow = { user_id: string; presence: string; status_msg: string | null; last_active_ts: number };
type DeviceRow = { user_id: string; device_id: string };
type TxnRow = { user_id: string; txn_id: string; response: string };

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
  return kv as unknown as KVNamespace & { data: Record<string, string>; puts: KvPut[] };
}

function createRoomDOStub() {
  const fetches: RoomFetch[] = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      fetches.push({ url: req.url, method: req.method, body });
      return Response.json({ ok: true, user_ids: [] });
    },
  };
}

type RoomDOStub = ReturnType<typeof createRoomDOStub>;

function createFederationStub() {
  const fetches: RoomFetch[] = [];
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
  const selects: SqlCall[] = [];
  const runs: SqlCall[] = [];
  const db = {
    users,
    presence,
    memberships,
    inserts,
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
              if (sql.includes('FROM presence') && sql.includes('WHERE user_id = ?') && !sql.includes('INSERT')) {
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
              if (sql.includes('SUBSTR(rm2.user_id') && sql.includes('room_memberships rm1')) {
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
                return { results: [...servers].map((server_name) => ({ server_name })) } as { results: T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
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

function presenceEnv(db: PresenceDb, cache = mockKv(), fed = createFederationStub()) {
  return {
    DB: db as unknown as D1Database,
    CACHE: cache,
    SERVER_NAME: SERVER,
    FEDERATION: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => fed,
    },
    _db: db,
    _cache: cache,
    _fed: fed,
  } as unknown as Env & { _db: PresenceDb; _cache: ReturnType<typeof mockKv>; _fed: ReturnType<typeof createFederationStub> };
}

async function presenceRequest(env: Env, path: string, init: RequestInit = {}) {
  const res = await presenceApp.request(`http://localhost${path}`, init, env);
  let body: any = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function createReceiptsDb(opts: { memberships?: Membership[]; accountData?: AccountDataRow[] } = {}) {
  const memberships = opts.memberships ?? [];
  const accountData = opts.accountData ?? [];
  const inserts: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const db = {
    memberships,
    accountData,
    inserts,
    selects,
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
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 140)}`);
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO account_data')) {
                inserts.push({ sql, args });
                const [userId, roomId, content] = args as [string, string, string];
                const eventType = 'm.fully_read';
                const idx = accountData.findIndex(
                  (a) => a.user_id === userId && a.room_id === roomId && a.event_type === eventType
                );
                const row: AccountDataRow = { user_id: userId, room_id: roomId, event_type: eventType, content };
                if (idx >= 0) accountData[idx] = row;
                else accountData.push(row);
                return { success: true, meta: { changes: 1, last_row_id: 1 } };
              }
              throw new Error(`Unhandled run() SQL: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
  return db;
}

type ReceiptsDb = ReturnType<typeof createReceiptsDb>;

function receiptsEnv(db: ReceiptsDb, roomDO = createRoomDOStub()) {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    ROOMS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => roomDO,
    },
    _db: db,
    _roomDO: roomDO,
  } as unknown as Env & { _db: ReceiptsDb; _roomDO: RoomDOStub };
}

async function receiptsRequest(env: Env, path: string, init: RequestInit = {}) {
  const res = await receiptsApp.request(`http://localhost${path}`, init, env);
  let body: any = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function createTypingDb(opts: { memberships?: Membership[] } = {}) {
  const memberships = opts.memberships ?? [];
  const selects: SqlCall[] = [];
  return {
    memberships,
    selects,
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
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 140)}`);
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              throw new Error(`Unexpected run() SQL: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
}

type TypingDb = ReturnType<typeof createTypingDb>;

function typingEnv(db: TypingDb, roomDO = createRoomDOStub()) {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    ROOMS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => roomDO,
    },
    _db: db,
    _roomDO: roomDO,
  } as unknown as Env & { _db: TypingDb; _roomDO: RoomDOStub };
}

async function typingRequest(env: Env, path: string, init: RequestInit = {}) {
  const res = await typingApp.request(`http://localhost${path}`, init, env);
  let body: any = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function createToDeviceDb(opts: {
  streamPositions?: Record<string, number>;
  missingStreamRow?: boolean;
  devices?: DeviceRow[];
  transactions?: TxnRow[];
} = {}) {
  const streamPositions = { ...(opts.streamPositions ?? { to_device: 10 }) };
  const missingStreamRow = opts.missingStreamRow ?? false;
  const devices = opts.devices ?? [];
  const transactions = opts.transactions ?? [];
  const messages: any[] = [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const db = {
    streamPositions,
    devices,
    transactions,
    messages,
    inserts,
    updates,
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('FROM transaction_ids') && sql.includes('SELECT response')) {
                const [userId, txnId] = args as string[];
                const row = transactions.find((t) => t.user_id === userId && t.txn_id === txnId);
                return (row ? { response: row.response } : null) as T;
              }
              if (sql.includes('UPDATE stream_positions') && sql.includes('RETURNING position')) {
                updates.push({ sql, args });
                const streamName = args[0] as string;
                if (missingStreamRow || !(streamName in streamPositions)) return null as T;
                streamPositions[streamName] = (streamPositions[streamName] ?? 0) + 1;
                return { position: streamPositions[streamName] } as T;
              }
              if (sql.includes('INSERT INTO stream_positions') && sql.includes('RETURNING position')) {
                inserts.push({ sql, args });
                const streamName = args[0] as string;
                if (!(streamName in streamPositions)) streamPositions[streamName] = 1;
                else streamPositions[streamName] += 1;
                return { position: streamPositions[streamName] } as T;
              }
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 160)}`);
            },
            async all<T>() {
              selects.push({ sql, args });
              if (sql.includes('SELECT device_id FROM devices')) {
                const userId = args[0] as string;
                return {
                  results: devices.filter((d) => d.user_id === userId).map((d) => ({ device_id: d.device_id })),
                } as { results: T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO to_device_messages')) {
                inserts.push({ sql, args });
                const [
                  recipientUserId,
                  recipientDeviceId,
                  senderUserId,
                  eventType,
                  content,
                  messageId,
                  streamPosition,
                ] = args as [string, string, string, string, string, string, number];
                messages.push({
                  recipient_user_id: recipientUserId,
                  recipient_device_id: recipientDeviceId,
                  sender_user_id: senderUserId,
                  event_type: eventType,
                  content,
                  message_id: messageId,
                  stream_position: streamPosition,
                });
                return { success: true, meta: { changes: 1, last_row_id: 1 } };
              }
              if (sql.includes('INSERT INTO transaction_ids')) {
                inserts.push({ sql, args });
                const [userId, txnId] = args as [string, string];
                if (!transactions.some((t) => t.user_id === userId && t.txn_id === txnId)) {
                  transactions.push({ user_id: userId, txn_id: txnId, response: '{}' });
                }
                return { success: true, meta: { changes: 1, last_row_id: 1 } };
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

type ToDeviceDb = ReturnType<typeof createToDeviceDb>;

function toDeviceEnv(db: ToDeviceDb) {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    _db: db,
  } as unknown as Env & { _db: ToDeviceDb };
}

async function toDeviceRequest(env: Env, path: string, init: RequestInit = {}) {
  const res = await toDeviceApp.request(`http://localhost${path}`, init, env);
  let body: any = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
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

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('presence leftovers PUT soft flood after #153', () => {
  it('PUT presence online soft-0', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'online', status_msg: 'msg-0' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('online');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('online');
    expect(cached.status_msg).toBe('msg-0');
  });
  it('PUT presence offline soft-1', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'offline', status_msg: 'msg-1' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('offline');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('offline');
    expect(cached.status_msg).toBe('msg-1');
  });
  it('PUT presence unavailable soft-2', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'unavailable', status_msg: 'msg-2' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('unavailable');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('unavailable');
    expect(cached.status_msg).toBe('msg-2');
  });
  it('PUT presence online soft-3', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'online', status_msg: 'msg-3' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('online');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('online');
    expect(cached.status_msg).toBe('msg-3');
  });
  it('PUT presence offline soft-4', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'offline', status_msg: 'msg-4' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('offline');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('offline');
    expect(cached.status_msg).toBe('msg-4');
  });
  it('PUT presence unavailable soft-5', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'unavailable', status_msg: 'msg-5' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('unavailable');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('unavailable');
    expect(cached.status_msg).toBe('msg-5');
  });
  it('PUT presence online soft-6', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'online', status_msg: 'msg-6' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('online');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('online');
    expect(cached.status_msg).toBe('msg-6');
  });
  it('PUT presence offline soft-7', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'offline', status_msg: 'msg-7' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('offline');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('offline');
    expect(cached.status_msg).toBe('msg-7');
  });
  it('PUT presence unavailable soft-8', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'unavailable', status_msg: 'msg-8' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('unavailable');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('unavailable');
    expect(cached.status_msg).toBe('msg-8');
  });
  it('PUT presence online soft-9', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'online', status_msg: 'msg-9' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('online');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('online');
    expect(cached.status_msg).toBe('msg-9');
  });
  it('PUT presence offline soft-10', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'offline', status_msg: 'msg-10' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('offline');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('offline');
    expect(cached.status_msg).toBe('msg-10');
  });
  it('PUT presence unavailable soft-11', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'unavailable', status_msg: 'msg-11' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('unavailable');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('unavailable');
    expect(cached.status_msg).toBe('msg-11');
  });
  it('PUT presence online soft-12', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'online', status_msg: 'msg-12' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('online');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('online');
    expect(cached.status_msg).toBe('msg-12');
  });
  it('PUT presence offline soft-13', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'offline', status_msg: 'msg-13' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('offline');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('offline');
    expect(cached.status_msg).toBe('msg-13');
  });
  it('PUT presence unavailable soft-14', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'unavailable', status_msg: 'msg-14' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('unavailable');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('unavailable');
    expect(cached.status_msg).toBe('msg-14');
  });
  it('PUT presence online soft-15', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'online', status_msg: 'msg-15' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('online');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('online');
    expect(cached.status_msg).toBe('msg-15');
  });
  it('PUT presence offline soft-16', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'offline', status_msg: 'msg-16' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('offline');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('offline');
    expect(cached.status_msg).toBe('msg-16');
  });
  it('PUT presence unavailable soft-17', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'unavailable', status_msg: 'msg-17' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('unavailable');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('unavailable');
    expect(cached.status_msg).toBe('msg-17');
  });
  it('PUT presence online soft-18', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'online', status_msg: 'msg-18' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('online');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('online');
    expect(cached.status_msg).toBe('msg-18');
  });
  it('PUT presence offline soft-19', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'offline', status_msg: 'msg-19' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('offline');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('offline');
    expect(cached.status_msg).toBe('msg-19');
  });
  it('PUT presence unavailable soft-20', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'unavailable', status_msg: 'msg-20' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('unavailable');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('unavailable');
    expect(cached.status_msg).toBe('msg-20');
  });
  it('PUT presence online soft-21', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'online', status_msg: 'msg-21' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('online');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('online');
    expect(cached.status_msg).toBe('msg-21');
  });
  it('PUT presence offline soft-22', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'offline', status_msg: 'msg-22' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('offline');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('offline');
    expect(cached.status_msg).toBe('msg-22');
  });
  it('PUT presence unavailable soft-23', async () => {
    const db = createPresenceDb();
    const cache = mockKv();
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'unavailable', status_msg: 'msg-23' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.presence[0].presence).toBe('unavailable');
    expect(cache.puts[0].options?.expirationTtl).toBe(300);
    const cached = JSON.parse(cache.data[`presence:${USER}`]);
    expect(cached.presence).toBe('unavailable');
    expect(cached.status_msg).toBe('msg-23');
  });
});
describe('presence leftovers GET soft reliability after #153', () => {
  it('GET presence from KV soft-0', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's0',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s0');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-1', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's1',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s1');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-2', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's2',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s2');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-3', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's3',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s3');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-4', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's4',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s4');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-5', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's5',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s5');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-6', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's6',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s6');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-7', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's7',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s7');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-8', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's8',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s8');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-9', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's9',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s9');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-10', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's10',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s10');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-11', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's11',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s11');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-12', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's12',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s12');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-13', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's13',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s13');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-14', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's14',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s14');
    expect(body.currently_active).toBe(true);
  });
  it('GET presence from KV soft-15', async () => {
    const db = createPresenceDb({ users: [USER] });
    const cache = mockKv({
      [`presence:${USER}`]: JSON.stringify({
        presence: 'online',
        status_msg: 's15',
        last_active_ts: NOW - 1000,
      }),
    });
    const env = presenceEnv(db, cache);
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('online');
    expect(body.status_msg).toBe('s15');
    expect(body.currently_active).toBe(true);
  });
});
describe('presence leftovers failure edges after #153', () => {
  it('PUT forbids other user', async () => {
    const env = presenceEnv(createPresenceDb());
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${BOB_ENC}/status`,
      jsonInit('PUT', { presence: 'online' })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('PUT bad JSON', async () => {
    const env = presenceEnv(createPresenceDb());
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('PUT invalid presence state', async () => {
    const env = presenceEnv(createPresenceDb());
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'busy' })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('PUT missing presence', async () => {
    const env = presenceEnv(createPresenceDb());
    const { status, body } = await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { status_msg: 'x' })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('GET unknown user 404', async () => {
    const env = presenceEnv(createPresenceDb({ users: [USER] }));
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${BOB_ENC}/status`);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('GET defaults offline when no presence', async () => {
    const env = presenceEnv(createPresenceDb({ users: [USER], presence: [] }));
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body).toEqual({ presence: 'offline', currently_active: false });
  });

  it('GET stale online becomes unavailable', async () => {
    const db = createPresenceDb({
      users: [USER],
      presence: [{ user_id: USER, presence: 'online', status_msg: null, last_active_ts: NOW - PRESENCE_TIMEOUT - 1 }],
    });
    const env = presenceEnv(db, mockKv());
    const { status, body } = await presenceRequest(env, `/_matrix/client/v3/presence/${USER_ENC}/status`);
    expect(status).toBe(200);
    expect(body.presence).toBe('unavailable');
    expect(body.currently_active).toBe(false);
  });

  it('PUT empty status_msg stores null', async () => {
    const db = createPresenceDb();
    const env = presenceEnv(db);
    await presenceRequest(
      env,
      `/_matrix/client/v3/presence/${USER_ENC}/status`,
      jsonInit('PUT', { presence: 'online', status_msg: '' })
    );
    expect(db.presence[0].status_msg).toBeNull();
  });
});

describe('receipts leftovers POST soft flood after #153', () => {
  it('POST m.read soft-0', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e0:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-1', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e1:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-2', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e2:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-3', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e3:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-4', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e4:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-5', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e5:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-6', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e6:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-7', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e7:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-8', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e8:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-9', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e9:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-10', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e10:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-11', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e11:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-12', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e12:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-13', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e13:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-14', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e14:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-15', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e15:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-16', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e16:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-17', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e17:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-18', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e18:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.read soft-19', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$e19:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).event_id).toBe(eventId);
    expect(db.accountData[0].content).toContain(eventId);
  });
  it('POST m.fully_read soft-0', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$fr0:example.com`;
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.fully_read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(0);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eventId);
  });
  it('POST m.fully_read soft-1', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$fr1:example.com`;
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.fully_read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(0);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eventId);
  });
  it('POST m.fully_read soft-2', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$fr2:example.com`;
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.fully_read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(0);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eventId);
  });
  it('POST m.fully_read soft-3', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$fr3:example.com`;
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.fully_read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(0);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eventId);
  });
  it('POST m.fully_read soft-4', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$fr4:example.com`;
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.fully_read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(0);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eventId);
  });
  it('POST m.fully_read soft-5', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$fr5:example.com`;
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.fully_read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(0);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eventId);
  });
  it('POST m.fully_read soft-6', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$fr6:example.com`;
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.fully_read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(0);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eventId);
  });
  it('POST m.fully_read soft-7', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$fr7:example.com`;
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.fully_read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(0);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eventId);
  });
  it('POST m.fully_read soft-8', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$fr8:example.com`;
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.fully_read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(0);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eventId);
  });
  it('POST m.fully_read soft-9', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$fr9:example.com`;
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.fully_read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(0);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eventId);
  });
  it('POST m.fully_read soft-10', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$fr10:example.com`;
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.fully_read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(0);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eventId);
  });
  it('POST m.fully_read soft-11', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eventId = `$fr11:example.com`;
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.fully_read/${encodeURIComponent(eventId)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(0);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eventId);
  });
  it('POST m.read.private soft-0', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read.private/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', { thread_id: `$t0:example.com` })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).thread_id).toBe(`$t0:example.com`);
    expect(db.accountData.length).toBe(0);
  });
  it('POST m.read.private soft-1', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read.private/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', { thread_id: `$t1:example.com` })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).thread_id).toBe(`$t1:example.com`);
    expect(db.accountData.length).toBe(0);
  });
  it('POST m.read.private soft-2', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read.private/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', { thread_id: `$t2:example.com` })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).thread_id).toBe(`$t2:example.com`);
    expect(db.accountData.length).toBe(0);
  });
  it('POST m.read.private soft-3', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read.private/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', { thread_id: `$t3:example.com` })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).thread_id).toBe(`$t3:example.com`);
    expect(db.accountData.length).toBe(0);
  });
  it('POST m.read.private soft-4', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read.private/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', { thread_id: `$t4:example.com` })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).thread_id).toBe(`$t4:example.com`);
    expect(db.accountData.length).toBe(0);
  });
  it('POST m.read.private soft-5', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read.private/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', { thread_id: `$t5:example.com` })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).thread_id).toBe(`$t5:example.com`);
    expect(db.accountData.length).toBe(0);
  });
  it('POST m.read.private soft-6', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read.private/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', { thread_id: `$t6:example.com` })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).thread_id).toBe(`$t6:example.com`);
    expect(db.accountData.length).toBe(0);
  });
  it('POST m.read.private soft-7', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read.private/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', { thread_id: `$t7:example.com` })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).thread_id).toBe(`$t7:example.com`);
    expect(db.accountData.length).toBe(0);
  });
  it('POST m.read.private soft-8', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read.private/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', { thread_id: `$t8:example.com` })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).thread_id).toBe(`$t8:example.com`);
    expect(db.accountData.length).toBe(0);
  });
  it('POST m.read.private soft-9', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read.private/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', { thread_id: `$t9:example.com` })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).thread_id).toBe(`$t9:example.com`);
    expect(db.accountData.length).toBe(0);
  });
  it('POST m.read.private soft-10', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read.private/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', { thread_id: `$t10:example.com` })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).thread_id).toBe(`$t10:example.com`);
    expect(db.accountData.length).toBe(0);
  });
  it('POST m.read.private soft-11', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const { status } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read.private/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', { thread_id: `$t11:example.com` })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches.length).toBe(1);
    expect((roomDO.fetches[0].body as any).thread_id).toBe(`$t11:example.com`);
    expect(db.accountData.length).toBe(0);
  });
});
describe('receipts leftovers read_markers soft flood after #153', () => {
  it('read_markers m.read soft-0', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm0:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-1', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm1:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-2', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm2:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-3', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm3:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-4', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm4:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-5', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm5:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-6', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm6:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-7', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm7:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-8', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm8:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-9', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm9:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-10', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm10:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-11', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm11:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-12', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm12:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-13', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm13:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-14', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm14:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
  it('read_markers m.read soft-15', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = receiptsEnv(db, roomDO);
    const eid = `$rm15:example.com`;
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.read': eid })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches.length).toBe(1);
    expect(JSON.parse(db.accountData[0].content).event_id).toBe(eid);
  });
});
describe('receipts leftovers failure edges after #153', () => {
  it('invalid receipt type', async () => {
    const env = receiptsEnv(
      createReceiptsDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }] })
    );
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.invalid/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('forbids non-join', async () => {
    const env = receiptsEnv(
      createReceiptsDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }] })
    );
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/${encodeURIComponent(EVENT)}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('read_markers bad JSON', async () => {
    const env = receiptsEnv(
      createReceiptsDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }] })
    );
    const { status, body } = await receiptsRequest(env, `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('read_markers forbids missing membership', async () => {
    const env = receiptsEnv(createReceiptsDb({ memberships: [] }));
    const { status, body } = await receiptsRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
      jsonInit('POST', { 'm.fully_read': EVENT })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
});

describe('typing leftovers soft flood after #153', () => {
  it('typing true soft-0', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 10000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-1', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 11000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-2', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 12000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-3', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 13000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-4', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 14000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-5', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 15000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-6', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 16000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-7', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 17000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-8', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 18000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-9', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 19000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-10', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 20000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-11', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 21000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-12', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 22000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-13', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 23000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-14', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 24000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-15', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 25000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-16', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 26000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-17', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 27000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-18', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 28000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing true soft-19', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const timeout = 29000;
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: Math.min(timeout, 120000),
    });
  });
  it('typing false soft-0', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const { status } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: false, timeout: 90000 })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
  it('typing false soft-1', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const { status } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: false, timeout: 90000 })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
  it('typing false soft-2', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const { status } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: false, timeout: 90000 })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
  it('typing false soft-3', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const { status } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: false, timeout: 90000 })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
  it('typing false soft-4', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const { status } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: false, timeout: 90000 })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
  it('typing false soft-5', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const { status } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: false, timeout: 90000 })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
  it('typing false soft-6', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const { status } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: false, timeout: 90000 })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
  it('typing false soft-7', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const { status } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: false, timeout: 90000 })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
  it('typing false soft-8', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const { status } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: false, timeout: 90000 })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
  it('typing false soft-9', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const { status } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: false, timeout: 90000 })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
  it('typing false soft-10', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const { status } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: false, timeout: 90000 })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
  it('typing false soft-11', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = typingEnv(db, roomDO);
    const { status } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: false, timeout: 90000 })
    );
    expect(status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
});
describe('typing leftovers failure edges after #153', () => {
  it('forbids other user', async () => {
    const env = typingEnv(
      createTypingDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }] })
    );
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${BOB_ENC}`,
      jsonInit('PUT', { typing: true })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids non-join', async () => {
    const env = typingEnv(
      createTypingDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }] })
    );
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('bad JSON', async () => {
    const env = typingEnv(
      createTypingDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }] })
    );
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: 'nope',
      }
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('missing typing boolean', async () => {
    const env = typingEnv(
      createTypingDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }] })
    );
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { timeout: 1 })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('typing string rejected', async () => {
    const env = typingEnv(
      createTypingDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }] })
    );
    const { status, body } = await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: 'true' })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('timeout capped at 120000', async () => {
    const roomDO = createRoomDOStub();
    const env = typingEnv(
      createTypingDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }] }),
      roomDO
    );
    await typingRequest(
      env,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
      jsonInit('PUT', { typing: true, timeout: 999999 })
    );
    expect((roomDO.fetches[0].body as any).timeout).toBe(120000);
  });
});

describe('to-device leftovers soft flood after #153', () => {
  it('sendToDevice specific device soft-0', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-0`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV0: { n: 0 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV0');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-1', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-1`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV1: { n: 1 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV1');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-2', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-2`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV2: { n: 2 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV2');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-3', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-3`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV3: { n: 3 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV3');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-4', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-4`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV4: { n: 4 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV4');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-5', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-5`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV5: { n: 5 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV5');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-6', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-6`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV6: { n: 6 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV6');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-7', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-7`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV7: { n: 7 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV7');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-8', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-8`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV8: { n: 8 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV8');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-9', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-9`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV9: { n: 9 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV9');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-10', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-10`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV10: { n: 10 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV10');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-11', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-11`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV11: { n: 11 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV11');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-12', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-12`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV12: { n: 12 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV12');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-13', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-13`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV13: { n: 13 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV13');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-14', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-14`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV14: { n: 14 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV14');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-15', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-15`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV15: { n: 15 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV15');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-16', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-16`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV16: { n: 16 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV16');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-17', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-17`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV17: { n: 17 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV17');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-18', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-18`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV18: { n: 18 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV18');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-19', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-19`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV19: { n: 19 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV19');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-20', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-20`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV20: { n: 20 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV20');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-21', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-21`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV21: { n: 21 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV21');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-22', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-22`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV22: { n: 22 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV22');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice specific device soft-23', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const txn = `txn-23`;
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/${txn}`,
      jsonInit('PUT', { messages: { [BOB]: { DEV23: { n: 23 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(1);
    expect(db.messages[0].recipient_device_id).toBe('DEV23');
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
  });
  it('sendToDevice star expand soft-0', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A0' },
        { user_id: BOB, device_id: 'B0' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-0`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 0 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A0', 'B0']);
  });
  it('sendToDevice star expand soft-1', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A1' },
        { user_id: BOB, device_id: 'B1' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-1`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 1 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A1', 'B1']);
  });
  it('sendToDevice star expand soft-2', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A2' },
        { user_id: BOB, device_id: 'B2' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-2`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 2 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A2', 'B2']);
  });
  it('sendToDevice star expand soft-3', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A3' },
        { user_id: BOB, device_id: 'B3' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-3`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 3 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A3', 'B3']);
  });
  it('sendToDevice star expand soft-4', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A4' },
        { user_id: BOB, device_id: 'B4' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-4`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 4 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A4', 'B4']);
  });
  it('sendToDevice star expand soft-5', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A5' },
        { user_id: BOB, device_id: 'B5' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-5`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 5 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A5', 'B5']);
  });
  it('sendToDevice star expand soft-6', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A6' },
        { user_id: BOB, device_id: 'B6' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-6`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 6 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A6', 'B6']);
  });
  it('sendToDevice star expand soft-7', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A7' },
        { user_id: BOB, device_id: 'B7' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-7`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 7 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A7', 'B7']);
  });
  it('sendToDevice star expand soft-8', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A8' },
        { user_id: BOB, device_id: 'B8' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-8`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 8 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A8', 'B8']);
  });
  it('sendToDevice star expand soft-9', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A9' },
        { user_id: BOB, device_id: 'B9' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-9`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 9 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A9', 'B9']);
  });
  it('sendToDevice star expand soft-10', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A10' },
        { user_id: BOB, device_id: 'B10' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-10`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 10 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A10', 'B10']);
  });
  it('sendToDevice star expand soft-11', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A11' },
        { user_id: BOB, device_id: 'B11' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-11`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 11 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A11', 'B11']);
  });
  it('sendToDevice star expand soft-12', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A12' },
        { user_id: BOB, device_id: 'B12' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-12`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 12 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A12', 'B12']);
  });
  it('sendToDevice star expand soft-13', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A13' },
        { user_id: BOB, device_id: 'B13' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-13`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 13 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A13', 'B13']);
  });
  it('sendToDevice star expand soft-14', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A14' },
        { user_id: BOB, device_id: 'B14' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-14`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 14 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A14', 'B14']);
  });
  it('sendToDevice star expand soft-15', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'A15' },
        { user_id: BOB, device_id: 'B15' },
      ],
    });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/star-15`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { x: 15 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(2);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['A15', 'B15']);
  });
});
describe('to-device leftovers failure and idempotency after #153', () => {
  it('returns cached txn response', async () => {
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: 'cached', response: '{"ok":true}' }],
    });
    const env = toDeviceEnv(db);
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/cached`,
      jsonInit('PUT', { messages: { [BOB]: { D: { a: 1 } } } })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(db.messages.length).toBe(0);
  });

  it('bad JSON', async () => {
    const env = toDeviceEnv(createToDeviceDb());
    const { status, body } = await toDeviceRequest(env, `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/t`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('missing messages', async () => {
    const env = toDeviceEnv(createToDeviceDb());
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/t2`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('null messages', async () => {
    const env = toDeviceEnv(createToDeviceDb());
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/t3`,
      jsonInit('PUT', { messages: null })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('empty messages succeeds', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const { status, body } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/empty`,
      jsonInit('PUT', { messages: {} })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.messages.length).toBe(0);
    expect(db.transactions.length).toBe(1);
  });

  it('missing stream row uses upsert path', async () => {
    const db = createToDeviceDb({ missingStreamRow: true, streamPositions: {} });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/upsert`,
      jsonInit('PUT', { messages: { [BOB]: { D1: { z: 1 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages[0].stream_position).toBe(1);
  });

  it('star with no devices inserts nothing', async () => {
    const db = createToDeviceDb({ devices: [] });
    const env = toDeviceEnv(db);
    const { status } = await toDeviceRequest(
      env,
      `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/nostar`,
      jsonInit('PUT', { messages: { [BOB]: { '*': { a: 1 } } } })
    );
    expect(status).toBe(200);
    expect(db.messages.length).toBe(0);
  });

  it('second same txn returns cached without reinsert', async () => {
    const db = createToDeviceDb();
    const env = toDeviceEnv(db);
    const path = `/_matrix/client/v3/sendToDevice/${EVENT_TYPE}/dup`;
    const body = { messages: { [BOB]: { D: { x: 1 } } } };
    const first = await toDeviceRequest(env, path, jsonInit('PUT', body));
    const second = await toDeviceRequest(env, path, jsonInit('PUT', body));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.messages.length).toBe(1);
  });
});
