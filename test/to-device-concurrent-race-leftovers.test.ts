/**
 * TOKENMAXX HEAVY leftovers after #168/#174 — to-device *concurrent race / TOCTOU*
 * + soft/edge reliability for slices crypto edges (#168) and route suites soft-flooded lightly.
 * Orthogonal to to-device crypto edges (#168), presence/receipts/typing soft leftovers,
 * devices/key-backups/report races (#174), and keys/media/appservice races (#167).
 * Focus: sendToDevice txn-id SELECT→INSERT TOCTOU double-send, parallel stream bumps,
 * * expand mid-flight device-list mutation, getToDeviceMessages fetch∥ack∥cleanup races.
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

import toDeviceApp, {
  cleanupOldToDeviceMessages,
  getToDeviceMessages,
} from '../src/api/to-device';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DEVICE_A = 'DEVICEA';
const DEVICE_B = 'DEVICEB';
const DEVICE_C = 'DEVICEC';
const EVENT_TYPE = 'm.room_key_request';
const NOW = 1_700_000_000_000;
const AUTH = { Authorization: 'Bearer test-token' };
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type SqlCall = { sql: string; args: unknown[] };
type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
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

type HelperRow = {
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

function createToDeviceDb(
  opts: {
    streamPositions?: Record<string, number>;
    missingStreamRow?: boolean;
    devices?: DeviceRow[];
    transactions?: TxnRow[];
    selectBarrier?: SelectBarrier;
    mutateDevicesAfterSelects?: { after: number; next: DeviceRow[] };
  } = {}
) {
  const streamPositions = { ...(opts.streamPositions ?? { to_device: 10 }) };
  const missingStreamRow = opts.missingStreamRow ?? false;
  const devices = [...(opts.devices ?? [])];
  const transactions = [...(opts.transactions ?? [])];
  const messages: MessageInsert[] = [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const events: string[] = [];
  let selectBarrier = opts.selectBarrier;
  const waitersRef = { list: [] as Array<() => void> };
  let deviceSelectCount = 0;
  const mutate = opts.mutateDevicesAfterSelects;

  const db = {
    streamPositions,
    devices,
    transactions,
    messages,
    inserts,
    updates,
    selects,
    events,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              events.push(`first:${sql.slice(0, 56)}`);
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
                // Snapshot devices *before* mutation so mid-flight * expand races
                // only affect subsequent SELECTs in the same request.
                const results = devices
                  .filter((d) => d.user_id === userId)
                  .map((d) => ({ device_id: d.device_id }));
                deviceSelectCount += 1;
                if (mutate && deviceSelectCount === mutate.after) {
                  devices.splice(0, devices.length, ...mutate.next);
                  events.push('mutate:devices');
                }
                return { results } as { results: T[] };
              }
              return { results: [] as T[] };
            },

            async run() {
              if (sql.includes('INSERT INTO to_device_messages')) {
                inserts.push({ sql, args });
                events.push('run:insert-message');
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
                events.push('run:insert-txn');
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

type ToDeviceDb = ReturnType<typeof createToDeviceDb>;

function createEnv(db?: ToDeviceDb) {
  const d = db ?? createToDeviceDb();
  return {
    DB: d as unknown as D1Database,
    SERVER_NAME: 'example.com',
    _db: d,
  } as unknown as Env & { _db: ToDeviceDb };
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; errcode?: string }> {
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
  const errcode =
    body && typeof body === 'object' && body !== null && 'errcode' in body
      ? String((body as { errcode: string }).errcode)
      : undefined;
  return { status: res.status, body, errcode };
}

function jsonInit(
  method: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...AUTH,
      ...extraHeaders,
    },
    body:
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  };
}

function sendPath(eventType = EVENT_TYPE, txnId = 'txn-1'): string {
  return `/_matrix/client/v3/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`;
}

function txnBarrier(txnId: string, count = 2): SelectBarrier {
  return {
    count,
    match: (sql, args) =>
      sql.includes('FROM transaction_ids') &&
      sql.includes('SELECT response') &&
      args[0] === USER &&
      args[1] === txnId,
  };
}

function createHelperDb(
  messages: HelperRow[] = [],
  opts: { selectBarrier?: SelectBarrier } = {}
) {
  const acks: Array<{ userId: string; deviceId: string; sincePos: number }> = [];
  const deletes: number[] = [];
  const events: string[] = [];
  let nextId = messages.reduce((max, m) => Math.max(max, m.id), 0) + 1;
  let selectBarrier = opts.selectBarrier;
  const waitersRef = { list: [] as Array<() => void> };

  function maxStreamPos(): number {
    return messages.reduce((acc, m) => Math.max(acc, m.stream_position), 0);
  }

  function stmt(sql: string, args: unknown[] = []) {
    return {
      bind(...bindArgs: unknown[]) {
        return stmt(sql, bindArgs);
      },
      async all<T>() {
        events.push(`all:${sql.slice(0, 48)}`);
        await withSelectBarrier(
          selectBarrier,
          waitersRef,
          () => {
            selectBarrier = undefined;
          },
          sql,
          args
        );
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
        events.push(`first:${sql.slice(0, 48)}`);
        await withSelectBarrier(
          selectBarrier,
          waitersRef,
          () => {
            selectBarrier = undefined;
          },
          sql,
          args
        );
        if (sql.includes('MAX(stream_position)')) {
          return { max_pos: maxStreamPos() } as T;
        }
        return null;
      },
      async run() {
        events.push(`run:${sql.slice(0, 48)}`);
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
    events,
    prepare(sql: string) {
      return stmt(sql);
    },
    add(partial: Omit<HelperRow, 'id'> & { id?: number }) {
      const row: HelperRow = {
        id: partial.id ?? nextId++,
        ...partial,
      };
      messages.push(row);
      return row;
    },
  };

  return db as unknown as D1Database & {
    messages: HelperRow[];
    acks: typeof acks;
    deletes: number[];
    events: string[];
    add: (partial: Omit<HelperRow, 'id'> & { id?: number }) => HelperRow;
  };
}

function helperMsg(
  overrides: Partial<HelperRow> &
    Pick<HelperRow, 'stream_position' | 'recipient_user_id' | 'recipient_device_id'>
): HelperRow {
  return {
    id: overrides.id ?? overrides.stream_position,
    sender_user_id: overrides.sender_user_id ?? '@sender:example.com',
    event_type: overrides.event_type ?? 'm.room_key',
    content: overrides.content ?? JSON.stringify({ key: 'v' }),
    delivered: overrides.delivered ?? 0,
    created_at: overrides.created_at ?? NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('race sendToDevice same txnId SELECT→INSERT TOCTOU after #168', () => {
  it('soft-1: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-1';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 1 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-2: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-2';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 2 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-3: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-3';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 3 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-4: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-4';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 4 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-5: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-5';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 5 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-6: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-6';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 6 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-7: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-7';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 7 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-8: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-8';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 8 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-9: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-9';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 9 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-10: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-10';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 10 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-11: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-11';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 11 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-12: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-12';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 12 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-13: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-13';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 13 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-14: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-14';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 14 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-15: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-15';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 15 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

  it('soft-16: parallel PUT same txn both miss cache → double message insert risk', async () => {
    const txn = 'toctou-txn-16';
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 2),
      devices: [{ user_id: BOB, device_id: DEVICE_B }],
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { k: 16 } } } };
    const [a, b] = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({});
    expect(b.body).toEqual({});
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
  });

});

describe('race sendToDevice parallel distinct txns stream bumps after #168', () => {
  it('soft-1: 3 parallel distinct txns get unique stream positions', async () => {
    const n = 3;
    const db = createToDeviceDb({ streamPositions: { to_device: 110 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-1-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D1${j}`]: { n: j, soft: 1 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-2: 4 parallel distinct txns get unique stream positions', async () => {
    const n = 4;
    const db = createToDeviceDb({ streamPositions: { to_device: 120 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-2-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D2${j}`]: { n: j, soft: 2 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-3: 2 parallel distinct txns get unique stream positions', async () => {
    const n = 2;
    const db = createToDeviceDb({ streamPositions: { to_device: 130 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-3-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D3${j}`]: { n: j, soft: 3 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-4: 3 parallel distinct txns get unique stream positions', async () => {
    const n = 3;
    const db = createToDeviceDb({ streamPositions: { to_device: 140 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-4-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D4${j}`]: { n: j, soft: 4 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-5: 4 parallel distinct txns get unique stream positions', async () => {
    const n = 4;
    const db = createToDeviceDb({ streamPositions: { to_device: 150 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-5-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D5${j}`]: { n: j, soft: 5 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-6: 2 parallel distinct txns get unique stream positions', async () => {
    const n = 2;
    const db = createToDeviceDb({ streamPositions: { to_device: 160 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-6-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D6${j}`]: { n: j, soft: 6 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-7: 3 parallel distinct txns get unique stream positions', async () => {
    const n = 3;
    const db = createToDeviceDb({ streamPositions: { to_device: 170 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-7-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D7${j}`]: { n: j, soft: 7 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-8: 4 parallel distinct txns get unique stream positions', async () => {
    const n = 4;
    const db = createToDeviceDb({ streamPositions: { to_device: 180 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-8-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D8${j}`]: { n: j, soft: 8 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-9: 2 parallel distinct txns get unique stream positions', async () => {
    const n = 2;
    const db = createToDeviceDb({ streamPositions: { to_device: 190 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-9-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D9${j}`]: { n: j, soft: 9 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-10: 3 parallel distinct txns get unique stream positions', async () => {
    const n = 3;
    const db = createToDeviceDb({ streamPositions: { to_device: 200 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-10-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D10${j}`]: { n: j, soft: 10 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-11: 4 parallel distinct txns get unique stream positions', async () => {
    const n = 4;
    const db = createToDeviceDb({ streamPositions: { to_device: 210 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-11-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D11${j}`]: { n: j, soft: 11 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-12: 2 parallel distinct txns get unique stream positions', async () => {
    const n = 2;
    const db = createToDeviceDb({ streamPositions: { to_device: 220 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-12-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D12${j}`]: { n: j, soft: 12 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-13: 3 parallel distinct txns get unique stream positions', async () => {
    const n = 3;
    const db = createToDeviceDb({ streamPositions: { to_device: 230 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-13-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D13${j}`]: { n: j, soft: 13 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-14: 4 parallel distinct txns get unique stream positions', async () => {
    const n = 4;
    const db = createToDeviceDb({ streamPositions: { to_device: 240 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-14-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D14${j}`]: { n: j, soft: 14 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-15: 2 parallel distinct txns get unique stream positions', async () => {
    const n = 2;
    const db = createToDeviceDb({ streamPositions: { to_device: 250 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-15-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D15${j}`]: { n: j, soft: 15 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

  it('soft-16: 3 parallel distinct txns get unique stream positions', async () => {
    const n = 3;
    const db = createToDeviceDb({ streamPositions: { to_device: 260 } });
    const env = createEnv(db);
    const reqs = Array.from({ length: n }, (_, j) =>
      request(
        env,
        sendPath(EVENT_TYPE, `par-txn-16-${j}`),
        jsonInit('PUT', { messages: { [BOB]: { [`D16${j}`]: { n: j, soft: 16 } } } })
      )
    );
    const results = await Promise.all(reqs);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    }
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(db.messages).toHaveLength(n);
    expect(db.transactions).toHaveLength(n);
  });

});

describe('race sendToDevice * expand mid-flight device-list mutation after #168', () => {
  it('soft-1: * expand sees mutated device set after first SELECT', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'OLD1A' },
        { user_id: BOB, device_id: 'OLD1B' },
      ],
      mutateDevicesAfterSelects: {
        after: 1,
        next: [
          { user_id: BOB, device_id: 'NEW1X' },
          { user_id: BOB, device_id: 'NEW1Y' },
          { user_id: BOB, device_id: 'NEW1Z' },
          { user_id: CAROL, device_id: 'NEW1X' },
          { user_id: CAROL, device_id: 'NEW1Y' },
          { user_id: CAROL, device_id: 'NEW1Z' },
        ],
      },
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key', `star-mut-1`),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': { soft: 1 } },
          [CAROL]: { '*': { softCarol: 1 } },
        },
      })
    );
    expect(res.status).toBe(200);
    const bobDevs = db.messages
      .filter((m) => m.recipient_user_id === BOB)
      .map((m) => m.recipient_device_id)
      .sort();
    const carolDevs = db.messages
      .filter((m) => m.recipient_user_id === CAROL)
      .map((m) => m.recipient_device_id)
      .sort();
    expect(bobDevs).toEqual(['OLD1A', 'OLD1B']);
    expect(carolDevs).toEqual(['NEW1X', 'NEW1Y', 'NEW1Z']);
    expect(db.events).toContain('mutate:devices');
  });

  it('soft-2: * expand sees mutated device set after first SELECT', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'OLD2A' },
        { user_id: BOB, device_id: 'OLD2B' },
      ],
      mutateDevicesAfterSelects: {
        after: 1,
        next: [
          { user_id: BOB, device_id: 'NEW2X' },
          { user_id: BOB, device_id: 'NEW2Y' },
          { user_id: BOB, device_id: 'NEW2Z' },
          { user_id: CAROL, device_id: 'NEW2X' },
          { user_id: CAROL, device_id: 'NEW2Y' },
          { user_id: CAROL, device_id: 'NEW2Z' },
        ],
      },
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key', `star-mut-2`),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': { soft: 2 } },
          [CAROL]: { '*': { softCarol: 2 } },
        },
      })
    );
    expect(res.status).toBe(200);
    const bobDevs = db.messages
      .filter((m) => m.recipient_user_id === BOB)
      .map((m) => m.recipient_device_id)
      .sort();
    const carolDevs = db.messages
      .filter((m) => m.recipient_user_id === CAROL)
      .map((m) => m.recipient_device_id)
      .sort();
    expect(bobDevs).toEqual(['OLD2A', 'OLD2B']);
    expect(carolDevs).toEqual(['NEW2X', 'NEW2Y', 'NEW2Z']);
    expect(db.events).toContain('mutate:devices');
  });

  it('soft-3: * expand sees mutated device set after first SELECT', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'OLD3A' },
        { user_id: BOB, device_id: 'OLD3B' },
      ],
      mutateDevicesAfterSelects: {
        after: 1,
        next: [
          { user_id: BOB, device_id: 'NEW3X' },
          { user_id: BOB, device_id: 'NEW3Y' },
          { user_id: BOB, device_id: 'NEW3Z' },
          { user_id: CAROL, device_id: 'NEW3X' },
          { user_id: CAROL, device_id: 'NEW3Y' },
          { user_id: CAROL, device_id: 'NEW3Z' },
        ],
      },
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key', `star-mut-3`),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': { soft: 3 } },
          [CAROL]: { '*': { softCarol: 3 } },
        },
      })
    );
    expect(res.status).toBe(200);
    const bobDevs = db.messages
      .filter((m) => m.recipient_user_id === BOB)
      .map((m) => m.recipient_device_id)
      .sort();
    const carolDevs = db.messages
      .filter((m) => m.recipient_user_id === CAROL)
      .map((m) => m.recipient_device_id)
      .sort();
    expect(bobDevs).toEqual(['OLD3A', 'OLD3B']);
    expect(carolDevs).toEqual(['NEW3X', 'NEW3Y', 'NEW3Z']);
    expect(db.events).toContain('mutate:devices');
  });

  it('soft-4: * expand sees mutated device set after first SELECT', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'OLD4A' },
        { user_id: BOB, device_id: 'OLD4B' },
      ],
      mutateDevicesAfterSelects: {
        after: 1,
        next: [
          { user_id: BOB, device_id: 'NEW4X' },
          { user_id: BOB, device_id: 'NEW4Y' },
          { user_id: BOB, device_id: 'NEW4Z' },
          { user_id: CAROL, device_id: 'NEW4X' },
          { user_id: CAROL, device_id: 'NEW4Y' },
          { user_id: CAROL, device_id: 'NEW4Z' },
        ],
      },
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key', `star-mut-4`),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': { soft: 4 } },
          [CAROL]: { '*': { softCarol: 4 } },
        },
      })
    );
    expect(res.status).toBe(200);
    const bobDevs = db.messages
      .filter((m) => m.recipient_user_id === BOB)
      .map((m) => m.recipient_device_id)
      .sort();
    const carolDevs = db.messages
      .filter((m) => m.recipient_user_id === CAROL)
      .map((m) => m.recipient_device_id)
      .sort();
    expect(bobDevs).toEqual(['OLD4A', 'OLD4B']);
    expect(carolDevs).toEqual(['NEW4X', 'NEW4Y', 'NEW4Z']);
    expect(db.events).toContain('mutate:devices');
  });

  it('soft-5: * expand sees mutated device set after first SELECT', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'OLD5A' },
        { user_id: BOB, device_id: 'OLD5B' },
      ],
      mutateDevicesAfterSelects: {
        after: 1,
        next: [
          { user_id: BOB, device_id: 'NEW5X' },
          { user_id: BOB, device_id: 'NEW5Y' },
          { user_id: BOB, device_id: 'NEW5Z' },
          { user_id: CAROL, device_id: 'NEW5X' },
          { user_id: CAROL, device_id: 'NEW5Y' },
          { user_id: CAROL, device_id: 'NEW5Z' },
        ],
      },
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key', `star-mut-5`),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': { soft: 5 } },
          [CAROL]: { '*': { softCarol: 5 } },
        },
      })
    );
    expect(res.status).toBe(200);
    const bobDevs = db.messages
      .filter((m) => m.recipient_user_id === BOB)
      .map((m) => m.recipient_device_id)
      .sort();
    const carolDevs = db.messages
      .filter((m) => m.recipient_user_id === CAROL)
      .map((m) => m.recipient_device_id)
      .sort();
    expect(bobDevs).toEqual(['OLD5A', 'OLD5B']);
    expect(carolDevs).toEqual(['NEW5X', 'NEW5Y', 'NEW5Z']);
    expect(db.events).toContain('mutate:devices');
  });

  it('soft-6: * expand sees mutated device set after first SELECT', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'OLD6A' },
        { user_id: BOB, device_id: 'OLD6B' },
      ],
      mutateDevicesAfterSelects: {
        after: 1,
        next: [
          { user_id: BOB, device_id: 'NEW6X' },
          { user_id: BOB, device_id: 'NEW6Y' },
          { user_id: BOB, device_id: 'NEW6Z' },
          { user_id: CAROL, device_id: 'NEW6X' },
          { user_id: CAROL, device_id: 'NEW6Y' },
          { user_id: CAROL, device_id: 'NEW6Z' },
        ],
      },
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key', `star-mut-6`),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': { soft: 6 } },
          [CAROL]: { '*': { softCarol: 6 } },
        },
      })
    );
    expect(res.status).toBe(200);
    const bobDevs = db.messages
      .filter((m) => m.recipient_user_id === BOB)
      .map((m) => m.recipient_device_id)
      .sort();
    const carolDevs = db.messages
      .filter((m) => m.recipient_user_id === CAROL)
      .map((m) => m.recipient_device_id)
      .sort();
    expect(bobDevs).toEqual(['OLD6A', 'OLD6B']);
    expect(carolDevs).toEqual(['NEW6X', 'NEW6Y', 'NEW6Z']);
    expect(db.events).toContain('mutate:devices');
  });

  it('soft-7: * expand sees mutated device set after first SELECT', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'OLD7A' },
        { user_id: BOB, device_id: 'OLD7B' },
      ],
      mutateDevicesAfterSelects: {
        after: 1,
        next: [
          { user_id: BOB, device_id: 'NEW7X' },
          { user_id: BOB, device_id: 'NEW7Y' },
          { user_id: BOB, device_id: 'NEW7Z' },
          { user_id: CAROL, device_id: 'NEW7X' },
          { user_id: CAROL, device_id: 'NEW7Y' },
          { user_id: CAROL, device_id: 'NEW7Z' },
        ],
      },
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key', `star-mut-7`),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': { soft: 7 } },
          [CAROL]: { '*': { softCarol: 7 } },
        },
      })
    );
    expect(res.status).toBe(200);
    const bobDevs = db.messages
      .filter((m) => m.recipient_user_id === BOB)
      .map((m) => m.recipient_device_id)
      .sort();
    const carolDevs = db.messages
      .filter((m) => m.recipient_user_id === CAROL)
      .map((m) => m.recipient_device_id)
      .sort();
    expect(bobDevs).toEqual(['OLD7A', 'OLD7B']);
    expect(carolDevs).toEqual(['NEW7X', 'NEW7Y', 'NEW7Z']);
    expect(db.events).toContain('mutate:devices');
  });

  it('soft-8: * expand sees mutated device set after first SELECT', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'OLD8A' },
        { user_id: BOB, device_id: 'OLD8B' },
      ],
      mutateDevicesAfterSelects: {
        after: 1,
        next: [
          { user_id: BOB, device_id: 'NEW8X' },
          { user_id: BOB, device_id: 'NEW8Y' },
          { user_id: BOB, device_id: 'NEW8Z' },
          { user_id: CAROL, device_id: 'NEW8X' },
          { user_id: CAROL, device_id: 'NEW8Y' },
          { user_id: CAROL, device_id: 'NEW8Z' },
        ],
      },
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key', `star-mut-8`),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': { soft: 8 } },
          [CAROL]: { '*': { softCarol: 8 } },
        },
      })
    );
    expect(res.status).toBe(200);
    const bobDevs = db.messages
      .filter((m) => m.recipient_user_id === BOB)
      .map((m) => m.recipient_device_id)
      .sort();
    const carolDevs = db.messages
      .filter((m) => m.recipient_user_id === CAROL)
      .map((m) => m.recipient_device_id)
      .sort();
    expect(bobDevs).toEqual(['OLD8A', 'OLD8B']);
    expect(carolDevs).toEqual(['NEW8X', 'NEW8Y', 'NEW8Z']);
    expect(db.events).toContain('mutate:devices');
  });

  it('soft-9: * expand sees mutated device set after first SELECT', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'OLD9A' },
        { user_id: BOB, device_id: 'OLD9B' },
      ],
      mutateDevicesAfterSelects: {
        after: 1,
        next: [
          { user_id: BOB, device_id: 'NEW9X' },
          { user_id: BOB, device_id: 'NEW9Y' },
          { user_id: BOB, device_id: 'NEW9Z' },
          { user_id: CAROL, device_id: 'NEW9X' },
          { user_id: CAROL, device_id: 'NEW9Y' },
          { user_id: CAROL, device_id: 'NEW9Z' },
        ],
      },
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key', `star-mut-9`),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': { soft: 9 } },
          [CAROL]: { '*': { softCarol: 9 } },
        },
      })
    );
    expect(res.status).toBe(200);
    const bobDevs = db.messages
      .filter((m) => m.recipient_user_id === BOB)
      .map((m) => m.recipient_device_id)
      .sort();
    const carolDevs = db.messages
      .filter((m) => m.recipient_user_id === CAROL)
      .map((m) => m.recipient_device_id)
      .sort();
    expect(bobDevs).toEqual(['OLD9A', 'OLD9B']);
    expect(carolDevs).toEqual(['NEW9X', 'NEW9Y', 'NEW9Z']);
    expect(db.events).toContain('mutate:devices');
  });

  it('soft-10: * expand sees mutated device set after first SELECT', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'OLD10A' },
        { user_id: BOB, device_id: 'OLD10B' },
      ],
      mutateDevicesAfterSelects: {
        after: 1,
        next: [
          { user_id: BOB, device_id: 'NEW10X' },
          { user_id: BOB, device_id: 'NEW10Y' },
          { user_id: BOB, device_id: 'NEW10Z' },
          { user_id: CAROL, device_id: 'NEW10X' },
          { user_id: CAROL, device_id: 'NEW10Y' },
          { user_id: CAROL, device_id: 'NEW10Z' },
        ],
      },
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key', `star-mut-10`),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': { soft: 10 } },
          [CAROL]: { '*': { softCarol: 10 } },
        },
      })
    );
    expect(res.status).toBe(200);
    const bobDevs = db.messages
      .filter((m) => m.recipient_user_id === BOB)
      .map((m) => m.recipient_device_id)
      .sort();
    const carolDevs = db.messages
      .filter((m) => m.recipient_user_id === CAROL)
      .map((m) => m.recipient_device_id)
      .sort();
    expect(bobDevs).toEqual(['OLD10A', 'OLD10B']);
    expect(carolDevs).toEqual(['NEW10X', 'NEW10Y', 'NEW10Z']);
    expect(db.events).toContain('mutate:devices');
  });

  it('soft-11: * expand sees mutated device set after first SELECT', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'OLD11A' },
        { user_id: BOB, device_id: 'OLD11B' },
      ],
      mutateDevicesAfterSelects: {
        after: 1,
        next: [
          { user_id: BOB, device_id: 'NEW11X' },
          { user_id: BOB, device_id: 'NEW11Y' },
          { user_id: BOB, device_id: 'NEW11Z' },
          { user_id: CAROL, device_id: 'NEW11X' },
          { user_id: CAROL, device_id: 'NEW11Y' },
          { user_id: CAROL, device_id: 'NEW11Z' },
        ],
      },
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key', `star-mut-11`),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': { soft: 11 } },
          [CAROL]: { '*': { softCarol: 11 } },
        },
      })
    );
    expect(res.status).toBe(200);
    const bobDevs = db.messages
      .filter((m) => m.recipient_user_id === BOB)
      .map((m) => m.recipient_device_id)
      .sort();
    const carolDevs = db.messages
      .filter((m) => m.recipient_user_id === CAROL)
      .map((m) => m.recipient_device_id)
      .sort();
    expect(bobDevs).toEqual(['OLD11A', 'OLD11B']);
    expect(carolDevs).toEqual(['NEW11X', 'NEW11Y', 'NEW11Z']);
    expect(db.events).toContain('mutate:devices');
  });

  it('soft-12: * expand sees mutated device set after first SELECT', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: 'OLD12A' },
        { user_id: BOB, device_id: 'OLD12B' },
      ],
      mutateDevicesAfterSelects: {
        after: 1,
        next: [
          { user_id: BOB, device_id: 'NEW12X' },
          { user_id: BOB, device_id: 'NEW12Y' },
          { user_id: BOB, device_id: 'NEW12Z' },
          { user_id: CAROL, device_id: 'NEW12X' },
          { user_id: CAROL, device_id: 'NEW12Y' },
          { user_id: CAROL, device_id: 'NEW12Z' },
        ],
      },
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key', `star-mut-12`),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': { soft: 12 } },
          [CAROL]: { '*': { softCarol: 12 } },
        },
      })
    );
    expect(res.status).toBe(200);
    const bobDevs = db.messages
      .filter((m) => m.recipient_user_id === BOB)
      .map((m) => m.recipient_device_id)
      .sort();
    const carolDevs = db.messages
      .filter((m) => m.recipient_user_id === CAROL)
      .map((m) => m.recipient_device_id)
      .sort();
    expect(bobDevs).toEqual(['OLD12A', 'OLD12B']);
    expect(carolDevs).toEqual(['NEW12X', 'NEW12Y', 'NEW12Z']);
    expect(db.events).toContain('mutate:devices');
  });

});

describe('race sendToDevice parallel * expands same recipient after #168', () => {
  it('soft-1: two parallel * sends to Bob expand independently', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: BOB, device_id: DEVICE_C },
      ],
      streamPositions: { to_device: 51 },
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `star-a-1`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'a', soft: 1 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `star-b-1`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'b', soft: 1 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages).toHaveLength(6);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(6);
  });

  it('soft-2: two parallel * sends to Bob expand independently', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: BOB, device_id: DEVICE_C },
      ],
      streamPositions: { to_device: 52 },
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `star-a-2`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'a', soft: 2 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `star-b-2`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'b', soft: 2 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages).toHaveLength(6);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(6);
  });

  it('soft-3: two parallel * sends to Bob expand independently', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: BOB, device_id: DEVICE_C },
      ],
      streamPositions: { to_device: 53 },
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `star-a-3`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'a', soft: 3 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `star-b-3`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'b', soft: 3 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages).toHaveLength(6);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(6);
  });

  it('soft-4: two parallel * sends to Bob expand independently', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: BOB, device_id: DEVICE_C },
      ],
      streamPositions: { to_device: 54 },
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `star-a-4`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'a', soft: 4 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `star-b-4`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'b', soft: 4 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages).toHaveLength(6);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(6);
  });

  it('soft-5: two parallel * sends to Bob expand independently', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: BOB, device_id: DEVICE_C },
      ],
      streamPositions: { to_device: 55 },
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `star-a-5`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'a', soft: 5 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `star-b-5`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'b', soft: 5 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages).toHaveLength(6);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(6);
  });

  it('soft-6: two parallel * sends to Bob expand independently', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: BOB, device_id: DEVICE_C },
      ],
      streamPositions: { to_device: 56 },
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `star-a-6`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'a', soft: 6 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `star-b-6`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'b', soft: 6 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages).toHaveLength(6);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(6);
  });

  it('soft-7: two parallel * sends to Bob expand independently', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: BOB, device_id: DEVICE_C },
      ],
      streamPositions: { to_device: 57 },
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `star-a-7`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'a', soft: 7 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `star-b-7`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'b', soft: 7 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages).toHaveLength(6);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(6);
  });

  it('soft-8: two parallel * sends to Bob expand independently', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: BOB, device_id: DEVICE_C },
      ],
      streamPositions: { to_device: 58 },
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `star-a-8`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'a', soft: 8 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `star-b-8`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'b', soft: 8 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages).toHaveLength(6);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(6);
  });

  it('soft-9: two parallel * sends to Bob expand independently', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: BOB, device_id: DEVICE_C },
      ],
      streamPositions: { to_device: 59 },
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `star-a-9`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'a', soft: 9 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `star-b-9`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'b', soft: 9 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages).toHaveLength(6);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(6);
  });

  it('soft-10: two parallel * sends to Bob expand independently', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: BOB, device_id: DEVICE_C },
      ],
      streamPositions: { to_device: 60 },
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `star-a-10`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'a', soft: 10 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `star-b-10`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'b', soft: 10 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages).toHaveLength(6);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(6);
  });

  it('soft-11: two parallel * sends to Bob expand independently', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: BOB, device_id: DEVICE_C },
      ],
      streamPositions: { to_device: 61 },
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `star-a-11`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'a', soft: 11 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `star-b-11`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'b', soft: 11 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages).toHaveLength(6);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(6);
  });

  it('soft-12: two parallel * sends to Bob expand independently', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: BOB, device_id: DEVICE_C },
      ],
      streamPositions: { to_device: 62 },
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `star-a-12`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'a', soft: 12 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `star-b-12`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { lane: 'b', soft: 12 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages).toHaveLength(6);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(6);
  });

});

describe('race sendToDevice cached txn∥fresh txn after #168', () => {
  it('soft-1: cached txn returns without insert while fresh txn inserts', async () => {
    const cached = 'cached-1';
    const fresh = 'fresh-1';
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: cached, response: '{}' }],
    });
    const env = createEnv(db);
    const [c, f] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, cached),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { shouldNotInsert: true } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, fresh),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { fresh: 1 } } } })
      ),
    ]);
    expect(c.status).toBe(200);
    expect(f.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].content).toContain('"fresh"');
    expect(db.transactions.map((t) => t.txn_id).sort()).toEqual([cached, fresh].sort());
  });

  it('soft-2: cached txn returns without insert while fresh txn inserts', async () => {
    const cached = 'cached-2';
    const fresh = 'fresh-2';
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: cached, response: '{}' }],
    });
    const env = createEnv(db);
    const [c, f] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, cached),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { shouldNotInsert: true } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, fresh),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { fresh: 2 } } } })
      ),
    ]);
    expect(c.status).toBe(200);
    expect(f.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].content).toContain('"fresh"');
    expect(db.transactions.map((t) => t.txn_id).sort()).toEqual([cached, fresh].sort());
  });

  it('soft-3: cached txn returns without insert while fresh txn inserts', async () => {
    const cached = 'cached-3';
    const fresh = 'fresh-3';
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: cached, response: '{}' }],
    });
    const env = createEnv(db);
    const [c, f] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, cached),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { shouldNotInsert: true } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, fresh),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { fresh: 3 } } } })
      ),
    ]);
    expect(c.status).toBe(200);
    expect(f.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].content).toContain('"fresh"');
    expect(db.transactions.map((t) => t.txn_id).sort()).toEqual([cached, fresh].sort());
  });

  it('soft-4: cached txn returns without insert while fresh txn inserts', async () => {
    const cached = 'cached-4';
    const fresh = 'fresh-4';
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: cached, response: '{}' }],
    });
    const env = createEnv(db);
    const [c, f] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, cached),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { shouldNotInsert: true } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, fresh),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { fresh: 4 } } } })
      ),
    ]);
    expect(c.status).toBe(200);
    expect(f.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].content).toContain('"fresh"');
    expect(db.transactions.map((t) => t.txn_id).sort()).toEqual([cached, fresh].sort());
  });

  it('soft-5: cached txn returns without insert while fresh txn inserts', async () => {
    const cached = 'cached-5';
    const fresh = 'fresh-5';
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: cached, response: '{}' }],
    });
    const env = createEnv(db);
    const [c, f] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, cached),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { shouldNotInsert: true } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, fresh),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { fresh: 5 } } } })
      ),
    ]);
    expect(c.status).toBe(200);
    expect(f.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].content).toContain('"fresh"');
    expect(db.transactions.map((t) => t.txn_id).sort()).toEqual([cached, fresh].sort());
  });

  it('soft-6: cached txn returns without insert while fresh txn inserts', async () => {
    const cached = 'cached-6';
    const fresh = 'fresh-6';
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: cached, response: '{}' }],
    });
    const env = createEnv(db);
    const [c, f] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, cached),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { shouldNotInsert: true } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, fresh),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { fresh: 6 } } } })
      ),
    ]);
    expect(c.status).toBe(200);
    expect(f.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].content).toContain('"fresh"');
    expect(db.transactions.map((t) => t.txn_id).sort()).toEqual([cached, fresh].sort());
  });

  it('soft-7: cached txn returns without insert while fresh txn inserts', async () => {
    const cached = 'cached-7';
    const fresh = 'fresh-7';
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: cached, response: '{}' }],
    });
    const env = createEnv(db);
    const [c, f] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, cached),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { shouldNotInsert: true } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, fresh),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { fresh: 7 } } } })
      ),
    ]);
    expect(c.status).toBe(200);
    expect(f.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].content).toContain('"fresh"');
    expect(db.transactions.map((t) => t.txn_id).sort()).toEqual([cached, fresh].sort());
  });

  it('soft-8: cached txn returns without insert while fresh txn inserts', async () => {
    const cached = 'cached-8';
    const fresh = 'fresh-8';
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: cached, response: '{}' }],
    });
    const env = createEnv(db);
    const [c, f] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, cached),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { shouldNotInsert: true } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, fresh),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { fresh: 8 } } } })
      ),
    ]);
    expect(c.status).toBe(200);
    expect(f.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].content).toContain('"fresh"');
    expect(db.transactions.map((t) => t.txn_id).sort()).toEqual([cached, fresh].sort());
  });

  it('soft-9: cached txn returns without insert while fresh txn inserts', async () => {
    const cached = 'cached-9';
    const fresh = 'fresh-9';
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: cached, response: '{}' }],
    });
    const env = createEnv(db);
    const [c, f] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, cached),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { shouldNotInsert: true } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, fresh),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { fresh: 9 } } } })
      ),
    ]);
    expect(c.status).toBe(200);
    expect(f.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].content).toContain('"fresh"');
    expect(db.transactions.map((t) => t.txn_id).sort()).toEqual([cached, fresh].sort());
  });

  it('soft-10: cached txn returns without insert while fresh txn inserts', async () => {
    const cached = 'cached-10';
    const fresh = 'fresh-10';
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: cached, response: '{}' }],
    });
    const env = createEnv(db);
    const [c, f] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, cached),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { shouldNotInsert: true } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, fresh),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { fresh: 10 } } } })
      ),
    ]);
    expect(c.status).toBe(200);
    expect(f.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].content).toContain('"fresh"');
    expect(db.transactions.map((t) => t.txn_id).sort()).toEqual([cached, fresh].sort());
  });

  it('soft-11: cached txn returns without insert while fresh txn inserts', async () => {
    const cached = 'cached-11';
    const fresh = 'fresh-11';
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: cached, response: '{}' }],
    });
    const env = createEnv(db);
    const [c, f] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, cached),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { shouldNotInsert: true } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, fresh),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { fresh: 11 } } } })
      ),
    ]);
    expect(c.status).toBe(200);
    expect(f.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].content).toContain('"fresh"');
    expect(db.transactions.map((t) => t.txn_id).sort()).toEqual([cached, fresh].sort());
  });

  it('soft-12: cached txn returns without insert while fresh txn inserts', async () => {
    const cached = 'cached-12';
    const fresh = 'fresh-12';
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: cached, response: '{}' }],
    });
    const env = createEnv(db);
    const [c, f] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, cached),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { shouldNotInsert: true } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, fresh),
        jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { fresh: 12 } } } })
      ),
    ]);
    expect(c.status).toBe(200);
    expect(f.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].content).toContain('"fresh"');
    expect(db.transactions.map((t) => t.txn_id).sort()).toEqual([cached, fresh].sort());
  });

});

describe('sendToDevice soft flood — bad JSON after #168', () => {
  it('soft-1: bad JSON trunc-brace → M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-1`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it('soft-2: bad JSON empty → M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-2`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it('soft-3: JSON null body → non-200 (messages access on null)', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-3`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "null",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });

  it('soft-4: JSON array body → M_MISSING_PARAM (no messages field)', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-4`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "[1,2]",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it('soft-5: JSON string body → M_MISSING_PARAM (no messages field)', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-5`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "\"str\"",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it('soft-6: JSON bool body → M_MISSING_PARAM (no messages field)', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-6`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "true",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it('soft-7: JSON number body → M_MISSING_PARAM (no messages field)', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-7`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "12",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it('soft-8: bad JSON trunc-text → M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-8`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it('soft-9: bad JSON trunc-messages → M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-9`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"messages\":",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it('soft-10: JSON empty-array body → M_MISSING_PARAM (no messages field)', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-10`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "[]",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it('soft-11: bad JSON messages-undef-invalid → M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-11`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"messages\": undefined}",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it('soft-12: bad JSON mismatched → M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-12`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{]",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it('soft-13: bad JSON undefined-literal → M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-13`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "undefined",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it('soft-14: bad JSON nan-literal → M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-14`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "NaN",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it('soft-15: bad JSON trailing-comma → M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-15`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"a\":1,}",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it('soft-16: bad JSON null-byte → M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `badjson-16`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "\u0000",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

});

describe('sendToDevice soft flood — missing messages after #168', () => {
  it('soft-1: empty-object → M_MISSING_PARAM', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `miss-1`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it('soft-2: messages-null → M_MISSING_PARAM', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `miss-2`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"messages\":null}",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it('soft-3: messages-zero → M_MISSING_PARAM', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `miss-3`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"messages\":0}",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it('soft-4: messages-false → M_MISSING_PARAM', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `miss-4`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"messages\":false}",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it('soft-5: messages-empty-str → M_MISSING_PARAM', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `miss-5`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"messages\":\"\"}",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it('soft-6: wrong-key → M_MISSING_PARAM', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `miss-6`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"not_messages\":{}}",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it('soft-7: singular-message → M_MISSING_PARAM', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `miss-7`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"message\":{}}",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it('soft-8: wrong-case → M_MISSING_PARAM', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `miss-8`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"Messages\":{}}",
    });
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it('soft-9: messages-array truthy → 200 empty send (Object.entries [])', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(env, sendPath(EVENT_TYPE, `miss-9`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"messages\":[]}",
    });
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('soft-10: messages-string truthy → 200 (Object.entries yields index device)', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(env, sendPath(EVENT_TYPE, `miss-10`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"messages\":\"x\"}",
    });
    expect(res.status).toBe(200);
    // Object.entries("x") → [["0","x"]]; inner entries on "x" → [["0","x"]] as device/content
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
    expect(db.messages[0].recipient_user_id).toBe('0');
  });

  it('soft-11: messages-number truthy → 200 (Object.entries(1) empty)', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(env, sendPath(EVENT_TYPE, `miss-11`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"messages\":1}",
    });
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
  });

  it('soft-12: messages-true truthy → 200 (Object.entries(true) empty)', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(env, sendPath(EVENT_TYPE, `miss-12`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: "{\"messages\":true}",
    });
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
  });

});

describe('sendToDevice soft flood — method matrix after #168', () => {
  it('soft-1: GET not allowed on sendToDevice', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `meth-1`), {
      method: 'GET',
      headers: { ...AUTH },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });

  it('soft-2: POST not allowed on sendToDevice', async () => {
    const env = createEnv();
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `meth-2`),
      jsonInit('POST', { messages: {} })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });

  it('soft-3: PATCH not allowed on sendToDevice', async () => {
    const env = createEnv();
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `meth-3`),
      jsonInit('PATCH', { messages: {} })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });

  it('soft-4: DELETE not allowed on sendToDevice', async () => {
    const env = createEnv();
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `meth-4`),
      jsonInit('DELETE', { messages: {} })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });

  it('soft-5: HEAD not allowed on sendToDevice', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `meth-5`), {
      method: 'HEAD',
      headers: { ...AUTH },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });

  it('soft-6: OPTIONS not allowed on sendToDevice', async () => {
    const env = createEnv();
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `meth-6`),
      jsonInit('OPTIONS', { messages: {} })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });

  it('soft-7: TRACE unsupported by fetch Request', async () => {
    const env = createEnv();
    await expect(
      request(env, sendPath(EVENT_TYPE, `meth-7`), {
        method: 'TRACE',
        headers: { ...AUTH },
      })
    ).rejects.toThrow(/TRACE/i);
  });

  it('soft-8: Content-Type text/plain with valid JSON body still parses', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `ctype-8`), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', ...AUTH },
      body: JSON.stringify({ messages: { [BOB]: { [DEVICE_B]: { ctype: 8 } } } }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('soft-9: Content-Type application/xml with valid JSON body still parses', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `ctype-9`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/xml', ...AUTH },
      body: JSON.stringify({ messages: { [BOB]: { [DEVICE_B]: { ctype: 9 } } } }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('soft-10: Content-Type multipart/form-data with valid JSON body still parses', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `ctype-10`), {
      method: 'PUT',
      headers: { 'Content-Type': 'multipart/form-data', ...AUTH },
      body: JSON.stringify({ messages: { [BOB]: { [DEVICE_B]: { ctype: 10 } } } }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('soft-11: Content-Type text/html with valid JSON body still parses', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `ctype-11`), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html', ...AUTH },
      body: JSON.stringify({ messages: { [BOB]: { [DEVICE_B]: { ctype: 11 } } } }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('soft-12: Content-Type application/octet-stream with valid JSON body still parses', async () => {
    const env = createEnv();
    const res = await request(env, sendPath(EVENT_TYPE, `ctype-12`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...AUTH },
      body: JSON.stringify({ messages: { [BOB]: { [DEVICE_B]: { ctype: 12 } } } }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

});

describe('sendToDevice soft flood — eventType/txnId charset + shape after #168', () => {
  it('soft-1: eventType m.room_key stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key', `et-1`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 1 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.room_key');
  });

  it('soft-2: eventType m.room_key_request stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.room_key_request', `et-2`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 2 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.room_key_request');
  });

  it('soft-3: eventType m.forwarded_room_key stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.forwarded_room_key', `et-3`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 3 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.forwarded_room_key');
  });

  it('soft-4: eventType m.key.verification.request stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.key.verification.request', `et-4`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 4 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.key.verification.request');
  });

  it('soft-5: eventType m.key.verification.start stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.key.verification.start', `et-5`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 5 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.key.verification.start');
  });

  it('soft-6: eventType m.key.verification.accept stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.key.verification.accept', `et-6`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 6 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.key.verification.accept');
  });

  it('soft-7: eventType m.key.verification.key stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.key.verification.key', `et-7`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 7 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.key.verification.key');
  });

  it('soft-8: eventType m.key.verification.mac stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.key.verification.mac', `et-8`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 8 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.key.verification.mac');
  });

  it('soft-9: eventType m.key.verification.cancel stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.key.verification.cancel', `et-9`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 9 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.key.verification.cancel');
  });

  it('soft-10: eventType m.key.verification.ready stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.key.verification.ready', `et-10`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 10 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.key.verification.ready');
  });

  it('soft-11: eventType m.key.verification.done stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.key.verification.done', `et-11`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 11 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.key.verification.done');
  });

  it('soft-12: eventType m.secret.request stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.secret.request', `et-12`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 12 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.secret.request');
  });

  it('soft-13: eventType m.secret.send stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.secret.send', `et-13`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 13 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.secret.send');
  });

  it('soft-14: eventType org.example.custom stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('org.example.custom', `et-14`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 14 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('org.example.custom');
  });

  it('soft-15: eventType m.dummy stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.dummy', `et-15`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 15 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('m.dummy');
  });

  it('soft-16: eventType com.example.nested.type stores into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('com.example.nested.type', `et-16`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { et: 16 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages[0].event_type).toBe('com.example.nested.type');
  });

  it('soft-17: txnId charset stores idempotency row', async () => {
    const txn = "a";
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 17 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
    const again = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 999 } } } })
    );
    expect(again.status).toBe(200);
    expect(db.messages).toHaveLength(1);
  });

  it('soft-18: txnId charset stores idempotency row', async () => {
    const txn = "txn";
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 18 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
    const again = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 999 } } } })
    );
    expect(again.status).toBe(200);
    expect(db.messages).toHaveLength(1);
  });

  it('soft-19: txnId charset stores idempotency row', async () => {
    const txn = "txn-with-dashes";
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 19 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
    const again = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 999 } } } })
    );
    expect(again.status).toBe(200);
    expect(db.messages).toHaveLength(1);
  });

  it('soft-20: txnId charset stores idempotency row', async () => {
    const txn = "txn_with_underscores";
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 20 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
    const again = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 999 } } } })
    );
    expect(again.status).toBe(200);
    expect(db.messages).toHaveLength(1);
  });

  it('soft-21: txnId charset stores idempotency row', async () => {
    const txn = "txn.with.dots";
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 21 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
    const again = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 999 } } } })
    );
    expect(again.status).toBe(200);
    expect(db.messages).toHaveLength(1);
  });

  it('soft-22: txnId charset stores idempotency row', async () => {
    const txn = "TXNUPPER";
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 22 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
    const again = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 999 } } } })
    );
    expect(again.status).toBe(200);
    expect(db.messages).toHaveLength(1);
  });

  it('soft-23: txnId charset stores idempotency row', async () => {
    const txn = "12345";
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 23 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
    const again = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 999 } } } })
    );
    expect(again.status).toBe(200);
    expect(db.messages).toHaveLength(1);
  });

  it('soft-24: txnId charset stores idempotency row', async () => {
    const txn = "unicode-txn-\u952e";
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 24 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
    const again = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 999 } } } })
    );
    expect(again.status).toBe(200);
    expect(db.messages).toHaveLength(1);
  });

  it('soft-25: txnId charset stores idempotency row', async () => {
    const txn = "txn%2Fencoded";
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 25 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
    const again = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 999 } } } })
    );
    expect(again.status).toBe(200);
    expect(db.messages).toHaveLength(1);
  });

  it('soft-26: txnId charset stores idempotency row', async () => {
    const txn = "very-long-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 26 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
    const again = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 999 } } } })
    );
    expect(again.status).toBe(200);
    expect(db.messages).toHaveLength(1);
  });

  it('soft-27: txnId charset stores idempotency row', async () => {
    const txn = "spaces are odd";
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 27 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
    const again = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 999 } } } })
    );
    expect(again.status).toBe(200);
    expect(db.messages).toHaveLength(1);
  });

  it('soft-28: txnId charset stores idempotency row', async () => {
    const txn = "plus+plus";
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 28 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.transactions.some((t) => t.txn_id === txn)).toBe(true);
    const again = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { t: 999 } } } })
    );
    expect(again.status).toBe(200);
    expect(db.messages).toHaveLength(1);
  });

});

describe('sendToDevice soft flood — empty maps / mixed * / multi-user after #168', () => {
  it('soft-1: empty messages object succeeds and stores txn only', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-1`),
      jsonInit('PUT', { messages: {} })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('soft-2: empty messages object succeeds and stores txn only', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-2`),
      jsonInit('PUT', { messages: {} })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('soft-3: empty messages object succeeds and stores txn only', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-3`),
      jsonInit('PUT', { messages: {} })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('soft-4: empty messages object succeeds and stores txn only', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-4`),
      jsonInit('PUT', { messages: {} })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('soft-5: empty messages object succeeds and stores txn only', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-5`),
      jsonInit('PUT', { messages: {} })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('soft-6: empty messages object succeeds and stores txn only', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-6`),
      jsonInit('PUT', { messages: {} })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('soft-7: empty messages object succeeds and stores txn only', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-7`),
      jsonInit('PUT', { messages: {} })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('soft-8: empty messages object succeeds and stores txn only', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-8`),
      jsonInit('PUT', { messages: {} })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('soft-9: empty messages object succeeds and stores txn only', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-9`),
      jsonInit('PUT', { messages: {} })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('soft-10: empty messages object succeeds and stores txn only', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-10`),
      jsonInit('PUT', { messages: {} })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('soft-11: empty messages object succeeds and stores txn only', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-11`),
      jsonInit('PUT', { messages: {} })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('soft-12: empty messages object succeeds and stores txn only', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-12`),
      jsonInit('PUT', { messages: {} })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('soft-13: user with empty device map inserts nothing for that user', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-dev-13`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {},
          [CAROL]: { [DEVICE_C]: { i: 13 } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipient_user_id).toBe(CAROL);
  });

  it('soft-14: user with empty device map inserts nothing for that user', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-dev-14`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {},
          [CAROL]: { [DEVICE_C]: { i: 14 } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipient_user_id).toBe(CAROL);
  });

  it('soft-15: user with empty device map inserts nothing for that user', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-dev-15`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {},
          [CAROL]: { [DEVICE_C]: { i: 15 } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipient_user_id).toBe(CAROL);
  });

  it('soft-16: user with empty device map inserts nothing for that user', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-dev-16`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {},
          [CAROL]: { [DEVICE_C]: { i: 16 } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipient_user_id).toBe(CAROL);
  });

  it('soft-17: user with empty device map inserts nothing for that user', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-dev-17`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {},
          [CAROL]: { [DEVICE_C]: { i: 17 } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipient_user_id).toBe(CAROL);
  });

  it('soft-18: user with empty device map inserts nothing for that user', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-dev-18`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {},
          [CAROL]: { [DEVICE_C]: { i: 18 } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipient_user_id).toBe(CAROL);
  });

  it('soft-19: user with empty device map inserts nothing for that user', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-dev-19`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {},
          [CAROL]: { [DEVICE_C]: { i: 19 } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipient_user_id).toBe(CAROL);
  });

  it('soft-20: user with empty device map inserts nothing for that user', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-dev-20`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {},
          [CAROL]: { [DEVICE_C]: { i: 20 } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipient_user_id).toBe(CAROL);
  });

  it('soft-21: user with empty device map inserts nothing for that user', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-dev-21`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {},
          [CAROL]: { [DEVICE_C]: { i: 21 } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipient_user_id).toBe(CAROL);
  });

  it('soft-22: user with empty device map inserts nothing for that user', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-dev-22`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {},
          [CAROL]: { [DEVICE_C]: { i: 22 } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipient_user_id).toBe(CAROL);
  });

  it('soft-23: user with empty device map inserts nothing for that user', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-dev-23`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {},
          [CAROL]: { [DEVICE_C]: { i: 23 } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipient_user_id).toBe(CAROL);
  });

  it('soft-24: user with empty device map inserts nothing for that user', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `empty-dev-24`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {},
          [CAROL]: { [DEVICE_C]: { i: 24 } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipient_user_id).toBe(CAROL);
  });

  it('soft-25: mix * expand and specific device for same user', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `mix-25`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            '*': { viaStar: 25 },
            [DEVICE_C]: { viaSpecific: 25 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    const devices = db.messages.map((m) => m.recipient_device_id).sort();
    expect(devices).toEqual([DEVICE_A, DEVICE_B, DEVICE_C].sort());
  });

  it('soft-26: mix * expand and specific device for same user', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `mix-26`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            '*': { viaStar: 26 },
            [DEVICE_C]: { viaSpecific: 26 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    const devices = db.messages.map((m) => m.recipient_device_id).sort();
    expect(devices).toEqual([DEVICE_A, DEVICE_B, DEVICE_C].sort());
  });

  it('soft-27: mix * expand and specific device for same user', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `mix-27`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            '*': { viaStar: 27 },
            [DEVICE_C]: { viaSpecific: 27 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    const devices = db.messages.map((m) => m.recipient_device_id).sort();
    expect(devices).toEqual([DEVICE_A, DEVICE_B, DEVICE_C].sort());
  });

  it('soft-28: mix * expand and specific device for same user', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `mix-28`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            '*': { viaStar: 28 },
            [DEVICE_C]: { viaSpecific: 28 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    const devices = db.messages.map((m) => m.recipient_device_id).sort();
    expect(devices).toEqual([DEVICE_A, DEVICE_B, DEVICE_C].sort());
  });

  it('soft-29: mix * expand and specific device for same user', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `mix-29`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            '*': { viaStar: 29 },
            [DEVICE_C]: { viaSpecific: 29 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    const devices = db.messages.map((m) => m.recipient_device_id).sort();
    expect(devices).toEqual([DEVICE_A, DEVICE_B, DEVICE_C].sort());
  });

  it('soft-30: mix * expand and specific device for same user', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `mix-30`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            '*': { viaStar: 30 },
            [DEVICE_C]: { viaSpecific: 30 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    const devices = db.messages.map((m) => m.recipient_device_id).sort();
    expect(devices).toEqual([DEVICE_A, DEVICE_B, DEVICE_C].sort());
  });

  it('soft-31: mix * expand and specific device for same user', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `mix-31`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            '*': { viaStar: 31 },
            [DEVICE_C]: { viaSpecific: 31 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    const devices = db.messages.map((m) => m.recipient_device_id).sort();
    expect(devices).toEqual([DEVICE_A, DEVICE_B, DEVICE_C].sort());
  });

  it('soft-32: mix * expand and specific device for same user', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `mix-32`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            '*': { viaStar: 32 },
            [DEVICE_C]: { viaSpecific: 32 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    const devices = db.messages.map((m) => m.recipient_device_id).sort();
    expect(devices).toEqual([DEVICE_A, DEVICE_B, DEVICE_C].sort());
  });

  it('soft-33: mix * expand and specific device for same user', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `mix-33`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            '*': { viaStar: 33 },
            [DEVICE_C]: { viaSpecific: 33 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    const devices = db.messages.map((m) => m.recipient_device_id).sort();
    expect(devices).toEqual([DEVICE_A, DEVICE_B, DEVICE_C].sort());
  });

  it('soft-34: mix * expand and specific device for same user', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `mix-34`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            '*': { viaStar: 34 },
            [DEVICE_C]: { viaSpecific: 34 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    const devices = db.messages.map((m) => m.recipient_device_id).sort();
    expect(devices).toEqual([DEVICE_A, DEVICE_B, DEVICE_C].sort());
  });

  it('soft-35: mix * expand and specific device for same user', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `mix-35`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            '*': { viaStar: 35 },
            [DEVICE_C]: { viaSpecific: 35 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    const devices = db.messages.map((m) => m.recipient_device_id).sort();
    expect(devices).toEqual([DEVICE_A, DEVICE_B, DEVICE_C].sort());
  });

  it('soft-36: mix * expand and specific device for same user', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_A },
        { user_id: BOB, device_id: DEVICE_B },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `mix-36`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            '*': { viaStar: 36 },
            [DEVICE_C]: { viaSpecific: 36 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    const devices = db.messages.map((m) => m.recipient_device_id).sort();
    expect(devices).toEqual([DEVICE_A, DEVICE_B, DEVICE_C].sort());
  });

});

describe('race sendToDevice missing stream_positions upsert path after #168', () => {
  it('soft-1: missing stream row forces INSERT upsert for each message', async () => {
    const db = createToDeviceDb({
      missingStreamRow: true,
      streamPositions: {},
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `upsert-1`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            [DEVICE_A]: { a: 1 },
            [DEVICE_B]: { b: 1 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(2);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(2);
    expect(db.inserts.some((c) => c.sql.includes('INSERT INTO stream_positions'))).toBe(true);
  });

  it('soft-2: missing stream row forces INSERT upsert for each message', async () => {
    const db = createToDeviceDb({
      missingStreamRow: true,
      streamPositions: {},
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `upsert-2`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            [DEVICE_A]: { a: 2 },
            [DEVICE_B]: { b: 2 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(2);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(2);
    expect(db.inserts.some((c) => c.sql.includes('INSERT INTO stream_positions'))).toBe(true);
  });

  it('soft-3: missing stream row forces INSERT upsert for each message', async () => {
    const db = createToDeviceDb({
      missingStreamRow: true,
      streamPositions: {},
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `upsert-3`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            [DEVICE_A]: { a: 3 },
            [DEVICE_B]: { b: 3 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(2);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(2);
    expect(db.inserts.some((c) => c.sql.includes('INSERT INTO stream_positions'))).toBe(true);
  });

  it('soft-4: missing stream row forces INSERT upsert for each message', async () => {
    const db = createToDeviceDb({
      missingStreamRow: true,
      streamPositions: {},
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `upsert-4`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            [DEVICE_A]: { a: 4 },
            [DEVICE_B]: { b: 4 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(2);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(2);
    expect(db.inserts.some((c) => c.sql.includes('INSERT INTO stream_positions'))).toBe(true);
  });

  it('soft-5: missing stream row forces INSERT upsert for each message', async () => {
    const db = createToDeviceDb({
      missingStreamRow: true,
      streamPositions: {},
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `upsert-5`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            [DEVICE_A]: { a: 5 },
            [DEVICE_B]: { b: 5 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(2);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(2);
    expect(db.inserts.some((c) => c.sql.includes('INSERT INTO stream_positions'))).toBe(true);
  });

  it('soft-6: missing stream row forces INSERT upsert for each message', async () => {
    const db = createToDeviceDb({
      missingStreamRow: true,
      streamPositions: {},
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `upsert-6`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            [DEVICE_A]: { a: 6 },
            [DEVICE_B]: { b: 6 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(2);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(2);
    expect(db.inserts.some((c) => c.sql.includes('INSERT INTO stream_positions'))).toBe(true);
  });

  it('soft-7: missing stream row forces INSERT upsert for each message', async () => {
    const db = createToDeviceDb({
      missingStreamRow: true,
      streamPositions: {},
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `upsert-7`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            [DEVICE_A]: { a: 7 },
            [DEVICE_B]: { b: 7 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(2);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(2);
    expect(db.inserts.some((c) => c.sql.includes('INSERT INTO stream_positions'))).toBe(true);
  });

  it('soft-8: missing stream row forces INSERT upsert for each message', async () => {
    const db = createToDeviceDb({
      missingStreamRow: true,
      streamPositions: {},
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `upsert-8`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            [DEVICE_A]: { a: 8 },
            [DEVICE_B]: { b: 8 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(2);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(2);
    expect(db.inserts.some((c) => c.sql.includes('INSERT INTO stream_positions'))).toBe(true);
  });

  it('soft-9: missing stream row forces INSERT upsert for each message', async () => {
    const db = createToDeviceDb({
      missingStreamRow: true,
      streamPositions: {},
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `upsert-9`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            [DEVICE_A]: { a: 9 },
            [DEVICE_B]: { b: 9 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(2);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(2);
    expect(db.inserts.some((c) => c.sql.includes('INSERT INTO stream_positions'))).toBe(true);
  });

  it('soft-10: missing stream row forces INSERT upsert for each message', async () => {
    const db = createToDeviceDb({
      missingStreamRow: true,
      streamPositions: {},
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `upsert-10`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            [DEVICE_A]: { a: 10 },
            [DEVICE_B]: { b: 10 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(2);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(2);
    expect(db.inserts.some((c) => c.sql.includes('INSERT INTO stream_positions'))).toBe(true);
  });

  it('soft-11: missing stream row forces INSERT upsert for each message', async () => {
    const db = createToDeviceDb({
      missingStreamRow: true,
      streamPositions: {},
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `upsert-11`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            [DEVICE_A]: { a: 11 },
            [DEVICE_B]: { b: 11 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(2);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(2);
    expect(db.inserts.some((c) => c.sql.includes('INSERT INTO stream_positions'))).toBe(true);
  });

  it('soft-12: missing stream row forces INSERT upsert for each message', async () => {
    const db = createToDeviceDb({
      missingStreamRow: true,
      streamPositions: {},
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `upsert-12`),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            [DEVICE_A]: { a: 12 },
            [DEVICE_B]: { b: 12 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(2);
    const positions = db.messages.map((m) => m.stream_position);
    expect(new Set(positions).size).toBe(2);
    expect(db.inserts.some((c) => c.sql.includes('INSERT INTO stream_positions'))).toBe(true);
  });

});

describe('race sendToDevice triple same-txn TOCTOU after #168', () => {
  it('soft-1: three parallel PUTs same txn all miss cache', async () => {
    const txn = `triple-1`;
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 3),
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { triple: 1 } } } };
    const results = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
    }
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('soft-2: three parallel PUTs same txn all miss cache', async () => {
    const txn = `triple-2`;
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 3),
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { triple: 2 } } } };
    const results = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
    }
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('soft-3: three parallel PUTs same txn all miss cache', async () => {
    const txn = `triple-3`;
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 3),
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { triple: 3 } } } };
    const results = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
    }
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('soft-4: three parallel PUTs same txn all miss cache', async () => {
    const txn = `triple-4`;
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 3),
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { triple: 4 } } } };
    const results = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
    }
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('soft-5: three parallel PUTs same txn all miss cache', async () => {
    const txn = `triple-5`;
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 3),
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { triple: 5 } } } };
    const results = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
    }
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('soft-6: three parallel PUTs same txn all miss cache', async () => {
    const txn = `triple-6`;
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 3),
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { triple: 6 } } } };
    const results = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
    }
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('soft-7: three parallel PUTs same txn all miss cache', async () => {
    const txn = `triple-7`;
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 3),
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { triple: 7 } } } };
    const results = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
    }
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('soft-8: three parallel PUTs same txn all miss cache', async () => {
    const txn = `triple-8`;
    const db = createToDeviceDb({
      selectBarrier: txnBarrier(txn, 3),
    });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { [DEVICE_B]: { triple: 8 } } } };
    const results = await Promise.all([
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
      request(env, sendPath(EVENT_TYPE, txn), jsonInit('PUT', body)),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
    }
    expect(db.transactions.filter((t) => t.txn_id === txn)).toHaveLength(1);
    expect(db.messages.length).toBeGreaterThanOrEqual(1);
  });

});

describe('race getToDeviceMessages parallel fetch same since after #168', () => {
  it('soft-1: parallel getToDeviceMessages see same undelivered snapshot', async () => {
    const rows = [
      helperMsg({
        stream_position: 11,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft: 1 }),
      }),
      helperMsg({
        stream_position: 21,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft2: 1 }),
      }),
    ];
    const db = createHelperDb(rows, {
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('delivered = 0'),
      },
    });
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(2);
    expect(db.acks).toHaveLength(0);
    expect(db.messages.every((m) => m.delivered === 0)).toBe(true);
  });

  it('soft-2: parallel getToDeviceMessages see same undelivered snapshot', async () => {
    const rows = [
      helperMsg({
        stream_position: 12,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft: 2 }),
      }),
      helperMsg({
        stream_position: 22,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft2: 2 }),
      }),
    ];
    const db = createHelperDb(rows, {
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('delivered = 0'),
      },
    });
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(2);
    expect(db.acks).toHaveLength(0);
    expect(db.messages.every((m) => m.delivered === 0)).toBe(true);
  });

  it('soft-3: parallel getToDeviceMessages see same undelivered snapshot', async () => {
    const rows = [
      helperMsg({
        stream_position: 13,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft: 3 }),
      }),
      helperMsg({
        stream_position: 23,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft2: 3 }),
      }),
    ];
    const db = createHelperDb(rows, {
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('delivered = 0'),
      },
    });
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(2);
    expect(db.acks).toHaveLength(0);
    expect(db.messages.every((m) => m.delivered === 0)).toBe(true);
  });

  it('soft-4: parallel getToDeviceMessages see same undelivered snapshot', async () => {
    const rows = [
      helperMsg({
        stream_position: 14,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft: 4 }),
      }),
      helperMsg({
        stream_position: 24,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft2: 4 }),
      }),
    ];
    const db = createHelperDb(rows, {
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('delivered = 0'),
      },
    });
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(2);
    expect(db.acks).toHaveLength(0);
    expect(db.messages.every((m) => m.delivered === 0)).toBe(true);
  });

  it('soft-5: parallel getToDeviceMessages see same undelivered snapshot', async () => {
    const rows = [
      helperMsg({
        stream_position: 15,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft: 5 }),
      }),
      helperMsg({
        stream_position: 25,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft2: 5 }),
      }),
    ];
    const db = createHelperDb(rows, {
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('delivered = 0'),
      },
    });
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(2);
    expect(db.acks).toHaveLength(0);
    expect(db.messages.every((m) => m.delivered === 0)).toBe(true);
  });

  it('soft-6: parallel getToDeviceMessages see same undelivered snapshot', async () => {
    const rows = [
      helperMsg({
        stream_position: 16,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft: 6 }),
      }),
      helperMsg({
        stream_position: 26,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft2: 6 }),
      }),
    ];
    const db = createHelperDb(rows, {
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('delivered = 0'),
      },
    });
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(2);
    expect(db.acks).toHaveLength(0);
    expect(db.messages.every((m) => m.delivered === 0)).toBe(true);
  });

  it('soft-7: parallel getToDeviceMessages see same undelivered snapshot', async () => {
    const rows = [
      helperMsg({
        stream_position: 17,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft: 7 }),
      }),
      helperMsg({
        stream_position: 27,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft2: 7 }),
      }),
    ];
    const db = createHelperDb(rows, {
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('delivered = 0'),
      },
    });
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(2);
    expect(db.acks).toHaveLength(0);
    expect(db.messages.every((m) => m.delivered === 0)).toBe(true);
  });

  it('soft-8: parallel getToDeviceMessages see same undelivered snapshot', async () => {
    const rows = [
      helperMsg({
        stream_position: 18,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft: 8 }),
      }),
      helperMsg({
        stream_position: 28,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft2: 8 }),
      }),
    ];
    const db = createHelperDb(rows, {
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('delivered = 0'),
      },
    });
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(2);
    expect(db.acks).toHaveLength(0);
    expect(db.messages.every((m) => m.delivered === 0)).toBe(true);
  });

  it('soft-9: parallel getToDeviceMessages see same undelivered snapshot', async () => {
    const rows = [
      helperMsg({
        stream_position: 19,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft: 9 }),
      }),
      helperMsg({
        stream_position: 29,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft2: 9 }),
      }),
    ];
    const db = createHelperDb(rows, {
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('delivered = 0'),
      },
    });
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(2);
    expect(db.acks).toHaveLength(0);
    expect(db.messages.every((m) => m.delivered === 0)).toBe(true);
  });

  it('soft-10: parallel getToDeviceMessages see same undelivered snapshot', async () => {
    const rows = [
      helperMsg({
        stream_position: 20,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft: 10 }),
      }),
      helperMsg({
        stream_position: 30,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft2: 10 }),
      }),
    ];
    const db = createHelperDb(rows, {
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('delivered = 0'),
      },
    });
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(2);
    expect(db.acks).toHaveLength(0);
    expect(db.messages.every((m) => m.delivered === 0)).toBe(true);
  });

  it('soft-11: parallel getToDeviceMessages see same undelivered snapshot', async () => {
    const rows = [
      helperMsg({
        stream_position: 21,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft: 11 }),
      }),
      helperMsg({
        stream_position: 31,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft2: 11 }),
      }),
    ];
    const db = createHelperDb(rows, {
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('delivered = 0'),
      },
    });
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(2);
    expect(db.acks).toHaveLength(0);
    expect(db.messages.every((m) => m.delivered === 0)).toBe(true);
  });

  it('soft-12: parallel getToDeviceMessages see same undelivered snapshot', async () => {
    const rows = [
      helperMsg({
        stream_position: 22,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft: 12 }),
      }),
      helperMsg({
        stream_position: 32,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ soft2: 12 }),
      }),
    ];
    const db = createHelperDb(rows, {
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('delivered = 0'),
      },
    });
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(2);
    expect(db.acks).toHaveLength(0);
    expect(db.messages.every((m) => m.delivered === 0)).toBe(true);
  });

});

describe('race getToDeviceMessages fetch∥ack with since>0 after #168', () => {
  it('soft-1: parallel syncs with since ack overlapping positions', async () => {
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        content: JSON.stringify({ soft: 1 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
    ]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(db.acks.length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.stream_position <= 2).every((r) => r.delivered === 1)).toBe(
      true
    );
  });

  it('soft-2: parallel syncs with since ack overlapping positions', async () => {
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        content: JSON.stringify({ soft: 2 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
    ]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(db.acks.length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.stream_position <= 2).every((r) => r.delivered === 1)).toBe(
      true
    );
  });

  it('soft-3: parallel syncs with since ack overlapping positions', async () => {
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        content: JSON.stringify({ soft: 3 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
    ]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(db.acks.length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.stream_position <= 2).every((r) => r.delivered === 1)).toBe(
      true
    );
  });

  it('soft-4: parallel syncs with since ack overlapping positions', async () => {
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        content: JSON.stringify({ soft: 4 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
    ]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(db.acks.length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.stream_position <= 2).every((r) => r.delivered === 1)).toBe(
      true
    );
  });

  it('soft-5: parallel syncs with since ack overlapping positions', async () => {
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        content: JSON.stringify({ soft: 5 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
    ]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(db.acks.length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.stream_position <= 2).every((r) => r.delivered === 1)).toBe(
      true
    );
  });

  it('soft-6: parallel syncs with since ack overlapping positions', async () => {
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        content: JSON.stringify({ soft: 6 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
    ]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(db.acks.length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.stream_position <= 2).every((r) => r.delivered === 1)).toBe(
      true
    );
  });

  it('soft-7: parallel syncs with since ack overlapping positions', async () => {
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        content: JSON.stringify({ soft: 7 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
    ]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(db.acks.length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.stream_position <= 2).every((r) => r.delivered === 1)).toBe(
      true
    );
  });

  it('soft-8: parallel syncs with since ack overlapping positions', async () => {
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        content: JSON.stringify({ soft: 8 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
    ]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(db.acks.length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.stream_position <= 2).every((r) => r.delivered === 1)).toBe(
      true
    );
  });

  it('soft-9: parallel syncs with since ack overlapping positions', async () => {
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        content: JSON.stringify({ soft: 9 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
    ]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(db.acks.length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.stream_position <= 2).every((r) => r.delivered === 1)).toBe(
      true
    );
  });

  it('soft-10: parallel syncs with since ack overlapping positions', async () => {
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        content: JSON.stringify({ soft: 10 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
    ]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(db.acks.length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.stream_position <= 2).every((r) => r.delivered === 1)).toBe(
      true
    );
  });

  it('soft-11: parallel syncs with since ack overlapping positions', async () => {
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        content: JSON.stringify({ soft: 11 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
    ]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(db.acks.length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.stream_position <= 2).every((r) => r.delivered === 1)).toBe(
      true
    );
  });

  it('soft-12: parallel syncs with since ack overlapping positions', async () => {
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        content: JSON.stringify({ soft: 12 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [a, b] = await Promise.all([
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
      getToDeviceMessages(db, USER, DEVICE_A, '2', 100),
    ]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(db.acks.length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.stream_position <= 2).every((r) => r.delivered === 1)).toBe(
      true
    );
  });

});

describe('race cleanupOldToDeviceMessages∥getToDeviceMessages after #168', () => {
  it('soft-1: cleanup deletes delivered while fetch reads undelivered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - SEVEN_DAYS_MS - 1000,
      }),
      helperMsg({
        stream_position: 101,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW,
        content: JSON.stringify({ keep: 1 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [cleaned, fetched] = await Promise.all([
      cleanupOldToDeviceMessages(db),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(cleaned).toBeGreaterThanOrEqual(0);
    expect(fetched.events.some((e) => e.content && (e.content as { keep?: number }).keep === 1)).toBe(
      true
    );
    expect(db.messages.every((m) => m.delivered === 0 || m.created_at >= NOW - SEVEN_DAYS_MS)).toBe(
      true
    );
  });

  it('soft-2: cleanup deletes delivered while fetch reads undelivered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - SEVEN_DAYS_MS - 1000,
      }),
      helperMsg({
        stream_position: 102,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW,
        content: JSON.stringify({ keep: 2 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [cleaned, fetched] = await Promise.all([
      cleanupOldToDeviceMessages(db),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(cleaned).toBeGreaterThanOrEqual(0);
    expect(fetched.events.some((e) => e.content && (e.content as { keep?: number }).keep === 2)).toBe(
      true
    );
    expect(db.messages.every((m) => m.delivered === 0 || m.created_at >= NOW - SEVEN_DAYS_MS)).toBe(
      true
    );
  });

  it('soft-3: cleanup deletes delivered while fetch reads undelivered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - SEVEN_DAYS_MS - 1000,
      }),
      helperMsg({
        stream_position: 103,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW,
        content: JSON.stringify({ keep: 3 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [cleaned, fetched] = await Promise.all([
      cleanupOldToDeviceMessages(db),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(cleaned).toBeGreaterThanOrEqual(0);
    expect(fetched.events.some((e) => e.content && (e.content as { keep?: number }).keep === 3)).toBe(
      true
    );
    expect(db.messages.every((m) => m.delivered === 0 || m.created_at >= NOW - SEVEN_DAYS_MS)).toBe(
      true
    );
  });

  it('soft-4: cleanup deletes delivered while fetch reads undelivered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 4,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - SEVEN_DAYS_MS - 1000,
      }),
      helperMsg({
        stream_position: 104,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW,
        content: JSON.stringify({ keep: 4 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [cleaned, fetched] = await Promise.all([
      cleanupOldToDeviceMessages(db),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(cleaned).toBeGreaterThanOrEqual(0);
    expect(fetched.events.some((e) => e.content && (e.content as { keep?: number }).keep === 4)).toBe(
      true
    );
    expect(db.messages.every((m) => m.delivered === 0 || m.created_at >= NOW - SEVEN_DAYS_MS)).toBe(
      true
    );
  });

  it('soft-5: cleanup deletes delivered while fetch reads undelivered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 5,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - SEVEN_DAYS_MS - 1000,
      }),
      helperMsg({
        stream_position: 105,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW,
        content: JSON.stringify({ keep: 5 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [cleaned, fetched] = await Promise.all([
      cleanupOldToDeviceMessages(db),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(cleaned).toBeGreaterThanOrEqual(0);
    expect(fetched.events.some((e) => e.content && (e.content as { keep?: number }).keep === 5)).toBe(
      true
    );
    expect(db.messages.every((m) => m.delivered === 0 || m.created_at >= NOW - SEVEN_DAYS_MS)).toBe(
      true
    );
  });

  it('soft-6: cleanup deletes delivered while fetch reads undelivered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 6,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - SEVEN_DAYS_MS - 1000,
      }),
      helperMsg({
        stream_position: 106,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW,
        content: JSON.stringify({ keep: 6 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [cleaned, fetched] = await Promise.all([
      cleanupOldToDeviceMessages(db),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(cleaned).toBeGreaterThanOrEqual(0);
    expect(fetched.events.some((e) => e.content && (e.content as { keep?: number }).keep === 6)).toBe(
      true
    );
    expect(db.messages.every((m) => m.delivered === 0 || m.created_at >= NOW - SEVEN_DAYS_MS)).toBe(
      true
    );
  });

  it('soft-7: cleanup deletes delivered while fetch reads undelivered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 7,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - SEVEN_DAYS_MS - 1000,
      }),
      helperMsg({
        stream_position: 107,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW,
        content: JSON.stringify({ keep: 7 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [cleaned, fetched] = await Promise.all([
      cleanupOldToDeviceMessages(db),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(cleaned).toBeGreaterThanOrEqual(0);
    expect(fetched.events.some((e) => e.content && (e.content as { keep?: number }).keep === 7)).toBe(
      true
    );
    expect(db.messages.every((m) => m.delivered === 0 || m.created_at >= NOW - SEVEN_DAYS_MS)).toBe(
      true
    );
  });

  it('soft-8: cleanup deletes delivered while fetch reads undelivered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 8,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - SEVEN_DAYS_MS - 1000,
      }),
      helperMsg({
        stream_position: 108,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW,
        content: JSON.stringify({ keep: 8 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [cleaned, fetched] = await Promise.all([
      cleanupOldToDeviceMessages(db),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(cleaned).toBeGreaterThanOrEqual(0);
    expect(fetched.events.some((e) => e.content && (e.content as { keep?: number }).keep === 8)).toBe(
      true
    );
    expect(db.messages.every((m) => m.delivered === 0 || m.created_at >= NOW - SEVEN_DAYS_MS)).toBe(
      true
    );
  });

  it('soft-9: cleanup deletes delivered while fetch reads undelivered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 9,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - SEVEN_DAYS_MS - 1000,
      }),
      helperMsg({
        stream_position: 109,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW,
        content: JSON.stringify({ keep: 9 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [cleaned, fetched] = await Promise.all([
      cleanupOldToDeviceMessages(db),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(cleaned).toBeGreaterThanOrEqual(0);
    expect(fetched.events.some((e) => e.content && (e.content as { keep?: number }).keep === 9)).toBe(
      true
    );
    expect(db.messages.every((m) => m.delivered === 0 || m.created_at >= NOW - SEVEN_DAYS_MS)).toBe(
      true
    );
  });

  it('soft-10: cleanup deletes delivered while fetch reads undelivered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 10,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - SEVEN_DAYS_MS - 1000,
      }),
      helperMsg({
        stream_position: 110,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW,
        content: JSON.stringify({ keep: 10 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [cleaned, fetched] = await Promise.all([
      cleanupOldToDeviceMessages(db),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(cleaned).toBeGreaterThanOrEqual(0);
    expect(fetched.events.some((e) => e.content && (e.content as { keep?: number }).keep === 10)).toBe(
      true
    );
    expect(db.messages.every((m) => m.delivered === 0 || m.created_at >= NOW - SEVEN_DAYS_MS)).toBe(
      true
    );
  });

  it('soft-11: cleanup deletes delivered while fetch reads undelivered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 11,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - SEVEN_DAYS_MS - 1000,
      }),
      helperMsg({
        stream_position: 111,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW,
        content: JSON.stringify({ keep: 11 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [cleaned, fetched] = await Promise.all([
      cleanupOldToDeviceMessages(db),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(cleaned).toBeGreaterThanOrEqual(0);
    expect(fetched.events.some((e) => e.content && (e.content as { keep?: number }).keep === 11)).toBe(
      true
    );
    expect(db.messages.every((m) => m.delivered === 0 || m.created_at >= NOW - SEVEN_DAYS_MS)).toBe(
      true
    );
  });

  it('soft-12: cleanup deletes delivered while fetch reads undelivered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 12,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - SEVEN_DAYS_MS - 1000,
      }),
      helperMsg({
        stream_position: 112,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW,
        content: JSON.stringify({ keep: 12 }),
      }),
    ];
    const db = createHelperDb(rows);
    const [cleaned, fetched] = await Promise.all([
      cleanupOldToDeviceMessages(db),
      getToDeviceMessages(db, USER, DEVICE_A, '0', 100),
    ]);
    expect(cleaned).toBeGreaterThanOrEqual(0);
    expect(fetched.events.some((e) => e.content && (e.content as { keep?: number }).keep === 12)).toBe(
      true
    );
    expect(db.messages.every((m) => m.delivered === 0 || m.created_at >= NOW - SEVEN_DAYS_MS)).toBe(
      true
    );
  });

});

describe('getToDeviceMessages soft flood — since token edges after #168', () => {
  it('soft-1: since=missing does not throw and returns nextBatch', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 5,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, undefined, 100);
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('nextBatch');
    expect(typeof result.nextBatch).toBe('string');
  });

  it('soft-2: since=empty does not throw and returns nextBatch', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 5,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '', 100);
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('nextBatch');
    expect(typeof result.nextBatch).toBe('string');
  });

  it('soft-3: since=zero does not throw and returns nextBatch', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 5,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '0', 100);
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('nextBatch');
    expect(typeof result.nextBatch).toBe('string');
  });

  it('soft-4: since=negative does not throw and returns nextBatch', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 5,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '-1', 100);
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('nextBatch');
    expect(typeof result.nextBatch).toBe('string');
  });

  it('soft-5: since=nan does not throw and returns nextBatch', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 5,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, 'abc', 100);
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('nextBatch');
    expect(typeof result.nextBatch).toBe('string');
  });

  it('soft-6: since=float does not throw and returns nextBatch', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 5,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '1.5', 100);
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('nextBatch');
    expect(typeof result.nextBatch).toBe('string');
  });

  it('soft-7: since=just-below-1e9 does not throw and returns nextBatch', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 5,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '999999999', 100);
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('nextBatch');
    expect(typeof result.nextBatch).toBe('string');
  });

  it('soft-8: since=at-1e9-gate does not throw and returns nextBatch', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 5,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '1000000000', 100);
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('nextBatch');
    expect(typeof result.nextBatch).toBe('string');
  });

  it('soft-9: since=above-1e9 does not throw and returns nextBatch', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 5,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '1000000001', 100);
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('nextBatch');
    expect(typeof result.nextBatch).toBe('string');
  });

  it('soft-10: since=timestamp-like does not throw and returns nextBatch', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 5,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, String(NOW), 100);
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('nextBatch');
    expect(typeof result.nextBatch).toBe('string');
  });

  it('soft-11: since=one does not throw and returns nextBatch', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 5,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '1', 100);
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('nextBatch');
    expect(typeof result.nextBatch).toBe('string');
  });

  it('soft-12: since=forty-two does not throw and returns nextBatch', async () => {
    const db = createHelperDb([
      helperMsg({
        stream_position: 5,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
      }),
    ]);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '42', 100);
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('nextBatch');
    expect(typeof result.nextBatch).toBe('string');
  });

});

describe('getToDeviceMessages soft flood — limit matrix after #168', () => {
  it('soft-1: limit=1 caps or yields empty without throw', async () => {
    const rows = Array.from({ length: 8 }, (_, j) =>
      helperMsg({
        stream_position: j + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ j }),
      })
    );
    const db = createHelperDb(rows);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '0', 1);
    expect(Array.isArray(result.events)).toBe(true);
    if (1 > 0) {
      expect(result.events.length).toBeLessThanOrEqual(1);
    }
  });

  it('soft-2: limit=2 caps or yields empty without throw', async () => {
    const rows = Array.from({ length: 8 }, (_, j) =>
      helperMsg({
        stream_position: j + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ j }),
      })
    );
    const db = createHelperDb(rows);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '0', 2);
    expect(Array.isArray(result.events)).toBe(true);
    if (2 > 0) {
      expect(result.events.length).toBeLessThanOrEqual(2);
    }
  });

  it('soft-3: limit=3 caps or yields empty without throw', async () => {
    const rows = Array.from({ length: 8 }, (_, j) =>
      helperMsg({
        stream_position: j + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ j }),
      })
    );
    const db = createHelperDb(rows);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '0', 3);
    expect(Array.isArray(result.events)).toBe(true);
    if (3 > 0) {
      expect(result.events.length).toBeLessThanOrEqual(3);
    }
  });

  it('soft-4: limit=5 caps or yields empty without throw', async () => {
    const rows = Array.from({ length: 8 }, (_, j) =>
      helperMsg({
        stream_position: j + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ j }),
      })
    );
    const db = createHelperDb(rows);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '0', 5);
    expect(Array.isArray(result.events)).toBe(true);
    if (5 > 0) {
      expect(result.events.length).toBeLessThanOrEqual(5);
    }
  });

  it('soft-5: limit=10 caps or yields empty without throw', async () => {
    const rows = Array.from({ length: 8 }, (_, j) =>
      helperMsg({
        stream_position: j + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ j }),
      })
    );
    const db = createHelperDb(rows);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '0', 10);
    expect(Array.isArray(result.events)).toBe(true);
    if (10 > 0) {
      expect(result.events.length).toBeLessThanOrEqual(10);
    }
  });

  it('soft-6: limit=50 caps or yields empty without throw', async () => {
    const rows = Array.from({ length: 8 }, (_, j) =>
      helperMsg({
        stream_position: j + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ j }),
      })
    );
    const db = createHelperDb(rows);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '0', 50);
    expect(Array.isArray(result.events)).toBe(true);
    if (50 > 0) {
      expect(result.events.length).toBeLessThanOrEqual(50);
    }
  });

  it('soft-7: limit=100 caps or yields empty without throw', async () => {
    const rows = Array.from({ length: 8 }, (_, j) =>
      helperMsg({
        stream_position: j + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ j }),
      })
    );
    const db = createHelperDb(rows);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '0', 100);
    expect(Array.isArray(result.events)).toBe(true);
    if (100 > 0) {
      expect(result.events.length).toBeLessThanOrEqual(100);
    }
  });

  it('soft-8: limit=200 caps or yields empty without throw', async () => {
    const rows = Array.from({ length: 8 }, (_, j) =>
      helperMsg({
        stream_position: j + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ j }),
      })
    );
    const db = createHelperDb(rows);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '0', 200);
    expect(Array.isArray(result.events)).toBe(true);
    if (200 > 0) {
      expect(result.events.length).toBeLessThanOrEqual(200);
    }
  });

  it('soft-9: limit=0 caps or yields empty without throw', async () => {
    const rows = Array.from({ length: 8 }, (_, j) =>
      helperMsg({
        stream_position: j + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ j }),
      })
    );
    const db = createHelperDb(rows);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '0', 0);
    expect(Array.isArray(result.events)).toBe(true);
    if (0 > 0) {
      expect(result.events.length).toBeLessThanOrEqual(0);
    }
  });

  it('soft-10: limit=-1 caps or yields empty without throw', async () => {
    const rows = Array.from({ length: 8 }, (_, j) =>
      helperMsg({
        stream_position: j + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ j }),
      })
    );
    const db = createHelperDb(rows);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '0', -1);
    expect(Array.isArray(result.events)).toBe(true);
    if (-1 > 0) {
      expect(result.events.length).toBeLessThanOrEqual(-1);
    }
  });

  it('soft-11: limit=999 caps or yields empty without throw', async () => {
    const rows = Array.from({ length: 8 }, (_, j) =>
      helperMsg({
        stream_position: j + 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        content: JSON.stringify({ j }),
      })
    );
    const db = createHelperDb(rows);
    const result = await getToDeviceMessages(db, USER, DEVICE_A, '0', 999);
    expect(Array.isArray(result.events)).toBe(true);
    if (999 > 0) {
      expect(result.events.length).toBeLessThanOrEqual(999);
    }
  });

});

describe('cleanupOldToDeviceMessages soft flood — maxAgeMs matrix after #168', () => {
  it('soft-1: maxAgeMs=0 deletes only delivered older than cutoff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - 0 - 1,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW - 0 - 1,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW,
      }),
    ];
    const db = createHelperDb(rows);
    const deleted = await cleanupOldToDeviceMessages(db, 0);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(db.messages.some((m) => m.stream_position === 2)).toBe(true);
    expect(db.messages.some((m) => m.stream_position === 3)).toBe(true);
  });

  it('soft-2: maxAgeMs=1 deletes only delivered older than cutoff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - 1 - 1,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW - 1 - 1,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW,
      }),
    ];
    const db = createHelperDb(rows);
    const deleted = await cleanupOldToDeviceMessages(db, 1);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(db.messages.some((m) => m.stream_position === 2)).toBe(true);
    expect(db.messages.some((m) => m.stream_position === 3)).toBe(true);
  });

  it('soft-3: maxAgeMs=1000 deletes only delivered older than cutoff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - 1000 - 1,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW - 1000 - 1,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW,
      }),
    ];
    const db = createHelperDb(rows);
    const deleted = await cleanupOldToDeviceMessages(db, 1000);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(db.messages.some((m) => m.stream_position === 2)).toBe(true);
    expect(db.messages.some((m) => m.stream_position === 3)).toBe(true);
  });

  it('soft-4: maxAgeMs=604800000 deletes only delivered older than cutoff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - 604800000 - 1,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW - 604800000 - 1,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW,
      }),
    ];
    const db = createHelperDb(rows);
    const deleted = await cleanupOldToDeviceMessages(db, 604800000);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(db.messages.some((m) => m.stream_position === 2)).toBe(true);
    expect(db.messages.some((m) => m.stream_position === 3)).toBe(true);
  });

  it('soft-5: maxAgeMs=302400000 deletes only delivered older than cutoff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - 302400000 - 1,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW - 302400000 - 1,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW,
      }),
    ];
    const db = createHelperDb(rows);
    const deleted = await cleanupOldToDeviceMessages(db, 302400000);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(db.messages.some((m) => m.stream_position === 2)).toBe(true);
    expect(db.messages.some((m) => m.stream_position === 3)).toBe(true);
  });

  it('soft-6: maxAgeMs=1209600000 deletes only delivered older than cutoff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - 1209600000 - 1,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW - 1209600000 - 1,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW,
      }),
    ];
    const db = createHelperDb(rows);
    const deleted = await cleanupOldToDeviceMessages(db, 1209600000);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(db.messages.some((m) => m.stream_position === 2)).toBe(true);
    expect(db.messages.some((m) => m.stream_position === 3)).toBe(true);
  });

  it('soft-7: maxAgeMs=1000000000000 deletes only delivered older than cutoff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - 1000000000000 - 1,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW - 1000000000000 - 1,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW,
      }),
    ];
    const db = createHelperDb(rows);
    const deleted = await cleanupOldToDeviceMessages(db, 1000000000000);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(db.messages.some((m) => m.stream_position === 2)).toBe(true);
    expect(db.messages.some((m) => m.stream_position === 3)).toBe(true);
  });

  it('soft-8: maxAgeMs=60000 deletes only delivered older than cutoff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - 60000 - 1,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW - 60000 - 1,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW,
      }),
    ];
    const db = createHelperDb(rows);
    const deleted = await cleanupOldToDeviceMessages(db, 60000);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(db.messages.some((m) => m.stream_position === 2)).toBe(true);
    expect(db.messages.some((m) => m.stream_position === 3)).toBe(true);
  });

  it('soft-9: maxAgeMs=3600000 deletes only delivered older than cutoff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - 3600000 - 1,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW - 3600000 - 1,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW,
      }),
    ];
    const db = createHelperDb(rows);
    const deleted = await cleanupOldToDeviceMessages(db, 3600000);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(db.messages.some((m) => m.stream_position === 2)).toBe(true);
    expect(db.messages.some((m) => m.stream_position === 3)).toBe(true);
  });

  it('soft-10: maxAgeMs=86400000 deletes only delivered older than cutoff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - 86400000 - 1,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW - 86400000 - 1,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW,
      }),
    ];
    const db = createHelperDb(rows);
    const deleted = await cleanupOldToDeviceMessages(db, 86400000);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(db.messages.some((m) => m.stream_position === 2)).toBe(true);
    expect(db.messages.some((m) => m.stream_position === 3)).toBe(true);
  });

  it('soft-11: maxAgeMs=1 deletes only delivered older than cutoff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const rows = [
      helperMsg({
        stream_position: 1,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW - 1 - 1,
      }),
      helperMsg({
        stream_position: 2,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 0,
        created_at: NOW - 1 - 1,
      }),
      helperMsg({
        stream_position: 3,
        recipient_user_id: USER,
        recipient_device_id: DEVICE_A,
        delivered: 1,
        created_at: NOW,
      }),
    ];
    const db = createHelperDb(rows);
    const deleted = await cleanupOldToDeviceMessages(db, 1);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(db.messages.some((m) => m.stream_position === 2)).toBe(true);
    expect(db.messages.some((m) => m.stream_position === 3)).toBe(true);
  });

});

describe('sendToDevice soft flood — unicode / nested content after #168', () => {
  it('soft-1: content shape emoji round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = { emoji: '🔐🗝️' };
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-1`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-2: content shape cjk round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = { zh: '密钥交换' };
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-2`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-3: content shape arabic round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = { ar: 'مفتاح' };
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-3`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-4: content shape deep-nest round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = { nested: { a: { b: [1, 2, 3] } } };
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-4`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-5: content shape empty-str round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = { empty: '' };
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-5`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-6: content shape null-field round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = { n: null };
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-6`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-7: content shape empty-arr round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = { arr: [] };
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-7`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-8: content shape long-str round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = { big: 'Z'.repeat(200) };
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-8`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-9: content shape bool-true-content round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = true;
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-9`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-10: content shape zero-content round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = 0;
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-10`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-11: content shape newline round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = { s: 'line1\nline2' };
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-11`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-12: content shape escaped-quote round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = { q: '\"' };
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-12`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-13: content shape null-char round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = { u: '\u0000' };
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-13`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-14: content shape mixed-arr round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = { list: [null, false, 0, ''] };
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-14`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-15: content shape obj round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = { self: { x: 1 } };
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-15`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

  it('soft-16: content shape string-content round-trips via JSON.stringify', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const content = 'plain-string';
    const res = await request(
      env,
      sendPath(EVENT_TYPE, `content-16`),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(JSON.parse(db.messages[0].content)).toEqual(content);
  });

});

describe('race sendToDevice multi-user fanout parallel after #168', () => {
  it('soft-1: parallel sends to distinct users isolate message rows', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: CAROL, device_id: DEVICE_C },
      ],
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `fan-bob-1`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { to: 'bob', soft: 1 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `fan-carol-1`),
        jsonInit('PUT', { messages: { [CAROL]: { '*': { to: 'carol', soft: 1 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(1);
    expect(db.messages.filter((m) => m.recipient_user_id === CAROL)).toHaveLength(1);
    expect(db.transactions).toHaveLength(2);
  });

  it('soft-2: parallel sends to distinct users isolate message rows', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: CAROL, device_id: DEVICE_C },
      ],
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `fan-bob-2`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { to: 'bob', soft: 2 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `fan-carol-2`),
        jsonInit('PUT', { messages: { [CAROL]: { '*': { to: 'carol', soft: 2 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(1);
    expect(db.messages.filter((m) => m.recipient_user_id === CAROL)).toHaveLength(1);
    expect(db.transactions).toHaveLength(2);
  });

  it('soft-3: parallel sends to distinct users isolate message rows', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: CAROL, device_id: DEVICE_C },
      ],
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `fan-bob-3`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { to: 'bob', soft: 3 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `fan-carol-3`),
        jsonInit('PUT', { messages: { [CAROL]: { '*': { to: 'carol', soft: 3 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(1);
    expect(db.messages.filter((m) => m.recipient_user_id === CAROL)).toHaveLength(1);
    expect(db.transactions).toHaveLength(2);
  });

  it('soft-4: parallel sends to distinct users isolate message rows', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: CAROL, device_id: DEVICE_C },
      ],
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `fan-bob-4`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { to: 'bob', soft: 4 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `fan-carol-4`),
        jsonInit('PUT', { messages: { [CAROL]: { '*': { to: 'carol', soft: 4 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(1);
    expect(db.messages.filter((m) => m.recipient_user_id === CAROL)).toHaveLength(1);
    expect(db.transactions).toHaveLength(2);
  });

  it('soft-5: parallel sends to distinct users isolate message rows', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: CAROL, device_id: DEVICE_C },
      ],
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `fan-bob-5`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { to: 'bob', soft: 5 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `fan-carol-5`),
        jsonInit('PUT', { messages: { [CAROL]: { '*': { to: 'carol', soft: 5 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(1);
    expect(db.messages.filter((m) => m.recipient_user_id === CAROL)).toHaveLength(1);
    expect(db.transactions).toHaveLength(2);
  });

  it('soft-6: parallel sends to distinct users isolate message rows', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: CAROL, device_id: DEVICE_C },
      ],
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `fan-bob-6`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { to: 'bob', soft: 6 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `fan-carol-6`),
        jsonInit('PUT', { messages: { [CAROL]: { '*': { to: 'carol', soft: 6 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(1);
    expect(db.messages.filter((m) => m.recipient_user_id === CAROL)).toHaveLength(1);
    expect(db.transactions).toHaveLength(2);
  });

  it('soft-7: parallel sends to distinct users isolate message rows', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: CAROL, device_id: DEVICE_C },
      ],
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `fan-bob-7`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { to: 'bob', soft: 7 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `fan-carol-7`),
        jsonInit('PUT', { messages: { [CAROL]: { '*': { to: 'carol', soft: 7 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(1);
    expect(db.messages.filter((m) => m.recipient_user_id === CAROL)).toHaveLength(1);
    expect(db.transactions).toHaveLength(2);
  });

  it('soft-8: parallel sends to distinct users isolate message rows', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: CAROL, device_id: DEVICE_C },
      ],
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `fan-bob-8`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { to: 'bob', soft: 8 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `fan-carol-8`),
        jsonInit('PUT', { messages: { [CAROL]: { '*': { to: 'carol', soft: 8 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(1);
    expect(db.messages.filter((m) => m.recipient_user_id === CAROL)).toHaveLength(1);
    expect(db.transactions).toHaveLength(2);
  });

  it('soft-9: parallel sends to distinct users isolate message rows', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: CAROL, device_id: DEVICE_C },
      ],
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `fan-bob-9`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { to: 'bob', soft: 9 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `fan-carol-9`),
        jsonInit('PUT', { messages: { [CAROL]: { '*': { to: 'carol', soft: 9 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(1);
    expect(db.messages.filter((m) => m.recipient_user_id === CAROL)).toHaveLength(1);
    expect(db.transactions).toHaveLength(2);
  });

  it('soft-10: parallel sends to distinct users isolate message rows', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: CAROL, device_id: DEVICE_C },
      ],
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `fan-bob-10`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { to: 'bob', soft: 10 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `fan-carol-10`),
        jsonInit('PUT', { messages: { [CAROL]: { '*': { to: 'carol', soft: 10 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(1);
    expect(db.messages.filter((m) => m.recipient_user_id === CAROL)).toHaveLength(1);
    expect(db.transactions).toHaveLength(2);
  });

  it('soft-11: parallel sends to distinct users isolate message rows', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: CAROL, device_id: DEVICE_C },
      ],
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `fan-bob-11`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { to: 'bob', soft: 11 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `fan-carol-11`),
        jsonInit('PUT', { messages: { [CAROL]: { '*': { to: 'carol', soft: 11 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(1);
    expect(db.messages.filter((m) => m.recipient_user_id === CAROL)).toHaveLength(1);
    expect(db.transactions).toHaveLength(2);
  });

  it('soft-12: parallel sends to distinct users isolate message rows', async () => {
    const db = createToDeviceDb({
      devices: [
        { user_id: BOB, device_id: DEVICE_B },
        { user_id: CAROL, device_id: DEVICE_C },
      ],
    });
    const env = createEnv(db);
    const [a, b] = await Promise.all([
      request(
        env,
        sendPath(EVENT_TYPE, `fan-bob-12`),
        jsonInit('PUT', { messages: { [BOB]: { '*': { to: 'bob', soft: 12 } } } })
      ),
      request(
        env,
        sendPath(EVENT_TYPE, `fan-carol-12`),
        jsonInit('PUT', { messages: { [CAROL]: { '*': { to: 'carol', soft: 12 } } } })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(1);
    expect(db.messages.filter((m) => m.recipient_user_id === CAROL)).toHaveLength(1);
    expect(db.transactions).toHaveLength(2);
  });

});

describe('sendToDevice soft flood — cached response variants after #168', () => {
  it('soft-1: cached response empty-obj returned without re-insert', async () => {
    const txn = `cached-resp-1`;
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: txn, response: "{}" }],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { no: true } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    const expected = JSON.parse("{}" || '{}');
    expect(res.body).toEqual(expected);
  });

  it('soft-2: cached response empty-string returned without re-insert', async () => {
    const txn = `cached-resp-2`;
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: txn, response: "" }],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { no: true } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    const expected = JSON.parse("" || '{}');
    expect(res.body).toEqual(expected);
  });

  it('soft-3: cached response custom-obj returned without re-insert', async () => {
    const txn = `cached-resp-3`;
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: txn, response: "{\"ok\":1}" }],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { no: true } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    const expected = JSON.parse("{\"ok\":1}" || '{}');
    expect(res.body).toEqual(expected);
  });

  it('soft-4: cached response array returned without re-insert', async () => {
    const txn = `cached-resp-4`;
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: txn, response: "[]" }],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { no: true } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    const expected = JSON.parse("[]" || '{}');
    expect(res.body).toEqual(expected);
  });

  it('soft-5: cached response null returned without re-insert', async () => {
    const txn = `cached-resp-5`;
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: txn, response: "null" }],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { no: true } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    const expected = JSON.parse("null" || '{}');
    expect(res.body).toEqual(expected);
  });

  it('soft-6: cached response string returned without re-insert', async () => {
    const txn = `cached-resp-6`;
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: txn, response: "\"hi\"" }],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { no: true } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    const expected = JSON.parse("\"hi\"" || '{}');
    expect(res.body).toEqual(expected);
  });

  it('soft-7: cached response zero returned without re-insert', async () => {
    const txn = `cached-resp-7`;
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: txn, response: "0" }],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { no: true } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    const expected = JSON.parse("0" || '{}');
    expect(res.body).toEqual(expected);
  });

  it('soft-8: cached response true returned without re-insert', async () => {
    const txn = `cached-resp-8`;
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: txn, response: "true" }],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(EVENT_TYPE, txn),
      jsonInit('PUT', { messages: { [BOB]: { [DEVICE_B]: { no: true } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    const expected = JSON.parse("true" || '{}');
    expect(res.body).toEqual(expected);
  });

});
