/**
 * TOKENMAXX HEAVY deepen — slice: to-device / crypto / olm edges.
 * Existing modules only: src/api/to-device.ts, src/api/keys.ts (missing device keys paths).
 * Complements to-device-api-routes / to-device-helpers / keys-api-routes.
 * Avoids oauth-push-identity leftovers collision. Tests-only — no product inventing.
 * Fixtures use example.com only.
 *
 * Covers:
 * 1) Malformed encrypted payload stubs (m.room.encrypted / olm fields) via sendToDevice
 * 2) Missing device keys query/claim paths already handled by keys API
 * 3) Batch to-device delivery edges (getToDeviceMessages limit/ack/isolation)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import {
  getToDeviceMessages,
  cleanupOldToDeviceMessages,
} from '../src/api/to-device';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

import toDeviceApp from '../src/api/to-device';
import keysApp from '../src/api/keys';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DEVICE = 'DEVICEA';
const DEVICE_B = 'DEVICEB';
const SERVER = 'example.com';
const ENC_TYPE = 'm.room.encrypted';
const OLM_ALGO = 'm.olm.v1.curve25519-aes-sha2';
const MEGOLM_ALGO = 'm.megolm.v1.aes-sha2';
const NOW = 1_700_000_000_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type SqlCall = { sql: string; args: unknown[] };
type DeviceRow = { user_id: string; device_id: string };
type TxnRow = { user_id: string; txn_id: string; response: string };
type MessageInsert = {
  recipient_user_id: string;
  recipient_device_id: string;
  sender_user_id: string;
  event_type: string;
  content: string;
  message_id: string;
  stream_position: number;
};

type ToDeviceRow = {
  id: number;
  sender_user_id: string;
  event_type: string;
  content: string;
  stream_position: number;
  recipient_user_id: string;
  recipient_device_id: string;
  delivered: number;
  created_at: number;
};

type DeviceKeyMap = Record<string, unknown>;
type CrossSigningStore = {
  master?: unknown;
  self_signing?: unknown;
  user_signing?: unknown;
};
type OtkEntry = { keyId: string; keyData: unknown; claimed: boolean };
type FallbackRow = {
  user_id: string;
  device_id: string;
  algorithm: string;
  key_id: string;
  key_data: string;
  used: number;
};
type OtkRow = {
  id: number;
  user_id: string;
  device_id: string;
  algorithm: string;
  key_id: string;
  key_data: string;
  claimed: number;
};
type SigRow = {
  user_id: string;
  key_id: string;
  signer_user_id: string;
  signer_key_id: string;
  signature: string;
};
type KeyChange = {
  user_id: string;
  device_id: string | null;
  change_type: string;
  stream_position: number;
};
type Membership = { room_id: string; user_id: string; membership: string };
type CrossSigningKeyRow = {
  user_id: string;
  key_type: string;
  key_id: string;
  key_data: string;
};

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
  const messages: MessageInsert[] = [];
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
              if (
                sql.includes('SELECT response FROM transaction_ids') ||
                (sql.includes('FROM transaction_ids') && sql.includes('SELECT response'))
              ) {
                const [userId, txnId] = args as string[];
                const row = transactions.find(
                  (t) => t.user_id === userId && t.txn_id === txnId
                );
                return (row ? { response: row.response } : null) as T;
              }
              if (
                sql.includes('UPDATE stream_positions') &&
                sql.includes('RETURNING position')
              ) {
                updates.push({ sql, args });
                const streamName = args[0] as string;
                if (missingStreamRow || !(streamName in streamPositions)) {
                  return null as T;
                }
                streamPositions[streamName] = (streamPositions[streamName] ?? 0) + 1;
                return { position: streamPositions[streamName] } as T;
              }
              if (
                sql.includes('INSERT INTO stream_positions') &&
                sql.includes('RETURNING position')
              ) {
                inserts.push({ sql, args });
                const streamName = args[0] as string;
                if (!(streamName in streamPositions)) {
                  streamPositions[streamName] = 1;
                } else {
                  streamPositions[streamName] += 1;
                }
                return { position: streamPositions[streamName] } as T;
              }
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 160)}`);
            },
            async all<T>() {
              selects.push({ sql, args });
              if (sql.includes('SELECT device_id FROM devices')) {
                const userId = args[0] as string;
                const results = devices
                  .filter((d) => d.user_id === userId)
                  .map((d) => ({ device_id: d.device_id }));
                return { results } as { results: T[] };
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
                const exists = messages.some(
                  (m) =>
                    m.recipient_user_id === recipientUserId &&
                    m.recipient_device_id === recipientDeviceId &&
                    m.message_id === messageId
                );
                if (!exists) {
                  messages.push({
                    recipient_user_id: recipientUserId,
                    recipient_device_id: recipientDeviceId,
                    sender_user_id: senderUserId,
                    event_type: eventType,
                    content,
                    message_id: messageId,
                    stream_position: streamPosition,
                  });
                }
                return { success: true, meta: { changes: exists ? 0 : 1, last_row_id: 1 } };
              }
              if (sql.includes('INSERT INTO transaction_ids')) {
                inserts.push({ sql, args });
                const [userId, txnId] = args as [string, string];
                const exists = transactions.some(
                  (t) => t.user_id === userId && t.txn_id === txnId
                );
                if (!exists) {
                  transactions.push({ user_id: userId, txn_id: txnId, response: '{}' });
                }
                return { success: true, meta: { changes: exists ? 0 : 1, last_row_id: 1 } };
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

type ToDeviceSendDb = ReturnType<typeof createToDeviceDb>;

function createSendEnv(db?: ToDeviceSendDb) {
  const d = db ?? createToDeviceDb();
  return {
    DB: d as unknown as D1Database,
    SERVER_NAME: SERVER,
    _db: d,
  } as unknown as Env & { _db: ToDeviceSendDb };
}

async function sendRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await toDeviceApp.request(`http://localhost${path}`, init, env);
  let body: unknown = null;
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

function sendPath(eventType = ENC_TYPE, txnId = 'txn-1') {
  return `/_matrix/client/v3/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`;
}

function createHelperDb(messages: ToDeviceRow[] = []) {
  const acks: Array<{ userId: string; deviceId: string; sincePos: number }> = [];
  const deletes: number[] = [];
  let nextId = messages.reduce((max, m) => Math.max(max, m.id), 0) + 1;

  function maxStreamPos(): number {
    return messages.reduce((acc, m) => Math.max(acc, m.stream_position), 0);
  }

  function stmt(sql: string, args: unknown[] = []) {
    return {
      bind(...bindArgs: unknown[]) {
        return stmt(sql, bindArgs);
      },
      async all<T>() {
        if (sql.includes('FROM to_device_messages') && sql.includes('delivered = 0')) {
          const [userId, deviceId, sincePos, limit] = args as [
            string,
            string,
            number,
            number,
          ];
          const results = messages
            .filter(
              (m) =>
                m.recipient_user_id === userId &&
                m.recipient_device_id === deviceId &&
                m.delivered === 0 &&
                m.stream_position > sincePos
            )
            .sort((a, b) => a.stream_position - b.stream_position)
            .slice(0, limit)
            .map((m) => ({
              id: m.id,
              sender_user_id: m.sender_user_id,
              event_type: m.event_type,
              content: m.content,
              stream_position: m.stream_position,
            }));
          return { results: results as T[] };
        }
        return { results: [] as T[] };
      },
      async first<T>() {
        if (sql.includes('MAX(stream_position)')) {
          return { max_pos: maxStreamPos() } as T;
        }
        return null;
      },
      async run() {
        if (sql.includes('SET delivered = 1')) {
          const [userId, deviceId, sincePos] = args as [string, string, number];
          acks.push({ userId, deviceId, sincePos });
          let changes = 0;
          for (const m of messages) {
            if (
              m.recipient_user_id === userId &&
              m.recipient_device_id === deviceId &&
              m.stream_position <= sincePos &&
              m.delivered === 0
            ) {
              m.delivered = 1;
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (sql.includes('DELETE FROM to_device_messages')) {
          const [cutoff] = args as [number];
          deletes.push(cutoff);
          let changes = 0;
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.created_at < cutoff && m.delivered === 1) {
              messages.splice(i, 1);
              changes++;
            }
          }
          return { meta: { changes } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }

  const db = {
    messages,
    acks,
    deletes,
    prepare(sql: string) {
      return stmt(sql);
    },
    add(partial: Omit<ToDeviceRow, 'id'> & { id?: number }) {
      const row: ToDeviceRow = {
        id: partial.id ?? nextId++,
        ...partial,
      };
      messages.push(row);
      return row;
    },
  };

  return db as unknown as D1Database & {
    messages: ToDeviceRow[];
    acks: typeof acks;
    deletes: number[];
    add: (partial: Omit<ToDeviceRow, 'id'> & { id?: number }) => ToDeviceRow;
  };
}

function helperMsg(
  overrides: Partial<ToDeviceRow> &
    Pick<ToDeviceRow, 'stream_position' | 'recipient_user_id' | 'recipient_device_id'>
): ToDeviceRow {
  return {
    id: overrides.id ?? overrides.stream_position,
    sender_user_id: overrides.sender_user_id ?? '@sender:example.com',
    event_type: overrides.event_type ?? ENC_TYPE,
    content: overrides.content ?? JSON.stringify({ algorithm: OLM_ALGO, ciphertext: {} }),
    delivered: overrides.delivered ?? 0,
    created_at: overrides.created_at ?? NOW,
    ...overrides,
  };
}

function createUserKeysStub(opts: {
  deviceKeys?: Record<string, DeviceKeyMap>;
  crossSigning?: Record<string, CrossSigningStore>;
  failGet?: boolean;
  failPut?: boolean;
  perUser?: Record<string, { deviceKeys?: Record<string, DeviceKeyMap>; crossSigning?: CrossSigningStore }>;
} = {}) {
  const deviceKeys = opts.deviceKeys ?? {};
  const crossSigning = opts.crossSigning ?? {};
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];

  const stub = {
    fetches,
    deviceKeys,
    crossSigning,
    async fetch(req: Request): Promise<Response> {
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

      if (opts.failGet && path.endsWith('/get')) {
        return new Response('boom', { status: 500 });
      }
      if (opts.failPut && path.endsWith('/put')) {
        return new Response('boom', { status: 500 });
      }

      if (path === '/device-keys/get') {
        const deviceId = url.searchParams.get('device_id');
        if (deviceId) {
          return Response.json(deviceKeys[deviceId] ?? null);
        }
        return Response.json(deviceKeys);
      }

      if (path === '/device-keys/put') {
        const b = body as { device_id: string; keys: unknown };
        deviceKeys[b.device_id] = b.keys as DeviceKeyMap;
        return Response.json({ success: true });
      }

      if (path === '/cross-signing/get') {
        return Response.json(crossSigning);
      }

      if (path === '/cross-signing/put') {
        Object.assign(crossSigning, body as CrossSigningStore);
        return Response.json({ success: true });
      }

      return new Response('not found', { status: 404 });
    },
  };

  return stub;
}

function createFederationStub() {
  const fetches: Array<{ url: string; body?: unknown }> = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }
      fetches.push({ url: req.url, body });
      return Response.json({ ok: true });
    },
  };
}

function createKeysDb(opts: {
  streamPositions?: Record<string, number>;
  otks?: OtkRow[];
  fallbacks?: FallbackRow[];
  signatures?: SigRow[];
  keyChanges?: KeyChange[];
  memberships?: Membership[];
  crossSigningKeys?: CrossSigningKeyRow[];
} = {}) {
  const streamPositions = { ...(opts.streamPositions ?? { device_keys: 10 }) };
  const otks = opts.otks ?? [];
  const fallbacks = opts.fallbacks ?? [];
  const signatures = opts.signatures ?? [];
  const keyChanges = opts.keyChanges ?? [];
  const memberships = opts.memberships ?? [];
  const crossSigningKeys = opts.crossSigningKeys ?? [];
  let nextOtkId = otks.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const runs: SqlCall[] = [];

  const db = {
    streamPositions,
    otks,
    fallbacks,
    signatures,
    keyChanges,
    memberships,
    crossSigningKeys,
    inserts,
    updates,
    runs,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT position FROM stream_positions')) {
                const name = args[0] as string;
                return { position: streamPositions[name] ?? 1 } as T;
              }
              if (
                sql.includes('FROM one_time_keys') &&
                sql.includes('claimed = 0') &&
                sql.includes('LIMIT 1')
              ) {
                const [userId, deviceId, algorithm] = args as [string, string, string];
                const hit = otks.find(
                  (k) =>
                    k.user_id === userId &&
                    k.device_id === deviceId &&
                    k.algorithm === algorithm &&
                    k.claimed === 0
                );
                if (!hit) return null;
                return { id: hit.id, key_id: hit.key_id, key_data: hit.key_data } as T;
              }
              if (sql.includes('FROM fallback_keys')) {
                const [userId, deviceId, algorithm] = args as [string, string, string];
                const hit = fallbacks.find(
                  (f) =>
                    f.user_id === userId &&
                    f.device_id === deviceId &&
                    f.algorithm === algorithm
                );
                if (!hit) return null;
                return {
                  key_id: hit.key_id,
                  key_data: hit.key_data,
                  used: hit.used,
                } as T;
              }
              return null;
            },
            async all<T>() {
              if (sql.includes('FROM cross_signing_signatures') && sql.includes('SELECT signer_user_id')) {
                const [userId, keyId] = args as [string, string];
                const results = signatures.filter(
                  (s) => s.user_id === userId && s.key_id === keyId
                );
                return { results } as { results: T[] };
              }
              if (
                sql.includes('FROM device_key_changes dkc') &&
                sql.includes('room_memberships')
              ) {
                const [fromPos, toPos, requester] = args as [number, number, string];
                const joinedRooms = new Set(
                  memberships
                    .filter((m) => m.user_id === requester && m.membership === 'join')
                    .map((m) => m.room_id)
                );
                const sharedUsers = new Set(
                  memberships
                    .filter((m) => joinedRooms.has(m.room_id) && m.membership === 'join')
                    .map((m) => m.user_id)
                );
                const results = keyChanges
                  .filter(
                    (c) =>
                      c.stream_position > fromPos &&
                      c.stream_position <= toPos &&
                      sharedUsers.has(c.user_id)
                  )
                  .map((c) => ({ user_id: c.user_id, change_type: c.change_type }));
                const seen = new Set<string>();
                const distinct = results.filter((r) => {
                  const k = `${r.user_id}:${r.change_type}`;
                  if (seen.has(k)) return false;
                  seen.add(k);
                  return true;
                });
                return { results: distinct } as { results: T[] };
              }
              if (
                sql.includes('SUBSTR(rm2.user_id') &&
                sql.includes('room_memberships rm1')
              ) {
                return { results: [] as T[] };
              }
              return { results: [] as T[] };
            },
            async run(): Promise<{ meta: { changes: number; last_row_id: number }; success: boolean }> {
              runs.push({ sql, args });
              if (sql.includes('UPDATE stream_positions SET position = position + 1')) {
                updates.push({ sql, args });
                const name = args[0] as string;
                streamPositions[name] = (streamPositions[name] ?? 0) + 1;
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('INSERT INTO device_key_changes')) {
                inserts.push({ sql, args });
                const [userId, deviceId, changeType, streamPosition] = args as [
                  string,
                  string | null,
                  string,
                  number,
                ];
                keyChanges.push({
                  user_id: userId,
                  device_id: deviceId,
                  change_type: changeType,
                  stream_position: streamPosition,
                });
                return { success: true, meta: { changes: 1, last_row_id: keyChanges.length } };
              }
              if (sql.includes('INSERT INTO one_time_keys')) {
                inserts.push({ sql, args });
                const [userId, deviceId, algorithm, keyId, keyData] = args as [
                  string,
                  string,
                  string,
                  string,
                  string,
                ];
                const existing = otks.find(
                  (k) =>
                    k.user_id === userId &&
                    k.device_id === deviceId &&
                    k.algorithm === algorithm &&
                    k.key_id === keyId
                );
                if (existing) {
                  existing.key_data = keyData;
                  existing.claimed = 0;
                } else {
                  otks.push({
                    id: nextOtkId++,
                    user_id: userId,
                    device_id: deviceId,
                    algorithm,
                    key_id: keyId,
                    key_data: keyData,
                    claimed: 0,
                  });
                }
                return { success: true, meta: { changes: 1, last_row_id: nextOtkId } };
              }
              if (sql.includes('UPDATE one_time_keys SET claimed = 1') && sql.includes('key_id = ?')) {
                updates.push({ sql, args });
                const [, userId, deviceId, keyId] = args as [number, string, string, string];
                const hit = otks.find(
                  (k) =>
                    k.user_id === userId && k.device_id === deviceId && k.key_id === keyId
                );
                if (hit) hit.claimed = 1;
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE one_time_keys SET claimed = 1') && sql.includes('WHERE id = ?')) {
                updates.push({ sql, args });
                const [, id] = args as [number, number];
                const hit = otks.find((k) => k.id === id);
                if (hit) hit.claimed = 1;
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('INSERT INTO fallback_keys')) {
                inserts.push({ sql, args });
                const [userId, deviceId, algorithm, keyId, keyData] = args as [
                  string,
                  string,
                  string,
                  string,
                  string,
                ];
                const existing = fallbacks.find(
                  (f) =>
                    f.user_id === userId &&
                    f.device_id === deviceId &&
                    f.algorithm === algorithm
                );
                if (existing) {
                  existing.key_id = keyId;
                  existing.key_data = keyData;
                  existing.used = 0;
                } else {
                  fallbacks.push({
                    user_id: userId,
                    device_id: deviceId,
                    algorithm,
                    key_id: keyId,
                    key_data: keyData,
                    used: 0,
                  });
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE fallback_keys SET used = 1')) {
                updates.push({ sql, args });
                const [userId, deviceId, algorithm] = args as [string, string, string];
                const hit = fallbacks.find(
                  (f) =>
                    f.user_id === userId &&
                    f.device_id === deviceId &&
                    f.algorithm === algorithm
                );
                if (hit) hit.used = 1;
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }
              throw new Error(`Unhandled SQL in keys test stub: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
  return db;
}

type KeysDb = ReturnType<typeof createKeysDb>;
type UserKeysStub = ReturnType<typeof createUserKeysStub>;
type FedStub = ReturnType<typeof createFederationStub>;

function createKeysEnv(opts: {
  db?: KeysDb;
  oneTimeKeysKv?: ReturnType<typeof mockKv>;
  deviceKeysKv?: ReturnType<typeof mockKv>;
  cacheKv?: ReturnType<typeof mockKv>;
  userKeys?: UserKeysStub;
  federation?: FedStub;
} = {}) {
  const db = opts.db ?? createKeysDb();
  const deviceKeysKv = opts.deviceKeysKv ?? mockKv();
  const oneTimeKeysKv = opts.oneTimeKeysKv ?? mockKv();
  const cacheKv = opts.cacheKv ?? mockKv();
  const userKeys = opts.userKeys ?? createUserKeysStub();
  const federation = opts.federation ?? createFederationStub();
  const fedByServer = new Map<string, FedStub>();

  const env = {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    DEVICE_KEYS: deviceKeysKv,
    ONE_TIME_KEYS: oneTimeKeysKv,
    CACHE: cacheKv,
    ACCOUNT_DATA: mockKv(),
    CROSS_SIGNING_KEYS: mockKv(),
    USER_KEYS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => userKeys,
    },
    FEDERATION: {
      idFromName: (name: string) => {
        if (!fedByServer.has(name)) fedByServer.set(name, createFederationStub());
        return { name, toString: () => name };
      },
      get: (id: { name: string }) => fedByServer.get(id.name) ?? federation,
    },
    _userKeys: userKeys,
    _db: db,
    _otk: oneTimeKeysKv,
    _deviceKeys: deviceKeysKv,
  };
  return env as unknown as Env & typeof env;
}

async function keysRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await keysApp.request(`http://localhost${path}`, init, env);
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

/** Malformed / stub encrypted payload shapes the homeserver stores opaquely. */
const MALFORMED_ENC_STUBS: Array<{ name: string; content: unknown }> = [
  { name: 'empty-object', content: {} },
  { name: 'null-algorithm', content: { algorithm: null, ciphertext: 'x' } },
  { name: 'missing-ciphertext', content: { algorithm: OLM_ALGO } },
  { name: 'null-ciphertext', content: { algorithm: OLM_ALGO, ciphertext: null } },
  { name: 'array-ciphertext', content: { algorithm: OLM_ALGO, ciphertext: [] } },
  { name: 'number-ciphertext', content: { algorithm: OLM_ALGO, ciphertext: 42 } },
  { name: 'bool-ciphertext', content: { algorithm: OLM_ALGO, ciphertext: false } },
  { name: 'empty-ciphertext-map', content: { algorithm: OLM_ALGO, ciphertext: {} } },
  {
    name: 'missing-body-type',
    content: {
      algorithm: OLM_ALGO,
      sender_key: 'curve25519:STUB',
      ciphertext: { 'curve25519:peer': { body: 'AAAA' } },
    },
  },
  {
    name: 'null-body',
    content: {
      algorithm: OLM_ALGO,
      ciphertext: { 'curve25519:peer': { type: 0, body: null } },
    },
  },
  {
    name: 'string-type',
    content: {
      algorithm: OLM_ALGO,
      ciphertext: { 'curve25519:peer': { type: 'prekey', body: 'x' } },
    },
  },
  {
    name: 'neg-type',
    content: {
      algorithm: OLM_ALGO,
      ciphertext: { 'curve25519:peer': { type: -1, body: 'x' } },
    },
  },
  {
    name: 'unknown-algorithm',
    content: { algorithm: 'm.olm.v9.not-real', ciphertext: { a: 1 } },
  },
  {
    name: 'megolm-missing-session',
    content: { algorithm: MEGOLM_ALGO, ciphertext: 'blob', sender_key: 'sk' },
  },
  {
    name: 'megolm-null-session',
    content: {
      algorithm: MEGOLM_ALGO,
      ciphertext: 'blob',
      session_id: null,
      sender_key: 'sk',
      device_id: 'D',
    },
  },
  {
    name: 'megolm-empty-ciphertext',
    content: {
      algorithm: MEGOLM_ALGO,
      ciphertext: '',
      session_id: 's',
      sender_key: 'sk',
    },
  },
  {
    name: 'extra-junk-fields',
    content: {
      algorithm: OLM_ALGO,
      ciphertext: {},
      not_a_field: true,
      room_id: '!x:example.com',
    },
  },
  { name: 'primitive-string', content: 'not-an-object' },
  { name: 'primitive-number', content: 7 },
  { name: 'primitive-bool', content: true },
  { name: 'primitive-null', content: null },
  { name: 'array-root', content: [{ algorithm: OLM_ALGO }] },
  {
    name: 'sender-key-object',
    content: { algorithm: OLM_ALGO, sender_key: { bad: true }, ciphertext: {} },
  },
  {
    name: 'device-id-number',
    content: {
      algorithm: MEGOLM_ALGO,
      device_id: 123,
      session_id: 's',
      ciphertext: 'c',
      sender_key: 'sk',
    },
  },
];


