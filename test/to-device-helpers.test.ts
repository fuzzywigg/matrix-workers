import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  getToDeviceMessages,
  cleanupOldToDeviceMessages,
} from '../src/api/to-device';

/** Default maxAgeMs in cleanupOldToDeviceMessages (7 days). */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
/** Stream positions must be < 1e9; timestamps are typically >> 1e12. */
const TIMESTAMP_LIKE_SINCE = String(NOW);

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

function createToDeviceDb(messages: ToDeviceRow[] = []) {
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

function msg(
  overrides: Partial<ToDeviceRow> &
    Pick<ToDeviceRow, 'stream_position' | 'recipient_user_id' | 'recipient_device_id'>
): ToDeviceRow {
  return {
    id: overrides.id ?? overrides.stream_position,
    sender_user_id: overrides.sender_user_id ?? '@sender:ex.com',
    event_type: overrides.event_type ?? 'm.room_key',
    content: overrides.content ?? JSON.stringify({ key: 'v' }),
    delivered: overrides.delivered ?? 0,
    created_at: overrides.created_at ?? NOW,
    ...overrides,
  };
}

describe('getToDeviceMessages — since token / ack / nextBatch', () => {
  it('returns empty events and nextBatch "0" when the table is empty', async () => {
    const db = createToDeviceDb();
    expect(await getToDeviceMessages(db, '@u:ex.com', 'DEV')).toEqual({
      events: [],
      nextBatch: '0',
    });
    expect(db.acks).toHaveLength(0);
  });

  it('treats missing/invalid since as 0 and does not ack', async () => {
    const db = createToDeviceDb([
      msg({
        stream_position: 3,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        content: JSON.stringify({ a: 1 }),
      }),
    ]);

    for (const since of [undefined, '', 'not-a-number', '0', '-5', 'NaN']) {
      db.acks.length = 0;
      const result = await getToDeviceMessages(db, '@u:ex.com', 'DEV', since);
      expect(result.events).toHaveLength(1);
      expect(result.nextBatch).toBe('3');
      expect(db.acks).toHaveLength(0);
    }
  });

  it('ignores timestamp-like since tokens (>= 1e9) and treats as first sync', async () => {
    const db = createToDeviceDb([
      msg({
        stream_position: 2,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
      }),
    ]);

    const result = await getToDeviceMessages(
      db,
      '@u:ex.com',
      'DEV',
      TIMESTAMP_LIKE_SINCE
    );
    expect(result.events).toHaveLength(1);
    expect(db.acks).toHaveLength(0);
  });

  it('accepts stream positions just below the 1e9 gate', async () => {
    const db = createToDeviceDb([
      msg({
        stream_position: 999_999_999,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        content: JSON.stringify({ edge: true }),
      }),
      msg({
        stream_position: 1_000_000_000,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        content: JSON.stringify({ ignored_if_since_gate: true }),
        // still stored; sincePos parse of 999999999 will fetch this too if > since
      }),
    ]);

    // since=999999998 → sincePos accepted; returns pos 999999999 then ack
    const result = await getToDeviceMessages(
      db,
      '@u:ex.com',
      'DEV',
      '999999998'
    );
    expect(result.events.map((e) => e.content)).toEqual([
      { edge: true },
      { ignored_if_since_gate: true },
    ]);
    expect(result.nextBatch).toBe('1000000000');
    expect(db.acks).toEqual([
      { userId: '@u:ex.com', deviceId: 'DEV', sincePos: 999_999_998 },
    ]);
  });

  it('rejects since === 1000000000 as timestamp-like (no ack)', async () => {
    const db = createToDeviceDb([
      msg({
        stream_position: 5,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
      }),
    ]);

    await getToDeviceMessages(db, '@u:ex.com', 'DEV', '1000000000');
    expect(db.acks).toHaveLength(0);
  });

  it('only returns undelivered messages for the matching device after sincePos', async () => {
    const db = createToDeviceDb([
      msg({
        stream_position: 1,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        delivered: 1,
      }),
      msg({
        stream_position: 2,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'OTHER',
      }),
      msg({
        stream_position: 3,
        recipient_user_id: '@other:ex.com',
        recipient_device_id: 'DEV',
      }),
      msg({
        stream_position: 4,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        content: JSON.stringify({ keep: true }),
      }),
      msg({
        stream_position: 5,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        content: JSON.stringify({ also: true }),
      }),
    ]);

    const result = await getToDeviceMessages(db, '@u:ex.com', 'DEV', '3');
    expect(result.events).toEqual([
      { sender: '@sender:ex.com', type: 'm.room_key', content: { keep: true } },
      { sender: '@sender:ex.com', type: 'm.room_key', content: { also: true } },
    ]);
    expect(result.nextBatch).toBe('5');
    expect(db.acks).toEqual([
      { userId: '@u:ex.com', deviceId: 'DEV', sincePos: 3 },
    ]);
  });

  it('acks messages with stream_position <= sincePos when sincePos > 0', async () => {
    const db = createToDeviceDb([
      msg({
        stream_position: 1,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
      }),
      msg({
        stream_position: 2,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
      }),
      msg({
        stream_position: 3,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
      }),
    ]);

    await getToDeviceMessages(db, '@u:ex.com', 'DEV', '2');
    expect(db.messages.filter((m) => m.delivered === 1).map((m) => m.stream_position)).toEqual([
      1, 2,
    ]);
    expect(db.messages.find((m) => m.stream_position === 3)?.delivered).toBe(0);
  });

  it('respects the limit and sets nextBatch to max returned position', async () => {
    const db = createToDeviceDb(
      [1, 2, 3, 4, 5].map((p) =>
        msg({
          stream_position: p,
          recipient_user_id: '@u:ex.com',
          recipient_device_id: 'DEV',
          content: JSON.stringify({ p }),
        })
      )
    );

    const result = await getToDeviceMessages(db, '@u:ex.com', 'DEV', '0', 2);
    expect(result.events.map((e) => e.content)).toEqual([{ p: 1 }, { p: 2 }]);
    expect(result.nextBatch).toBe('2');
  });

  it('when caught up, nextBatch is the global max stream position', async () => {
    const db = createToDeviceDb([
      msg({
        stream_position: 10,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        delivered: 1,
      }),
      msg({
        stream_position: 42,
        recipient_user_id: '@other:ex.com',
        recipient_device_id: 'X',
        delivered: 1,
      }),
    ]);

    expect(await getToDeviceMessages(db, '@u:ex.com', 'DEV', '10')).toEqual({
      events: [],
      nextBatch: '42',
    });
  });

  it('parses JSON content and preserves sender/type', async () => {
    const db = createToDeviceDb([
      msg({
        stream_position: 7,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        sender_user_id: '@alice:ex.com',
        event_type: 'm.key.verification.request',
        content: JSON.stringify({ from_device: 'PHONE', methods: ['m.sas.v1'] }),
      }),
    ]);

    const { events } = await getToDeviceMessages(db, '@u:ex.com', 'DEV');
    expect(events).toEqual([
      {
        sender: '@alice:ex.com',
        type: 'm.key.verification.request',
        content: { from_device: 'PHONE', methods: ['m.sas.v1'] },
      },
    ]);
  });
});

describe('cleanupOldToDeviceMessages — clock-pinned cutoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses default 7-day cutoff: deletes delivered with created_at === cutoff−1', async () => {
    const cutoff = NOW - SEVEN_DAYS_MS;
    const db = createToDeviceDb([
      msg({
        stream_position: 1,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        delivered: 1,
        created_at: cutoff - 1,
      }),
      msg({
        stream_position: 2,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        delivered: 1,
        created_at: cutoff,
      }),
      msg({
        stream_position: 3,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        delivered: 0,
        created_at: cutoff - 1,
      }),
    ]);

    expect(await cleanupOldToDeviceMessages(db)).toBe(1);
    expect(db.deletes).toEqual([cutoff]);
    expect(db.messages.map((m) => m.stream_position).sort()).toEqual([2, 3]);
  });

  it('keeps delivered rows at exactly the cutoff (strict <)', async () => {
    const cutoff = NOW - SEVEN_DAYS_MS;
    const db = createToDeviceDb([
      msg({
        stream_position: 1,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        delivered: 1,
        created_at: cutoff,
      }),
    ]);

    expect(await cleanupOldToDeviceMessages(db)).toBe(0);
    expect(db.messages).toHaveLength(1);
  });

  it('honors a custom maxAgeMs and recomputes after the clock advances', async () => {
    const maxAgeMs = 60_000;
    const db = createToDeviceDb([
      msg({
        stream_position: 1,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        delivered: 1,
        created_at: NOW - 30_000,
      }),
    ]);

    expect(await cleanupOldToDeviceMessages(db, maxAgeMs)).toBe(0);

    vi.setSystemTime(NOW + 30_001);
    // created_at = NOW-30000; new cutoff = NOW+30001-60000 = NOW-29999
    // created_at (NOW-30000) < cutoff (NOW-29999) → delete
    expect(await cleanupOldToDeviceMessages(db, maxAgeMs)).toBe(1);
    expect(db.deletes.at(-1)).toBe(NOW + 30_001 - maxAgeMs);
    expect(db.messages).toHaveLength(0);
  });

  it('returns 0 when nothing matches', async () => {
    const db = createToDeviceDb([
      msg({
        stream_position: 1,
        recipient_user_id: '@u:ex.com',
        recipient_device_id: 'DEV',
        delivered: 0,
        created_at: 0,
      }),
    ]);
    expect(await cleanupOldToDeviceMessages(db, 1)).toBe(0);
  });
});
