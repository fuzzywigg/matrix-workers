import { describe, it, expect, vi } from 'vitest';
import { idempotent, idempotentResponse } from '../src/middleware/idempotency';
import { storeTransaction } from '../src/services/transactions';

type TxnRow = { event_id: string | null; response: string | null };

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
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & { store: Map<string, TxnRow> };
}

function makeCtx(opts: {
  txnId?: string;
  userId?: string;
  db: D1Database;
}) {
  return {
    req: {
      param: (k: string) => (k === 'txnId' ? opts.txnId : undefined),
    },
    get: (k: string) => (k === 'userId' ? opts.userId : undefined),
    env: { DB: opts.db },
    json: (body: unknown) => ({ body }),
  } as any;
}

describe('idempotent middleware TOKENMAXX edge paths after #58', () => {
  it('calls next when txnId or userId is missing', async () => {
    const db = createTxnDb();
    const next = vi.fn(async () => 'ok');
    const mw = idempotent();

    await expect(mw(makeCtx({ db }), next)).resolves.toBe('ok');
    await expect(mw(makeCtx({ db, txnId: 't1' }), next)).resolves.toBe('ok');
    await expect(mw(makeCtx({ db, userId: '@u:ex.com' }), next)).resolves.toBe('ok');
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('returns cached JSON response without calling next', async () => {
    const db = createTxnDb();
    await storeTransaction(db, '@u:ex.com', 't1', '$e', { event_id: '$e', ok: true });
    const next = vi.fn();
    const result = await idempotent()(
      makeCtx({ db, txnId: 't1', userId: '@u:ex.com' }),
      next
    );
    expect(result).toEqual({ body: { event_id: '$e', ok: true } });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns { event_id } when only eventId was stored', async () => {
    const db = createTxnDb(
      new Map([['@u:ex.com:t2', { event_id: '$only', response: null }]])
    );
    const result = await idempotent()(
      makeCtx({ db, txnId: 't2', userId: '@u:ex.com' }),
      vi.fn()
    );
    expect(result).toEqual({ body: { event_id: '$only' } });
  });

  it('returns empty object when existing row has neither response nor eventId', async () => {
    const db = createTxnDb(
      new Map([['@u:ex.com:t3', { event_id: null, response: null }]])
    );
    const result = await idempotent()(
      makeCtx({ db, txnId: 't3', userId: '@u:ex.com' }),
      vi.fn()
    );
    expect(result).toEqual({ body: {} });
  });

  it('continues to next when txn is new (pre-check only; does not return next result)', async () => {
    const db = createTxnDb();
    const next = vi.fn(async () => 'fresh');
    const result = await idempotent()(
      makeCtx({ db, txnId: 'new', userId: '@u:ex.com' }),
      next
    );
    expect(next).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
  });
});

describe('idempotentResponse TOKENMAXX edge paths after #58', () => {
  it('stores then returns body when txnId and userId are present', async () => {
    const db = createTxnDb();
    const ctx = makeCtx({ db, txnId: 't4', userId: '@u:ex.com' });
    const result = await idempotentResponse(ctx, { event_id: '$new' }, '$new');
    expect(result).toEqual({ body: { event_id: '$new' } });
    expect(db.store.get('@u:ex.com:t4')).toEqual({
      event_id: '$new',
      response: JSON.stringify({ event_id: '$new' }),
    });
  });

  it('skips store when txnId or userId is missing', async () => {
    const db = createTxnDb();
    await idempotentResponse(makeCtx({ db }), { a: 1 });
    await idempotentResponse(makeCtx({ db, txnId: 't' }), { a: 1 });
    await idempotentResponse(makeCtx({ db, userId: '@u:ex.com' }), { a: 1 });
    expect(db.store.size).toBe(0);
  });
});

describe('idempotentResponse TOKENMAXX leftovers after #78', () => {
  it('stores event_id as null when eventId arg is omitted', async () => {
    const db = createTxnDb();
    const ctx = makeCtx({ db, txnId: 't-null', userId: '@u:ex.com' });
    const result = await idempotentResponse(ctx, { ok: true });
    expect(result).toEqual({ body: { ok: true } });
    expect(db.store.get('@u:ex.com:t-null')).toEqual({
      event_id: null,
      response: JSON.stringify({ ok: true }),
    });
  });

  it('stores event_id as null when eventId is explicitly undefined', async () => {
    const db = createTxnDb();
    const ctx = makeCtx({ db, txnId: 't-undef', userId: '@u:ex.com' });
    await idempotentResponse(ctx, { event_id: '$maybe' }, undefined);
    expect(db.store.get('@u:ex.com:t-undef')).toEqual({
      event_id: null,
      response: JSON.stringify({ event_id: '$maybe' }),
    });
  });
});