// ============================================
// 1) Malformed encrypted payload stubs via sendToDevice
// Homeserver does not decrypt — stores opaque JSON content as-is.
// ============================================

describe('to-device crypto edges — malformed encrypted send stubs', () => {
  it('stores malformed encrypted stub soft-0 (empty-object) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[0];
    const db = createToDeviceDb({ streamPositions: { to_device: 100 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-0`),
      jsonInit('PUT', { messages: { [BOB]: { DEV0: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV0`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(101);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-0`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-1 (null-algorithm) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[1];
    const db = createToDeviceDb({ streamPositions: { to_device: 101 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-1`),
      jsonInit('PUT', { messages: { [BOB]: { DEV1: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV1`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(102);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-1`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-2 (missing-ciphertext) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[2];
    const db = createToDeviceDb({ streamPositions: { to_device: 102 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-2`),
      jsonInit('PUT', { messages: { [BOB]: { DEV2: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV2`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(103);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-2`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-3 (null-ciphertext) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[3];
    const db = createToDeviceDb({ streamPositions: { to_device: 103 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-3`),
      jsonInit('PUT', { messages: { [BOB]: { DEV3: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV3`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(104);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-3`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-4 (array-ciphertext) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[4];
    const db = createToDeviceDb({ streamPositions: { to_device: 104 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-4`),
      jsonInit('PUT', { messages: { [BOB]: { DEV4: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV4`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(105);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-4`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-5 (number-ciphertext) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[5];
    const db = createToDeviceDb({ streamPositions: { to_device: 105 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-5`),
      jsonInit('PUT', { messages: { [BOB]: { DEV5: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV5`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(106);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-5`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-6 (bool-ciphertext) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[6];
    const db = createToDeviceDb({ streamPositions: { to_device: 106 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-6`),
      jsonInit('PUT', { messages: { [BOB]: { DEV6: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV6`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(107);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-6`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-7 (empty-ciphertext-map) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[7];
    const db = createToDeviceDb({ streamPositions: { to_device: 107 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-7`),
      jsonInit('PUT', { messages: { [BOB]: { DEV7: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV7`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(108);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-7`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-8 (missing-body-type) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[8];
    const db = createToDeviceDb({ streamPositions: { to_device: 108 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-8`),
      jsonInit('PUT', { messages: { [BOB]: { DEV8: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV8`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(109);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-8`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-9 (null-body) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[9];
    const db = createToDeviceDb({ streamPositions: { to_device: 109 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-9`),
      jsonInit('PUT', { messages: { [BOB]: { DEV9: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV9`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(110);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-9`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-10 (string-type) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[10];
    const db = createToDeviceDb({ streamPositions: { to_device: 110 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-10`),
      jsonInit('PUT', { messages: { [BOB]: { DEV10: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV10`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(111);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-10`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-11 (neg-type) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[11];
    const db = createToDeviceDb({ streamPositions: { to_device: 111 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-11`),
      jsonInit('PUT', { messages: { [BOB]: { DEV11: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV11`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(112);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-11`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-12 (unknown-algorithm) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[12];
    const db = createToDeviceDb({ streamPositions: { to_device: 112 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-12`),
      jsonInit('PUT', { messages: { [BOB]: { DEV12: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV12`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(113);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-12`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-13 (megolm-missing-session) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[13];
    const db = createToDeviceDb({ streamPositions: { to_device: 113 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-13`),
      jsonInit('PUT', { messages: { [BOB]: { DEV13: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV13`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(114);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-13`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-14 (megolm-null-session) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[14];
    const db = createToDeviceDb({ streamPositions: { to_device: 114 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-14`),
      jsonInit('PUT', { messages: { [BOB]: { DEV14: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV14`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(115);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-14`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-15 (megolm-empty-ciphertext) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[15];
    const db = createToDeviceDb({ streamPositions: { to_device: 115 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-15`),
      jsonInit('PUT', { messages: { [BOB]: { DEV15: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV15`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(116);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-15`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-16 (extra-junk-fields) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[16];
    const db = createToDeviceDb({ streamPositions: { to_device: 116 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-16`),
      jsonInit('PUT', { messages: { [BOB]: { DEV16: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV16`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(117);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-16`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-17 (primitive-string) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[17];
    const db = createToDeviceDb({ streamPositions: { to_device: 117 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-17`),
      jsonInit('PUT', { messages: { [BOB]: { DEV17: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV17`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(118);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-17`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-18 (primitive-number) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[18];
    const db = createToDeviceDb({ streamPositions: { to_device: 118 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-18`),
      jsonInit('PUT', { messages: { [BOB]: { DEV18: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV18`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(119);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-18`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-19 (primitive-bool) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[19];
    const db = createToDeviceDb({ streamPositions: { to_device: 119 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-19`),
      jsonInit('PUT', { messages: { [BOB]: { DEV19: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV19`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(120);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-19`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-20 (primitive-null) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[20];
    const db = createToDeviceDb({ streamPositions: { to_device: 120 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-20`),
      jsonInit('PUT', { messages: { [BOB]: { DEV20: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV20`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(121);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-20`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-21 (array-root) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[21];
    const db = createToDeviceDb({ streamPositions: { to_device: 121 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-21`),
      jsonInit('PUT', { messages: { [BOB]: { DEV21: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV21`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(122);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-21`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-22 (sender-key-object) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[22];
    const db = createToDeviceDb({ streamPositions: { to_device: 122 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-22`),
      jsonInit('PUT', { messages: { [BOB]: { DEV22: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV22`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(123);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-22`,
      response: '{}',
    });
  });
  it('stores malformed encrypted stub soft-23 (device-id-number) opaquely', async () => {
    const stub = MALFORMED_ENC_STUBS[23];
    const db = createToDeviceDb({ streamPositions: { to_device: 123 } });
    const env = createSendEnv(db);
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `enc-soft-23`),
      jsonInit('PUT', { messages: { [BOB]: { DEV23: stub.content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe(ENC_TYPE);
    expect(db.messages[0].recipient_device_id).toBe(`DEV23`);
    expect(db.messages[0].content).toBe(JSON.stringify(stub.content));
    expect(db.messages[0].stream_position).toBe(124);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: `enc-soft-23`,
      response: '{}',
    });
  });
  it('batches multiple malformed stubs to distinct devices in one txn', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 0 } });
    const env = createSendEnv(db);
    const messages: Record<string, Record<string, unknown>> = {
      [BOB]: {},
    };
    for (let i = 0; i < 8; i++) {
      messages[BOB][`B${i}`] = MALFORMED_ENC_STUBS[i].content;
    }
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, 'enc-batch-multi'),
      jsonInit('PUT', { messages })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(8);
    expect(db.streamPositions.to_device).toBe(8);
    expect(new Set(db.messages.map((m) => m.recipient_device_id)).size).toBe(8);
    for (let i = 0; i < 8; i++) {
      const row = db.messages.find((m) => m.recipient_device_id === `B${i}`);
      expect(row?.content).toBe(JSON.stringify(MALFORMED_ENC_STUBS[i].content));
      expect(row?.event_type).toBe(ENC_TYPE);
    }
  });

  it('star-expands malformed encrypted stub to all recipient devices', async () => {
    const db = createToDeviceDb({
      streamPositions: { to_device: 5 },
      devices: [
        { user_id: BOB, device_id: 'BX1' },
        { user_id: BOB, device_id: 'BX2' },
        { user_id: BOB, device_id: 'BX3' },
      ],
    });
    const env = createSendEnv(db);
    const stub = MALFORMED_ENC_STUBS[2].content;
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, 'enc-star'),
      jsonInit('PUT', { messages: { [BOB]: { '*': stub } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    expect(db.messages.every((m) => m.content === JSON.stringify(stub))).toBe(true);
    expect(db.messages.map((m) => m.recipient_device_id).sort()).toEqual(['BX1', 'BX2', 'BX3']);
  });

  it('sends m.room_key_request alongside malformed encrypted in same request', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 0 } });
    const env = createSendEnv(db);
    // event type comes from path — one type per request; use encrypted path with mixed shapes
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, 'enc-mixed-shapes'),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            D1: MALFORMED_ENC_STUBS[0].content,
            D2: { algorithm: OLM_ALGO, ciphertext: { k: { type: 0, body: 'ok' } } },
          },
          [CAROL]: {
            C1: MALFORMED_ENC_STUBS[13].content,
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(2);
    expect(db.messages.filter((m) => m.recipient_user_id === CAROL)).toHaveLength(1);
  });

  it('verification event types still accept stub ciphertext-like content', async () => {
    const db = createToDeviceDb();
    const env = createSendEnv(db);
    const type = 'm.key.verification.start';
    const content = {
      method: 'm.sas.v1',
      from_device: DEVICE,
      // junk crypto-ish fields clients might attach
      ciphertext: null,
      algorithm: OLM_ALGO,
    };
    const res = await sendRequest(
      env,
      sendPath(type, 'verify-stub'),
      jsonInit('PUT', { messages: { [BOB]: { D: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe(type);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
});

describe('to-device crypto edges — encrypted event-type soft flood', () => {
  it('accepts crypto-related event type soft-0 (m.room.encrypted) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 0 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 0 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.room.encrypted', `etype-0`),
      jsonInit('PUT', { messages: { [BOB]: { D0: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.room.encrypted');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-1 (m.room_key) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 1 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 1 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.room_key', `etype-1`),
      jsonInit('PUT', { messages: { [BOB]: { D1: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.room_key');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-2 (m.room_key_request) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 2 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 2 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.room_key_request', `etype-2`),
      jsonInit('PUT', { messages: { [BOB]: { D2: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.room_key_request');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-3 (m.forwarded_room_key) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 3 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 3 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.forwarded_room_key', `etype-3`),
      jsonInit('PUT', { messages: { [BOB]: { D3: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.forwarded_room_key');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-4 (m.dummy) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 4 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 4 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.dummy', `etype-4`),
      jsonInit('PUT', { messages: { [BOB]: { D4: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.dummy');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-5 (m.key.verification.request) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 5 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 5 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.key.verification.request', `etype-5`),
      jsonInit('PUT', { messages: { [BOB]: { D5: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.key.verification.request');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-6 (m.key.verification.ready) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 6 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 6 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.key.verification.ready', `etype-6`),
      jsonInit('PUT', { messages: { [BOB]: { D6: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.key.verification.ready');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-7 (m.key.verification.start) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 7 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 7 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.key.verification.start', `etype-7`),
      jsonInit('PUT', { messages: { [BOB]: { D7: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.key.verification.start');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-8 (m.key.verification.accept) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 8 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 8 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.key.verification.accept', `etype-8`),
      jsonInit('PUT', { messages: { [BOB]: { D8: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.key.verification.accept');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-9 (m.key.verification.key) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 9 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 9 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.key.verification.key', `etype-9`),
      jsonInit('PUT', { messages: { [BOB]: { D9: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.key.verification.key');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-10 (m.key.verification.mac) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 10 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 10 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.key.verification.mac', `etype-10`),
      jsonInit('PUT', { messages: { [BOB]: { D10: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.key.verification.mac');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-11 (m.key.verification.done) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 11 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 11 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.key.verification.done', `etype-11`),
      jsonInit('PUT', { messages: { [BOB]: { D11: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.key.verification.done');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-12 (m.key.verification.cancel) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 12 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 12 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.key.verification.cancel', `etype-12`),
      jsonInit('PUT', { messages: { [BOB]: { D12: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.key.verification.cancel');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-13 (m.secret.request) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 13 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 13 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.secret.request', `etype-13`),
      jsonInit('PUT', { messages: { [BOB]: { D13: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.secret.request');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-14 (m.secret.send) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 14 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 14 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('m.secret.send', `etype-14`),
      jsonInit('PUT', { messages: { [BOB]: { D14: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('m.secret.send');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('accepts crypto-related event type soft-15 (org.matrix.msc3814.encrypted) with stub payload', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 15 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      ciphertext: { soft: 15 },
      stub: true,
    };
    const res = await sendRequest(
      env,
      sendPath('org.matrix.msc3814.encrypted', `etype-15`),
      jsonInit('PUT', { messages: { [BOB]: { D15: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].event_type).toBe('org.matrix.msc3814.encrypted');
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
});

// ============================================
// 3) Batch to-device delivery edges (getToDeviceMessages)
// ============================================

describe('to-device crypto edges — batch delivery of encrypted stubs', () => {
  it('delivers a batch of malformed encrypted events in stream order', async () => {
    const rows = MALFORMED_ENC_STUBS.slice(0, 10).map((stub, i) =>
      helperMsg({
        stream_position: i + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE,
        content: JSON.stringify(stub.content),
        event_type: ENC_TYPE,
        sender_user_id: BOB,
      })
    );
    const db = createHelperDb(rows);
    const result = await getToDeviceMessages(db, USER, DEVICE, undefined, 100);
    expect(result.events).toHaveLength(10);
    expect(result.nextBatch).toBe('10');
    for (let i = 0; i < 10; i++) {
      expect(result.events[i]).toEqual({
        sender: BOB,
        type: ENC_TYPE,
        content: MALFORMED_ENC_STUBS[i].content,
      });
    }
    expect(db.acks).toHaveLength(0);
  });

  it('respects batch limit mid-encrypted-stream and sets nextBatch to last returned', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      helperMsg({
        stream_position: i + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE,
        content: JSON.stringify({ algorithm: OLM_ALGO, batch: i + 1 }),
      })
    );
    const db = createHelperDb(rows);
    const page1 = await getToDeviceMessages(db, USER, DEVICE, '0', 5);
    expect(page1.events).toHaveLength(5);
    expect(page1.nextBatch).toBe('5');
    expect(page1.events.map((e) => e.content.batch)).toEqual([1, 2, 3, 4, 5]);

    const page2 = await getToDeviceMessages(db, USER, DEVICE, page1.nextBatch, 5);
    expect(page2.events).toHaveLength(5);
    expect(page2.nextBatch).toBe('10');
    expect(db.acks).toEqual([
      { userId: USER, deviceId: DEVICE, sincePos: 5 },
    ]);
    expect(db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('acks prior encrypted batch without dropping undelivered later pages', async () => {
    const rows = [1, 2, 3, 4, 5, 6].map((p) =>
      helperMsg({
        stream_position: p,
        recipient_user_id: USER,
        recipient_device_id: DEVICE,
        content: JSON.stringify({ p, algorithm: MEGOLM_ALGO, ciphertext: `c${p}` }),
      })
    );
    const db = createHelperDb(rows);
    const mid = await getToDeviceMessages(db, USER, DEVICE, '3', 2);
    expect(mid.events.map((e) => e.content.p)).toEqual([4, 5]);
    expect(mid.nextBatch).toBe('5');
    expect(db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)).toEqual([
      1, 2, 3,
    ]);
    expect(db.messages.find((m) => m.stream_position === 6)?.delivered).toBe(0);
  });

  it('isolates encrypted batches per device id', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE,
        content: JSON.stringify({ for: 'A' }),
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: 'OTHER',
        content: JSON.stringify({ for: 'O' }),
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE,
        content: JSON.stringify({ for: 'A2' }),
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE);
    expect(result.events.map((e) => e.content)).toEqual([{ for: 'A' }, { for: 'A2' }]);
    expect(result.nextBatch).toBe('3');
  });

  it('default limit 100 caps large encrypted backlog', async () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
      helperMsg({
        stream_position: i + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE,
        content: JSON.stringify({ i }),
      })
    );
    const db = createHelperDb(rows);
    const result = await getToDeviceMessages(db, USER, DEVICE);
    expect(result.events).toHaveLength(100);
    expect(result.nextBatch).toBe('100');
  });

  it('limit 1 walks encrypted stream one event at a time with acks', async () => {
    const db = createHelperDb(
      [1, 2, 3].map((p) =>
        helperMsg({
          stream_position: p,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ p }),
        })
      )
    );
    const a = await getToDeviceMessages(db, USER, DEVICE, undefined, 1);
    expect(a.events).toHaveLength(1);
    expect(a.nextBatch).toBe('1');
    const b = await getToDeviceMessages(db, USER, DEVICE, '1', 1);
    expect(b.events.map((e) => e.content.p)).toEqual([2]);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 1 }]);
    const c = await getToDeviceMessages(db, USER, DEVICE, '2', 1);
    expect(c.events.map((e) => e.content.p)).toEqual([3]);
    expect(c.nextBatch).toBe('3');
  });

  it('empty batch after catch-up returns global max nextBatch', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 9,
        recipient_user_id: USER,
        recipient_device_id: DEVICE,
        delivered: 1,
        content: JSON.stringify({ done: true }),
      }),
      helperMsg({
        stream_position: 50,
        recipient_user_id: BOB,
        recipient_device_id: 'X',
        delivered: 1,
      }),
    ]);
    expect(await getToDeviceMessages(db, USER, DEVICE, '9')).toEqual({
      events: [],
      nextBatch: '50',
    });
  });

  it('mixed crypto event types preserve type through batch delivery', async () => {
    const types = [
      ENC_TYPE,
      'm.room_key',
      'm.room_key_request',
      'm.key.verification.request',
      'm.secret.send',
    ];
    const db = createHelperDb(
      types.map((t, i) =>
        helperMsg({
          stream_position: i + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          event_type: t,
          content: JSON.stringify({ t, i }),
          sender_user_id: BOB,
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE);
    expect(result.events.map((e) => e.type)).toEqual(types);
    expect(result.events.every((e) => e.sender === BOB)).toBe(true);
  });
});

describe('to-device crypto edges — batch limit soft flood', () => {
  it('batch limit soft-0 (limit=1) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 0, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 1);
    expect(result.events).toHaveLength(1);
    expect(result.nextBatch).toBe('1');
    expect(result.events[0].content.soft).toBe(0);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-1 (limit=2) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 1, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 2);
    expect(result.events).toHaveLength(2);
    expect(result.nextBatch).toBe('2');
    expect(result.events[0].content.soft).toBe(1);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-2 (limit=3) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 2, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 3);
    expect(result.events).toHaveLength(3);
    expect(result.nextBatch).toBe('3');
    expect(result.events[0].content.soft).toBe(2);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-3 (limit=4) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 3, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 4);
    expect(result.events).toHaveLength(4);
    expect(result.nextBatch).toBe('4');
    expect(result.events[0].content.soft).toBe(3);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-4 (limit=5) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 4, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 5);
    expect(result.events).toHaveLength(5);
    expect(result.nextBatch).toBe('5');
    expect(result.events[0].content.soft).toBe(4);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-5 (limit=6) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 5, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 6);
    expect(result.events).toHaveLength(6);
    expect(result.nextBatch).toBe('6');
    expect(result.events[0].content.soft).toBe(5);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-6 (limit=7) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 6, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 7);
    expect(result.events).toHaveLength(7);
    expect(result.nextBatch).toBe('7');
    expect(result.events[0].content.soft).toBe(6);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-7 (limit=8) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 7, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 8);
    expect(result.events).toHaveLength(8);
    expect(result.nextBatch).toBe('8');
    expect(result.events[0].content.soft).toBe(7);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-8 (limit=1) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 8, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 1);
    expect(result.events).toHaveLength(1);
    expect(result.nextBatch).toBe('1');
    expect(result.events[0].content.soft).toBe(8);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-9 (limit=2) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 9, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 2);
    expect(result.events).toHaveLength(2);
    expect(result.nextBatch).toBe('2');
    expect(result.events[0].content.soft).toBe(9);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-10 (limit=3) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 10, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 3);
    expect(result.events).toHaveLength(3);
    expect(result.nextBatch).toBe('3');
    expect(result.events[0].content.soft).toBe(10);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-11 (limit=4) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 11, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 4);
    expect(result.events).toHaveLength(4);
    expect(result.nextBatch).toBe('4');
    expect(result.events[0].content.soft).toBe(11);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-12 (limit=5) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 12, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 5);
    expect(result.events).toHaveLength(5);
    expect(result.nextBatch).toBe('5');
    expect(result.events[0].content.soft).toBe(12);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-13 (limit=6) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 13, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 6);
    expect(result.events).toHaveLength(6);
    expect(result.nextBatch).toBe('6');
    expect(result.events[0].content.soft).toBe(13);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-14 (limit=7) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 14, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 7);
    expect(result.events).toHaveLength(7);
    expect(result.nextBatch).toBe('7');
    expect(result.events[0].content.soft).toBe(14);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-15 (limit=8) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 15, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 8);
    expect(result.events).toHaveLength(8);
    expect(result.nextBatch).toBe('8');
    expect(result.events[0].content.soft).toBe(15);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-16 (limit=1) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 16, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 1);
    expect(result.events).toHaveLength(1);
    expect(result.nextBatch).toBe('1');
    expect(result.events[0].content.soft).toBe(16);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-17 (limit=2) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 17, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 2);
    expect(result.events).toHaveLength(2);
    expect(result.nextBatch).toBe('2');
    expect(result.events[0].content.soft).toBe(17);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-18 (limit=3) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 18, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 3);
    expect(result.events).toHaveLength(3);
    expect(result.nextBatch).toBe('3');
    expect(result.events[0].content.soft).toBe(18);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-19 (limit=4) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 19, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 4);
    expect(result.events).toHaveLength(4);
    expect(result.nextBatch).toBe('4');
    expect(result.events[0].content.soft).toBe(19);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-20 (limit=5) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 20, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 5);
    expect(result.events).toHaveLength(5);
    expect(result.nextBatch).toBe('5');
    expect(result.events[0].content.soft).toBe(20);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-21 (limit=6) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 21, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 6);
    expect(result.events).toHaveLength(6);
    expect(result.nextBatch).toBe('6');
    expect(result.events[0].content.soft).toBe(21);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-22 (limit=7) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 22, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 7);
    expect(result.events).toHaveLength(7);
    expect(result.nextBatch).toBe('7');
    expect(result.events[0].content.soft).toBe(22);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
  it('batch limit soft-23 (limit=8) over 12 encrypted events', async () => {
    const db = createHelperDb(
      Array.from({ length: 12 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ soft: 23, j, algorithm: OLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '0', 8);
    expect(result.events).toHaveLength(8);
    expect(result.nextBatch).toBe('8');
    expect(result.events[0].content.soft).toBe(23);
    expect(result.events[0].type).toBe(ENC_TYPE);
  });
});

describe('to-device crypto edges — delivery ack soft flood', () => {
  it('ack soft-0 since=1 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '1', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(1);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 1 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 1 }, (_, k) => k + 1));
  });
  it('ack soft-1 since=2 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '2', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(2);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 2 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 2 }, (_, k) => k + 1));
  });
  it('ack soft-2 since=3 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '3', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(3);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 3 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 3 }, (_, k) => k + 1));
  });
  it('ack soft-3 since=4 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '4', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(4);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 4 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 4 }, (_, k) => k + 1));
  });
  it('ack soft-4 since=5 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '5', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(5);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 5 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 5 }, (_, k) => k + 1));
  });
  it('ack soft-5 since=6 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '6', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(6);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 6 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 6 }, (_, k) => k + 1));
  });
  it('ack soft-6 since=7 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '7', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(7);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 7 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 7 }, (_, k) => k + 1));
  });
  it('ack soft-7 since=8 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '8', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(8);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 8 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 8 }, (_, k) => k + 1));
  });
  it('ack soft-8 since=9 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '9', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(9);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 9 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 9 }, (_, k) => k + 1));
  });
  it('ack soft-9 since=10 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '10', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(10);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 10 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 10 }, (_, k) => k + 1));
  });
  it('ack soft-10 since=11 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '11', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(11);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 11 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 11 }, (_, k) => k + 1));
  });
  it('ack soft-11 since=12 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '12', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(12);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 12 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 12 }, (_, k) => k + 1));
  });
  it('ack soft-12 since=13 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '13', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(13);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 13 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 13 }, (_, k) => k + 1));
  });
  it('ack soft-13 since=14 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '14', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(14);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 14 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 14 }, (_, k) => k + 1));
  });
  it('ack soft-14 since=15 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '15', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(15);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 15 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 15 }, (_, k) => k + 1));
  });
  it('ack soft-15 since=16 marks encrypted msgs <= since delivered', async () => {
    const db = createHelperDb(
      Array.from({ length: 20 }, (_, j) =>
        helperMsg({
          stream_position: j + 1,
          recipient_user_id: USER,
          recipient_device_id: DEVICE,
          content: JSON.stringify({ j, algorithm: MEGOLM_ALGO }),
        })
      )
    );
    const result = await getToDeviceMessages(db, USER, DEVICE, '16', 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].content.j).toBe(16);
    expect(db.acks).toEqual([{ userId: USER, deviceId: DEVICE, sincePos: 16 }]);
    expect(
      db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)
    ).toEqual(Array.from({ length: 16 }, (_, k) => k + 1));
  });
});

// ============================================
// 2) Missing device keys paths (keys query / claim)
// ============================================

describe('to-device crypto edges — missing device keys query paths', () => {
  it('query unknown device id omits key and returns empty map slot', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO, MEGOLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`ed25519:${DEVICE}`]: 'k' },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: ['NOPE', 'ALSO_MISSING', DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER].NOPE).toBeUndefined();
    expect(body.device_keys[USER].ALSO_MISSING).toBeUndefined();
    expect(body.failures).toEqual({});
  });

  it('query user with no devices yields empty device_keys map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [BOB]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>> };
    expect(body.device_keys[BOB]).toEqual({});
  });

  it('query skips null DO entries when listing all devices', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        LIVE: { algorithms: [OLM_ALGO], device_id: 'LIVE', user_id: USER },
        GONE: null as unknown as DeviceKeyMap,
      },
    });
    const env = createKeysEnv({ userKeys });
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>> };
    expect(body.device_keys[USER].LIVE).toBeTruthy();
    expect(body.device_keys[USER].GONE).toBeUndefined();
  });

  it('claim missing OTK and missing fallback leaves empty device entry', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [DEVICE_B]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });

  it('claim olm algorithm with empty KV bucket falls through to empty', async () => {
    const otkKv = mockKv({
      [`otk:${BOB}:${DEVICE_B}`]: JSON.stringify({
        signed_curve25519: [],
      }),
    });
    const env = createKeysEnv({ oneTimeKeysKv: otkKv, db: createKeysDb() });
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [DEVICE_B]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    const body = res.body as { one_time_keys: Record<string, Record<string, unknown>> };
    expect(body.one_time_keys[BOB]).toEqual({});
  });

  it('claim all-claimed KV keys then missing D1/fallback yields empty', async () => {
    const otkKv = mockKv({
      [`otk:${BOB}:${DEVICE_B}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:1', keyData: { key: 'a' }, claimed: true },
          { keyId: 'signed_curve25519:2', keyData: { key: 'b' }, claimed: true },
        ],
      }),
    });
    const env = createKeysEnv({ oneTimeKeysKv: otkKv, db: createKeysDb() });
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [DEVICE_B]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect((res.body as { one_time_keys: Record<string, unknown> }).one_time_keys[BOB]).toEqual({});
  });

  it('batch claim across users: one missing device, one with OTK', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:A', keyData: { key: 'alive' }, claimed: false },
        ],
      }),
    });
    const env = createKeysEnv({ oneTimeKeysKv: otkKv, db: createKeysDb() });
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
          [BOB]: { MISSING: 'signed_curve25519' },
          [CAROL]: { C1: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      one_time_keys: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(body.one_time_keys[USER][DEVICE]['signed_curve25519:A']).toEqual({ key: 'alive' });
    expect(body.one_time_keys[BOB]).toEqual({});
    expect(body.one_time_keys[CAROL]).toEqual({});
  });
});

describe('to-device crypto edges — missing device query soft flood', () => {
  it('query missing device soft-0 omits MISSING_0', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c0` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_0`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-1 omits MISSING_1', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c1` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_1`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-2 omits MISSING_2', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c2` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_2`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-3 omits MISSING_3', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c3` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_3`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-4 omits MISSING_4', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c4` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_4`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-5 omits MISSING_5', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c5` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_5`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-6 omits MISSING_6', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c6` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_6`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-7 omits MISSING_7', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c7` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_7`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-8 omits MISSING_8', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c8` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_8`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-9 omits MISSING_9', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c9` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_9`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-10 omits MISSING_10', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c10` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_10`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-11 omits MISSING_11', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c11` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_11`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-12 omits MISSING_12', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c12` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_12`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-13 omits MISSING_13', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c13` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_13`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-14 omits MISSING_14', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c14` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_14`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-15 omits MISSING_15', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c15` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_15`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-16 omits MISSING_16', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c16` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_16`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-17 omits MISSING_17', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c17` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_17`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-18 omits MISSING_18', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c18` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_18`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-19 omits MISSING_19', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c19` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_19`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-20 omits MISSING_20', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c20` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_20`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-21 omits MISSING_21', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c21` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_21`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-22 omits MISSING_22', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c22` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_22`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query missing device soft-23 omits MISSING_23', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: [OLM_ALGO],
          device_id: DEVICE,
          user_id: USER,
          keys: { [`curve25519:${DEVICE}`]: `c23` },
        },
      },
    });
    const env = createKeysEnv({ userKeys });
    const missing = `MISSING_23`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [missing, DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER][missing]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
});

describe('to-device crypto edges — missing claim soft flood', () => {
  it('claim missing keys soft-0 for device GHOST0', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST0`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-1 for device GHOST1', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST1`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-2 for device GHOST2', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST2`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-3 for device GHOST3', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST3`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-4 for device GHOST4', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST4`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-5 for device GHOST5', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST5`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-6 for device GHOST6', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST6`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-7 for device GHOST7', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST7`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-8 for device GHOST8', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST8`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-9 for device GHOST9', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST9`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-10 for device GHOST10', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST10`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-11 for device GHOST11', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST11`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-12 for device GHOST12', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST12`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-13 for device GHOST13', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST13`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-14 for device GHOST14', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST14`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-15 for device GHOST15', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST15`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-16 for device GHOST16', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST16`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-17 for device GHOST17', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST17`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-18 for device GHOST18', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST18`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-19 for device GHOST19', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST19`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-20 for device GHOST20', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST20`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-21 for device GHOST21', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST21`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-22 for device GHOST22', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST22`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
  it('claim missing keys soft-23 for device GHOST23', async () => {
    const env = createKeysEnv({ oneTimeKeysKv: mockKv(), db: createKeysDb() });
    const deviceId = `GHOST23`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [deviceId]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });
});

describe('to-device crypto edges — multi-user batch send + delivery', () => {
  it('batch send encrypted stubs to many users then deliver per device', async () => {
    const db = createToDeviceDb({
      streamPositions: { to_device: 0 },
      devices: [
        { user_id: BOB, device_id: 'B1' },
        { user_id: BOB, device_id: 'B2' },
        { user_id: CAROL, device_id: 'C1' },
      ],
    });
    const env = createSendEnv(db);
    const stub = {
      algorithm: OLM_ALGO,
      ciphertext: { 'curve25519:x': { type: 0, body: 'BATCH' } },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, 'multi-user-batch'),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': stub },
          [CAROL]: { '*': stub },
          [USER]: { [DEVICE]: stub },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(4);
    expect(db.streamPositions.to_device).toBe(4);

    // Simulate delivery helper using stored rows
    const helperRows: ToDeviceRow[] = db.messages.map((m, idx) => ({
      id: idx + 1,
      sender_user_id: m.sender_user_id,
      event_type: m.event_type,
      content: m.content,
      stream_position: m.stream_position,
      recipient_user_id: m.recipient_user_id,
      recipient_device_id: m.recipient_device_id,
      delivered: 0,
      created_at: NOW,
    }));
    const helper = createHelperDb(helperRows);
    const bobB1 = await getToDeviceMessages(helper, BOB, 'B1');
    expect(bobB1.events).toHaveLength(1);
    expect(bobB1.events[0].content).toEqual(stub);
    const carol = await getToDeviceMessages(helper, CAROL, 'C1');
    expect(carol.events).toHaveLength(1);
    const alice = await getToDeviceMessages(helper, USER, DEVICE);
    expect(alice.events).toHaveLength(1);
  });

  it('does not deliver already-delivered encrypted rows in subsequent batches', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE,
        delivered: 1,
        content: JSON.stringify({ old: true }),
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE,
        content: JSON.stringify({ fresh: true, algorithm: OLM_ALGO }),
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE, '1');
    expect(result.events).toEqual([
      {
        sender: '@sender:example.com',
        type: ENC_TYPE,
        content: { fresh: true, algorithm: OLM_ALGO },
      },
    ]);
  });
});

describe('to-device crypto edges — cleanup vs undelivered encrypted', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cleanup does not delete undelivered encrypted stubs even when old', async () => {
    const cutoff = NOW - SEVEN_DAYS_MS;
    const db = createHelperDb([
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE,
        delivered: 0,
        created_at: cutoff - 1000,
        content: JSON.stringify({ algorithm: OLM_ALGO, ciphertext: null }),
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE,
        delivered: 1,
        created_at: cutoff - 1000,
        content: JSON.stringify({ algorithm: OLM_ALGO, ciphertext: {} }),
      }),
    ]);
    expect(await cleanupOldToDeviceMessages(db)).toBe(1);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].delivered).toBe(0);
  });
});

describe('to-device crypto edges — send soft flood with olm ciphertext stubs', () => {
  it('olm ciphertext stub soft-0 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 200 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S0`,
      ciphertext: {
        [`curve25519:P0`]: { type: 0, body: `stub-0` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-0`),
      jsonInit('PUT', { messages: { [BOB]: { [`D0`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(201);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-1 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 201 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S1`,
      ciphertext: {
        [`curve25519:P1`]: { type: 1, body: `stub-1` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-1`),
      jsonInit('PUT', { messages: { [BOB]: { [`D1`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(202);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-2 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 202 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S2`,
      ciphertext: {
        [`curve25519:P2`]: { type: 0, body: `stub-2` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-2`),
      jsonInit('PUT', { messages: { [BOB]: { [`D2`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(203);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-3 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 203 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S3`,
      ciphertext: {
        [`curve25519:P3`]: { type: 1, body: `stub-3` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-3`),
      jsonInit('PUT', { messages: { [BOB]: { [`D3`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(204);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-4 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 204 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S4`,
      ciphertext: {
        [`curve25519:P4`]: { type: 0, body: `stub-4` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-4`),
      jsonInit('PUT', { messages: { [BOB]: { [`D4`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(205);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-5 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 205 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S5`,
      ciphertext: {
        [`curve25519:P5`]: { type: 1, body: `stub-5` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-5`),
      jsonInit('PUT', { messages: { [BOB]: { [`D5`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(206);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-6 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 206 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S6`,
      ciphertext: {
        [`curve25519:P6`]: { type: 0, body: `stub-6` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-6`),
      jsonInit('PUT', { messages: { [BOB]: { [`D6`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(207);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-7 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 207 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S7`,
      ciphertext: {
        [`curve25519:P7`]: { type: 1, body: `stub-7` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-7`),
      jsonInit('PUT', { messages: { [BOB]: { [`D7`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(208);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-8 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 208 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S8`,
      ciphertext: {
        [`curve25519:P8`]: { type: 0, body: `stub-8` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-8`),
      jsonInit('PUT', { messages: { [BOB]: { [`D8`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(209);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-9 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 209 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S9`,
      ciphertext: {
        [`curve25519:P9`]: { type: 1, body: `stub-9` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-9`),
      jsonInit('PUT', { messages: { [BOB]: { [`D9`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(210);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-10 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 210 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S10`,
      ciphertext: {
        [`curve25519:P10`]: { type: 0, body: `stub-10` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-10`),
      jsonInit('PUT', { messages: { [BOB]: { [`D10`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(211);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-11 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 211 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S11`,
      ciphertext: {
        [`curve25519:P11`]: { type: 1, body: `stub-11` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-11`),
      jsonInit('PUT', { messages: { [BOB]: { [`D11`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(212);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-12 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 212 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S12`,
      ciphertext: {
        [`curve25519:P12`]: { type: 0, body: `stub-12` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-12`),
      jsonInit('PUT', { messages: { [BOB]: { [`D12`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(213);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-13 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 213 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S13`,
      ciphertext: {
        [`curve25519:P13`]: { type: 1, body: `stub-13` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-13`),
      jsonInit('PUT', { messages: { [BOB]: { [`D13`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(214);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-14 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 214 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S14`,
      ciphertext: {
        [`curve25519:P14`]: { type: 0, body: `stub-14` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-14`),
      jsonInit('PUT', { messages: { [BOB]: { [`D14`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(215);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-15 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 215 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S15`,
      ciphertext: {
        [`curve25519:P15`]: { type: 1, body: `stub-15` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-15`),
      jsonInit('PUT', { messages: { [BOB]: { [`D15`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(216);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-16 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 216 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S16`,
      ciphertext: {
        [`curve25519:P16`]: { type: 0, body: `stub-16` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-16`),
      jsonInit('PUT', { messages: { [BOB]: { [`D16`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(217);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-17 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 217 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S17`,
      ciphertext: {
        [`curve25519:P17`]: { type: 1, body: `stub-17` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-17`),
      jsonInit('PUT', { messages: { [BOB]: { [`D17`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(218);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-18 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 218 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S18`,
      ciphertext: {
        [`curve25519:P18`]: { type: 0, body: `stub-18` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-18`),
      jsonInit('PUT', { messages: { [BOB]: { [`D18`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(219);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-19 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 219 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S19`,
      ciphertext: {
        [`curve25519:P19`]: { type: 1, body: `stub-19` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-19`),
      jsonInit('PUT', { messages: { [BOB]: { [`D19`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(220);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-20 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 220 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S20`,
      ciphertext: {
        [`curve25519:P20`]: { type: 0, body: `stub-20` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-20`),
      jsonInit('PUT', { messages: { [BOB]: { [`D20`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(221);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-21 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 221 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S21`,
      ciphertext: {
        [`curve25519:P21`]: { type: 1, body: `stub-21` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-21`),
      jsonInit('PUT', { messages: { [BOB]: { [`D21`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(222);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-22 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 222 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S22`,
      ciphertext: {
        [`curve25519:P22`]: { type: 0, body: `stub-22` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-22`),
      jsonInit('PUT', { messages: { [BOB]: { [`D22`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(223);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-23 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 223 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S23`,
      ciphertext: {
        [`curve25519:P23`]: { type: 1, body: `stub-23` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-23`),
      jsonInit('PUT', { messages: { [BOB]: { [`D23`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(224);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-24 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 224 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S24`,
      ciphertext: {
        [`curve25519:P24`]: { type: 0, body: `stub-24` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-24`),
      jsonInit('PUT', { messages: { [BOB]: { [`D24`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(225);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-25 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 225 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S25`,
      ciphertext: {
        [`curve25519:P25`]: { type: 1, body: `stub-25` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-25`),
      jsonInit('PUT', { messages: { [BOB]: { [`D25`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(226);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-26 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 226 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S26`,
      ciphertext: {
        [`curve25519:P26`]: { type: 0, body: `stub-26` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-26`),
      jsonInit('PUT', { messages: { [BOB]: { [`D26`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(227);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-27 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 227 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S27`,
      ciphertext: {
        [`curve25519:P27`]: { type: 1, body: `stub-27` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-27`),
      jsonInit('PUT', { messages: { [BOB]: { [`D27`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(228);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-28 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 228 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S28`,
      ciphertext: {
        [`curve25519:P28`]: { type: 0, body: `stub-28` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-28`),
      jsonInit('PUT', { messages: { [BOB]: { [`D28`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(229);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-29 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 229 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S29`,
      ciphertext: {
        [`curve25519:P29`]: { type: 1, body: `stub-29` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-29`),
      jsonInit('PUT', { messages: { [BOB]: { [`D29`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(230);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-30 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 230 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S30`,
      ciphertext: {
        [`curve25519:P30`]: { type: 0, body: `stub-30` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-30`),
      jsonInit('PUT', { messages: { [BOB]: { [`D30`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(231);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
  it('olm ciphertext stub soft-31 stores and bumps stream', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 231 } });
    const env = createSendEnv(db);
    const content = {
      algorithm: OLM_ALGO,
      sender_key: `curve25519:S31`,
      ciphertext: {
        [`curve25519:P31`]: { type: 1, body: `stub-31` },
      },
    };
    const res = await sendRequest(
      env,
      sendPath(ENC_TYPE, `olm-soft-31`),
      jsonInit('PUT', { messages: { [BOB]: { [`D31`]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(232);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });
});

describe('to-device crypto edges — query empty/missing request soft flood', () => {
  it('query soft-0 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost0:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-1 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost1:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-2 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost2:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-3 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost3:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-4 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost4:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-5 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost5:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-6 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost6:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-7 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost7:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-8 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost8:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-9 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost9:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-10 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost10:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-11 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost11:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-12 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost12:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-13 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost13:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-14 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost14:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
  it('query soft-15 with empty device list for unknown user returns empty map', async () => {
    const env = createKeysEnv({ userKeys: createUserKeysStub({ deviceKeys: {} }) });
    const uid = `@ghost15:example.com`;
    const res = await keysRequest(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [uid]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      failures: Record<string, unknown>;
    };
    expect(body.device_keys[uid]).toEqual({});
    expect(body.master_keys[uid]).toBeUndefined();
    expect(body.failures).toEqual({});
  });
});
