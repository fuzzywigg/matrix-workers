import { describe, it, expect, vi } from 'vitest';
import {
  checkTransactionIdempotency,
  cleanupOldTransactions,
  getTransaction,
  storeTransaction,
  withIdempotency,
} from '../src/services/transactions';

type TxnRow = { event_id: string | null; response: string | null };

/** Minimal D1 stand-in for transaction_ids SELECT / INSERT / DELETE paths. */
function createTxnDb(store = new Map<string, TxnRow>()) {
  return {
    store,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT')) {
                const [userId, txnId] = args as [string, string];
                const row = store.get(`${userId}:${txnId}`);
                return (row as T) ?? null;
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT')) {
                const [userId, txnId, eventId, response] = args as [
                  string,
                  string,
                  string | null,
                  string | null,
                ];
                const key = `${userId}:${txnId}`;
                const existing = store.get(key);
                store.set(key, {
                  event_id: eventId ?? existing?.event_id ?? null,
                  response: response ?? existing?.response ?? null,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('DELETE')) {
                const [cutoff] = args as [number];
                let changes = 0;
                for (const [key, row] of [...store.entries()]) {
                  const createdAt = (row as TxnRow & { created_at?: number }).created_at ?? 0;
                  if (createdAt < cutoff) {
                    store.delete(key);
                    changes++;
                  }
                }
                return { meta: { changes } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & { store: Map<string, TxnRow> };
}

describe('checkTransactionIdempotency', () => {
  it('returns cached:false when txnId is missing', async () => {
    const db = createTxnDb();
    expect(await checkTransactionIdempotency(db, '@u:ex.com', undefined)).toEqual({
      cached: false,
    });
  });

  it('returns cached response JSON when a prior transaction exists', async () => {
    const db = createTxnDb();
    await storeTransaction(db, '@u:ex.com', 't1', '$ev', { event_id: '$ev' });
    expect(await checkTransactionIdempotency(db, '@u:ex.com', 't1')).toEqual({
      cached: true,
      response: { event_id: '$ev' },
    });
  });

  it('constructs { event_id } when only event_id was stored', async () => {
    const db = createTxnDb(
      new Map([['@u:ex.com:t2', { event_id: '$only', response: null }]])
    );
    expect(await checkTransactionIdempotency(db, '@u:ex.com', 't2')).toEqual({
      cached: true,
      response: { event_id: '$only' },
    });
  });

  it('returns empty object when the row has neither response nor event_id', async () => {
    const db = createTxnDb(
      new Map([['@u:ex.com:t3', { event_id: null, response: null }]])
    );
    expect(await checkTransactionIdempotency(db, '@u:ex.com', 't3')).toEqual({
      cached: true,
      response: {},
    });
  });

  it('returns cached:false when txnId is new', async () => {
    const db = createTxnDb();
    expect(await checkTransactionIdempotency(db, '@u:ex.com', 'fresh')).toEqual({
      cached: false,
    });
  });
});

describe('withIdempotency', () => {
  it('skips store when txnId is undefined and still returns the handler response', async () => {
    const db = createTxnDb();
    const handler = vi.fn(async () => ({ eventId: '$e', response: { event_id: '$e' } }));
    const wrapped = withIdempotency(handler);
    await expect(wrapped(db, '@u:ex.com', undefined)).resolves.toEqual({ event_id: '$e' });
    expect(handler).toHaveBeenCalledOnce();
    expect(db.store.size).toBe(0);
  });

  it('stores after the handler and returns the cached response on replay', async () => {
    const db = createTxnDb();
    const handler = vi.fn(async () => ({ eventId: '$e', response: { event_id: '$e' } }));
    const wrapped = withIdempotency(handler);

    expect(await wrapped(db, '@u:ex.com', 'txn-a')).toEqual({ event_id: '$e' });
    expect(await wrapped(db, '@u:ex.com', 'txn-a')).toEqual({ event_id: '$e' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('re-runs the handler when a prior row has event_id but no response', async () => {
    // withIdempotency only short-circuits on existing.response
    const db = createTxnDb(
      new Map([['@u:ex.com:txn-b', { event_id: '$old', response: null }]])
    );
    const handler = vi.fn(async () => ({ eventId: '$new', response: { event_id: '$new' } }));
    const wrapped = withIdempotency(handler);
    expect(await wrapped(db, '@u:ex.com', 'txn-b')).toEqual({ event_id: '$new' });
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('getTransaction / storeTransaction / cleanupOldTransactions', () => {
  it('round-trips eventId and response through getTransaction', async () => {
    const db = createTxnDb();
    await storeTransaction(db, '@u:ex.com', 't', '$ev', { ok: true });
    expect(await getTransaction(db, '@u:ex.com', 't')).toEqual({
      eventId: '$ev',
      response: { ok: true },
    });
    expect(await getTransaction(db, '@u:ex.com', 'missing')).toBeNull();
  });

  it('merges on conflict via COALESCE-like mock semantics', async () => {
    const db = createTxnDb();
    await storeTransaction(db, '@u:ex.com', 't', '$ev', undefined);
    await storeTransaction(db, '@u:ex.com', 't', undefined, { event_id: '$ev' });
    expect(await getTransaction(db, '@u:ex.com', 't')).toEqual({
      eventId: '$ev',
      response: { event_id: '$ev' },
    });
  });

  it('deletes rows older than the cutoff', async () => {
    const db = createTxnDb();
    const oldKey = '@u:ex.com:old';
    const newKey = '@u:ex.com:new';
    db.store.set(oldKey, { event_id: '$a', response: null, created_at: 1 } as TxnRow & {
      created_at: number;
    });
    db.store.set(newKey, {
      event_id: '$b',
      response: null,
      created_at: Date.now(),
    } as TxnRow & { created_at: number });

    const deleted = await cleanupOldTransactions(db, 60_000);
    expect(deleted).toBe(1);
    expect(db.store.has(oldKey)).toBe(false);
    expect(db.store.has(newKey)).toBe(true);
  });
});


describe('transactions TOKENMAXX edge paths after #54', () => {
  it('treats empty-string txnId as missing (falsy guard)', async () => {
    const db = createTxnDb();
    expect(await checkTransactionIdempotency(db, '@u:ex.com', '')).toEqual({ cached: false });
    const handler = vi.fn(async () => ({ eventId: '$e', response: { event_id: '$e' } }));
    const wrapped = withIdempotency(handler);
    await expect(wrapped(db, '@u:ex.com', '')).resolves.toEqual({ event_id: '$e' });
    expect(db.store.size).toBe(0);
  });

  it('stores null for falsy response values (0 / false) via truthy stringify guard', async () => {
    const db = createTxnDb();
    await storeTransaction(db, '@u:ex.com', 't0', '$ev', 0);
    await storeTransaction(db, '@u:ex.com', 'tf', '$ev', false);
    expect(await getTransaction(db, '@u:ex.com', 't0')).toEqual({
      eventId: '$ev',
      response: undefined,
    });
    expect(await getTransaction(db, '@u:ex.com', 'tf')).toEqual({
      eventId: '$ev',
      response: undefined,
    });
  });

  it('uses the default 24h retention cutoff when maxAgeMs is omitted', async () => {
    const db = createTxnDb();
    const oldKey = '@u:ex.com:ancient';
    const recentKey = '@u:ex.com:recent';
    db.store.set(oldKey, {
      event_id: '$a',
      response: null,
      created_at: Date.now() - 25 * 60 * 60 * 1000,
    } as TxnRow & { created_at: number });
    db.store.set(recentKey, {
      event_id: '$b',
      response: null,
      created_at: Date.now() - 60_000,
    } as TxnRow & { created_at: number });

    expect(await cleanupOldTransactions(db)).toBe(1);
    expect(db.store.has(oldKey)).toBe(false);
    expect(db.store.has(recentKey)).toBe(true);
  });
});
