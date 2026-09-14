/**
 * TOKENMAXX HEAVY deepen — different slice: sendToDevice HTTP API route.
 * Avoids getToDeviceMessages / cleanupOldToDeviceMessages helpers.
 * Tests-only — no product inventing.
 * Exercises idempotent txn, JSON validation, device expand, stream_positions, inserts.
 */
import { describe, expect, it, vi } from 'vitest';
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

import toDeviceApp from '../src/api/to-device';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!r:example.com'; // kept for constant parity with sibling suites
const EVENT_TYPE = 'm.room_key_request';
const TXN = 'txn-1';

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

type SqlCall = { sql: string; args: unknown[] };

function createToDeviceDb(opts: {
  streamPositions?: Record<string, number>;
  /** When true, UPDATE stream_positions returns null (forces INSERT upsert path). */
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
                // Simulate ON CONFLICT DO NOTHING: skip duplicate message_id for same recipient+device
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
                // SQL embeds '{}' literal: VALUES (?, ?, '{}') — only user_id + txn_id bound
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

function sendPath(eventType = EVENT_TYPE, txnId = TXN) {
  return `/_matrix/client/v3/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`;
}

describe('PUT /sendToDevice/:eventType/:txnId', () => {
  it('returns cached response for idempotent txn', async () => {
    const db = createToDeviceDb({
      transactions: [
        {
          user_id: USER,
          txn_id: TXN,
          response: JSON.stringify({ cached: true, ok: 1 }),
        },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(),
      jsonInit('PUT', { messages: { [BOB]: { DEV1: { a: 1 } } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cached: true, ok: 1 });
    expect(db.messages).toHaveLength(0);
  });

  it('returns empty object when cached response is empty string', async () => {
    const db = createToDeviceDb({
      transactions: [{ user_id: USER, txn_id: TXN, response: '' }],
    });
    const env = createEnv(db);
    const res = await request(env, sendPath(), jsonInit('PUT', { messages: {} }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('does not reuse Bob txn for Alice', async () => {
    const db = createToDeviceDb({
      transactions: [
        {
          user_id: BOB,
          txn_id: TXN,
          response: JSON.stringify({ for: 'bob' }),
        },
      ],
      devices: [{ user_id: BOB, device_id: 'B1' }],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(),
      jsonInit('PUT', { messages: { [BOB]: { B1: { hi: 1 } } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.transactions.some((t) => t.user_id === USER && t.txn_id === TXN)).toBe(true);
  });

  it('rejects bad JSON', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(env, sendPath(), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '{nope',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
    expect(db.messages).toHaveLength(0);
  });

  it('rejects missing messages field', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(env, sendPath(), jsonInit('PUT', { not_messages: {} }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: messages',
    });
  });

  it('rejects null messages', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(env, sendPath(), jsonInit('PUT', { messages: null }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('sends to specific device: inserts message + bumps stream via UPDATE RETURNING', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 5 } });
    const env = createEnv(db);
    const content = { action: 'request', request_id: 'r1' };
    const res = await request(
      env,
      sendPath(),
      jsonInit('PUT', { messages: { [BOB]: { DEVICEB: content } } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.streamPositions.to_device).toBe(6);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]).toMatchObject({
      recipient_user_id: BOB,
      recipient_device_id: 'DEVICEB',
      sender_user_id: USER,
      event_type: EVENT_TYPE,
      content: JSON.stringify(content),
      stream_position: 6,
    });
    expect(db.messages[0].message_id).toContain(`${USER}_${TXN}_${BOB}_DEVICEB_`);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: TXN,
      response: '{}',
    });
    const streamUpdate = db.updates.find((u) => u.sql.includes('UPDATE stream_positions'));
    expect(streamUpdate?.args).toEqual(['to_device']);
  });

  it('uses INSERT upsert when stream_positions row missing', async () => {
    const db = createToDeviceDb({
      streamPositions: {},
      missingStreamRow: true,
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(),
      jsonInit('PUT', { messages: { [BOB]: { D1: { x: 1 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].stream_position).toBe(1);
    const upsert = db.inserts.find((i) => i.sql.includes('INSERT INTO stream_positions'));
    expect(upsert).toBeTruthy();
    expect(upsert!.args).toEqual(['to_device']);
  });

  it('send to * expands devices from devices table', async () => {
    const db = createToDeviceDb({
      streamPositions: { to_device: 0 },
      devices: [
        { user_id: BOB, device_id: 'B1' },
        { user_id: BOB, device_id: 'B2' },
        { user_id: USER, device_id: 'DEVICEA' },
      ],
    });
    const env = createEnv(db);
    const content = { key: 'v' };
    const res = await request(
      env,
      sendPath(),
      jsonInit('PUT', { messages: { [BOB]: { '*': content } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(2);
    const deviceIds = db.messages.map((m) => m.recipient_device_id).sort();
    expect(deviceIds).toEqual(['B1', 'B2']);
    expect(db.messages.every((m) => m.recipient_user_id === BOB)).toBe(true);
    expect(db.messages.every((m) => m.content === JSON.stringify(content))).toBe(true);
    expect(db.streamPositions.to_device).toBe(2);
  });

  it('empty device list for * inserts no messages but still stores txn', async () => {
    const db = createToDeviceDb({
      devices: [{ user_id: USER, device_id: 'DEVICEA' }],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(),
      jsonInit('PUT', { messages: { [BOB]: { '*': { a: 1 } } } })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: TXN,
      response: '{}',
    });
    const deviceQuery = db.selects.find((s) => s.sql.includes('FROM devices'));
    expect(deviceQuery?.args).toEqual([BOB]);
  });

  it('sends to multiple users and devices', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 100 } });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath('m.dummy', 'txn-multi'),
      jsonInit('PUT', {
        messages: {
          [BOB]: { B1: { n: 1 }, B2: { n: 2 } },
          [USER]: { DEVICEA: { n: 3 } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(3);
    expect(db.streamPositions.to_device).toBe(103);
    expect(db.messages.map((m) => m.stream_position).sort((a, b) => a - b)).toEqual([
      101, 102, 103,
    ]);
    expect(db.messages.every((m) => m.event_type === 'm.dummy')).toBe(true);
    expect(db.messages.every((m) => m.sender_user_id === USER)).toBe(true);
    expect(db.transactions).toContainEqual({
      user_id: USER,
      txn_id: 'txn-multi',
      response: '{}',
    });
  });

  it('mixes * expand and specific device for same user', async () => {
    const db = createToDeviceDb({
      streamPositions: { to_device: 0 },
      devices: [
        { user_id: BOB, device_id: 'B1' },
        { user_id: BOB, device_id: 'B2' },
      ],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(),
      jsonInit('PUT', {
        messages: {
          [BOB]: {
            '*': { via: 'star' },
            BEXTRA: { via: 'specific' },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    // * → B1,B2 plus specific BEXTRA
    expect(db.messages).toHaveLength(3);
    const byDevice = Object.fromEntries(
      db.messages.map((m) => [m.recipient_device_id, JSON.parse(m.content)])
    );
    expect(byDevice.B1).toEqual({ via: 'star' });
    expect(byDevice.B2).toEqual({ via: 'star' });
    expect(byDevice.BEXTRA).toEqual({ via: 'specific' });
  });

  it('stores transaction_ids after successful send', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    await request(
      env,
      sendPath('m.key.verification.request', 'txn-store'),
      jsonInit('PUT', { messages: { [BOB]: { D: {} } } })
    );
    const txnInsert = db.inserts.find((i) => i.sql.includes('INSERT INTO transaction_ids'));
    expect(txnInsert?.args).toEqual([USER, 'txn-store']);
    expect(txnInsert?.sql).toContain("VALUES (?, ?, '{}')");
    expect(txnInsert?.sql).toContain('ON CONFLICT');
    expect(txnInsert?.sql).toContain('DO NOTHING');
  });

  it('to_device_messages INSERT uses ON CONFLICT DO NOTHING', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    await request(
      env,
      sendPath(),
      jsonInit('PUT', { messages: { [BOB]: { D1: { z: 9 } } } })
    );
    const msgInsert = db.inserts.find((i) => i.sql.includes('INSERT INTO to_device_messages'));
    expect(msgInsert).toBeTruthy();
    expect(msgInsert!.sql).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
  });

  it('empty messages object succeeds and stores txn with no message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(env, sendPath(), jsonInit('PUT', { messages: {} }));
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
  });

  it('user with empty device map inserts nothing for that user', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const res = await request(
      env,
      sendPath(),
      jsonInit('PUT', {
        messages: {
          [BOB]: {},
          [USER]: { DEVICEA: { self: true } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipient_user_id).toBe(USER);
  });

  it('second request with same txn returns cached {} without re-inserting', async () => {
    const db = createToDeviceDb({ streamPositions: { to_device: 1 } });
    const env = createEnv(db);
    const body = { messages: { [BOB]: { D1: { once: true } } } };
    const first = await request(env, sendPath(), jsonInit('PUT', body));
    expect(first.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.streamPositions.to_device).toBe(2);

    const second = await request(env, sendPath(), jsonInit('PUT', body));
    expect(second.status).toBe(200);
    expect(second.body).toEqual({});
    expect(db.messages).toHaveLength(1);
    expect(db.streamPositions.to_device).toBe(2);
  });

  it('passes eventType from path into message rows', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const type = 'm.key.verification.start';
    await request(
      env,
      sendPath(type, 'txn-type'),
      jsonInit('PUT', { messages: { [BOB]: { X: { method: 'sas' } } } })
    );
    expect(db.messages[0].event_type).toBe(type);
  });

  it('bumps stream once per target device under *', async () => {
    const db = createToDeviceDb({
      streamPositions: { to_device: 50 },
      devices: [
        { user_id: BOB, device_id: 'a' },
        { user_id: BOB, device_id: 'b' },
        { user_id: BOB, device_id: 'c' },
      ],
    });
    const env = createEnv(db);
    await request(
      env,
      sendPath(),
      jsonInit('PUT', { messages: { [BOB]: { '*': { p: 1 } } } })
    );
    expect(db.updates.filter((u) => u.sql.includes('stream_positions'))).toHaveLength(3);
    expect(db.streamPositions.to_device).toBe(53);
    expect(new Set(db.messages.map((m) => m.stream_position)).size).toBe(3);
  });

  it('ROOM constant available for suite parity (unused by sendToDevice)', () => {
    expect(ROOM).toBe('!r:example.com');
  });

  it('queries transaction_ids with auth user and path txnId', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    await request(
      env,
      sendPath(EVENT_TYPE, 'check-txn'),
      jsonInit('PUT', { messages: {} })
    );
    const txnSel = db.selects.find((s) => s.sql.includes('transaction_ids'));
    expect(txnSel?.args).toEqual([USER, 'check-txn']);
  });

  it('serializes nested content objects into JSON string for storage', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    const nested = { a: { b: [1, 2], c: null } };
    await request(
      env,
      sendPath(),
      jsonInit('PUT', { messages: { [BOB]: { D: nested } } })
    );
    expect(db.messages[0].content).toBe(JSON.stringify(nested));
  });

  it('handles * for multiple users independently', async () => {
    const db = createToDeviceDb({
      streamPositions: { to_device: 0 },
      devices: [
        { user_id: BOB, device_id: 'B1' },
        { user_id: USER, device_id: 'A1' },
        { user_id: USER, device_id: 'A2' },
      ],
    });
    const env = createEnv(db);
    await request(
      env,
      sendPath(),
      jsonInit('PUT', {
        messages: {
          [BOB]: { '*': { to: 'bob' } },
          [USER]: { '*': { to: 'alice' } },
        },
      })
    );
    expect(db.messages).toHaveLength(3);
    expect(db.messages.filter((m) => m.recipient_user_id === BOB)).toHaveLength(1);
    expect(db.messages.filter((m) => m.recipient_user_id === USER)).toHaveLength(2);
  });

  it('message_id embeds sender, txn, recipient, and device', async () => {
    const db = createToDeviceDb();
    const env = createEnv(db);
    await request(
      env,
      sendPath(EVENT_TYPE, 'id-txn'),
      jsonInit('PUT', { messages: { [BOB]: { DEVZ: {} } } })
    );
    expect(db.messages[0].message_id.startsWith(`${USER}_id-txn_${BOB}_DEVZ_`)).toBe(true);
  });
});
