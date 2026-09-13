import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  bumpRoomCacheGeneration,
  getRoomCacheGeneration,
  invalidateRoomCache,
  invalidateBatchRoomCache,
  getRoomMetadata,
  getBatchRoomMetadata,
} from '../src/services/room-cache';
import type { D1Database } from '@cloudflare/workers-types';

function mockKv(
  data: Record<string, string> = {},
  opts: { getThrows?: boolean; putThrows?: boolean; deleteThrows?: boolean } = {}
) {
  return {
    get: async (key: string, type?: string) => {
      if (opts.getThrows) throw new Error('kv get failed');
      const raw = data[key] ?? null;
      if (raw === null) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    put: async (key: string, value: string) => {
      if (opts.putThrows) throw new Error('kv put failed');
      data[key] = value;
    },
    delete: async (key: string) => {
      if (opts.deleteThrows) throw new Error('kv delete failed');
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

describe('room-cache generation TOKENMAXX edge paths after #54', () => {
  it('returns 0 when unset and bumps to 1', async () => {
    const data: Record<string, string> = {};
    const kv = mockKv(data);
    expect(await getRoomCacheGeneration(kv, '!r:ex.com')).toBe(0);
    expect(await bumpRoomCacheGeneration(kv, '!r:ex.com')).toBe(1);
    expect(data['room-meta-gen:!r:ex.com']).toBe('1');
    expect(await getRoomCacheGeneration(kv, '!r:ex.com')).toBe(1);
  });

  it('bumps numeric generations monotonically', async () => {
    const kv = mockKv({ 'room-meta-gen:!r:ex.com': '3' });
    expect(await bumpRoomCacheGeneration(kv, '!r:ex.com')).toBe(4);
  });

  it('treats non-numeric / NaN stored values as zero then bumps to 1', async () => {
    const kv = mockKv({ 'room-meta-gen:!r:ex.com': 'nope' });
    expect(await getRoomCacheGeneration(kv, '!r:ex.com')).toBe(0);
    expect(await bumpRoomCacheGeneration(kv, '!r:ex.com')).toBe(1);
  });

  it('returns 0 from get when KV get throws', async () => {
    expect(await getRoomCacheGeneration(mockKv({}, { getThrows: true }), '!r:ex.com')).toBe(0);
  });

  it('still bumps after a failed get (treat as zero) and rethrows put failures', async () => {
    expect(await bumpRoomCacheGeneration(mockKv({}, { getThrows: true }), '!r:ex.com')).toBe(1);
    await expect(
      bumpRoomCacheGeneration(mockKv({}, { putThrows: true }), '!r:ex.com')
    ).rejects.toThrow(/kv put failed/);
  });
});


describe('room-cache TOKENMAXX edge paths after #55', () => {
  it('treats Infinity / empty-string stored generations as zero', async () => {
    expect(await getRoomCacheGeneration(mockKv({ 'room-meta-gen:!r:ex.com': 'Infinity' }), '!r:ex.com')).toBe(0);
    expect(await bumpRoomCacheGeneration(mockKv({ 'room-meta-gen:!r:ex.com': 'Infinity' }), '!r:ex.com')).toBe(1);
    expect(await getRoomCacheGeneration(mockKv({ 'room-meta-gen:!r:ex.com': '' }), '!r:ex.com')).toBe(0);
    expect(await bumpRoomCacheGeneration(mockKv({ 'room-meta-gen:!r:ex.com': '' }), '!r:ex.com')).toBe(1);
  });

  it('documents parseInt scientific notation: 1e3 → 1 then bump to 2', async () => {
    const data: Record<string, string> = { 'room-meta-gen:!r:ex.com': '1e3' };
    expect(await getRoomCacheGeneration(mockKv(data), '!r:ex.com')).toBe(1);
    expect(await bumpRoomCacheGeneration(mockKv(data), '!r:ex.com')).toBe(2);
  });

  it('invalidates single and batch room-meta keys; swallows delete failures', async () => {
    const data: Record<string, string> = {
      'room-meta:!a:ex.com': '{}',
      'room-meta:!b:ex.com': '{}',
      'room-meta-gen:!a:ex.com': '1',
    };
    const kv = mockKv(data);
    await invalidateRoomCache(kv, '!a:ex.com');
    expect(data['room-meta:!a:ex.com']).toBeUndefined();
    expect(data['room-meta-gen:!a:ex.com']).toBe('1');

    await invalidateBatchRoomCache(kv, ['!b:ex.com', '!missing:ex.com']);
    expect(data['room-meta:!b:ex.com']).toBeUndefined();

    await expect(
      invalidateRoomCache(mockKv({}, { deleteThrows: true }), '!x:ex.com')
    ).resolves.toBeUndefined();
  });
});


function mockDb(batchResults: Array<{ results: unknown[] }>) {
  const prepare = () => ({ bind: () => ({}) });
  return {
    prepare,
    batch: vi.fn(async () => batchResults),
  } as unknown as D1Database;
}

function emptyBatchResults() {
  return Array.from({ length: 6 }, () => ({ results: [] as unknown[] }));
}

describe('room-cache metadata TOKENMAXX edge paths after #57', () => {
  it('returns fresh KV metadata without hitting D1', async () => {
    const cached = {
      name: 'Cached',
      joinedCount: 3,
      invitedCount: 0,
      isDm: false,
      cachedAt: Date.now(),
    };
    const data: Record<string, string> = {
      'room-meta:!r:ex.com': JSON.stringify(cached),
    };
    const kv = mockKv(data);
    const db = mockDb(emptyBatchResults());

    const meta = await getRoomMetadata(kv, db, '!r:ex.com');
    expect(meta).toMatchObject({ name: 'Cached', joinedCount: 3 });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('ignores stale KV entries, fetches DB, and rewrites cache', async () => {
    const stale = {
      name: 'Stale',
      joinedCount: 1,
      invitedCount: 0,
      isDm: false,
      cachedAt: Date.now() - 6 * 60 * 1000,
    };
    const data: Record<string, string> = {
      'room-meta:!r:ex.com': JSON.stringify(stale),
    };
    const kv = mockKv(data);
    const db = mockDb([
      { results: [{ content: JSON.stringify({ name: 'Fresh' }) }] },
      { results: [] },
      { results: [] },
      { results: [] },
      { results: [{ count: 2 }] },
      { results: [{ count: 1 }] },
    ]);

    const meta = await getRoomMetadata(kv, db, '!r:ex.com');
    expect(meta).toMatchObject({
      name: 'Fresh',
      joinedCount: 2,
      invitedCount: 1,
      isDm: false,
    });
    expect(db.batch).toHaveBeenCalledOnce();
    const rewritten = JSON.parse(data['room-meta:!r:ex.com']);
    expect(rewritten.name).toBe('Fresh');
    expect(rewritten.cachedAt).toBeGreaterThan(stale.cachedAt);
  });

  it('batch path mixes KV hits with DB misses and omits empty rooms only when DB returns null', async () => {
    const fresh = {
      name: 'A',
      joinedCount: 2,
      invitedCount: 0,
      isDm: false,
      cachedAt: Date.now(),
    };
    const data: Record<string, string> = {
      'room-meta:!a:ex.com': JSON.stringify(fresh),
    };
    const kv = mockKv(data);
    const db = mockDb([
      { results: [{ content: JSON.stringify({ name: 'B' }) }] },
      { results: [] },
      { results: [] },
      { results: [] },
      { results: [{ count: 1 }] },
      { results: [{ count: 0 }] },
    ]);

    const map = await getBatchRoomMetadata(kv, db, ['!a:ex.com', '!b:ex.com']);
    expect(map.get('!a:ex.com')).toMatchObject({ name: 'A' });
    expect(map.get('!b:ex.com')).toMatchObject({ name: 'B', joinedCount: 1 });
    expect(db.batch).toHaveBeenCalledOnce();
  });

  it('swallows KV get parse failures and still serves DB metadata', async () => {
    const kv = mockKv({}, { getThrows: true });
    const db = mockDb(emptyBatchResults());
    const meta = await getRoomMetadata(kv, db, '!r:ex.com');
    expect(meta).toMatchObject({ joinedCount: 0, invitedCount: 0, isDm: true });
  });
});

describe('room-cache metadata TOKENMAXX edge paths after #58', () => {
  it('returns empty map for empty batch without touching D1', async () => {
    const db = mockDb(emptyBatchResults());
    const map = await getBatchRoomMetadata(mockKv(), db, []);
    expect([...map.keys()]).toEqual([]);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('marks named rooms as non-DM even with joinedCount <= 2', async () => {
    const db = mockDb([
      { results: [{ content: JSON.stringify({ name: 'Lobby' }) }] },
      { results: [] },
      { results: [] },
      { results: [] },
      { results: [{ count: 2 }] },
      { results: [{ count: 0 }] },
    ]);
    const meta = await getRoomMetadata(mockKv(), db, '!r:ex.com');
    expect(meta).toMatchObject({ name: 'Lobby', joinedCount: 2, isDm: false });
  });

  it('still returns DB metadata when KV put throws', async () => {
    const kv = mockKv({}, { putThrows: true });
    const db = mockDb([
      { results: [{ content: JSON.stringify({ name: 'X' }) }] },
      { results: [] },
      { results: [] },
      { results: [] },
      { results: [{ count: 1 }] },
      { results: [{ count: 0 }] },
    ]);
    const meta = await getRoomMetadata(kv, db, '!r:ex.com');
    expect(meta).toMatchObject({ name: 'X', joinedCount: 1, isDm: false });
  });
});

describe('room-cache TTL clock boundaries TOKENMAXX after #60', () => {
  const NOW = 1_700_000_000_000;
  const TTL_MS = 5 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('serves KV hit at age TTL_MS - 1 and misses at exact TTL_MS (strict <)', async () => {
    const hitMeta = {
      name: 'AlmostStale',
      joinedCount: 3,
      invitedCount: 0,
      isDm: false,
      cachedAt: NOW - (TTL_MS - 1),
    };
    const data: Record<string, string> = {
      'room-meta:!hit:ex.com': JSON.stringify(hitMeta),
    };
    const kv = mockKv(data);
    const db = mockDb(emptyBatchResults());
    expect(await getRoomMetadata(kv, db, '!hit:ex.com')).toMatchObject({ name: 'AlmostStale' });
    expect(db.batch).not.toHaveBeenCalled();

    const missMeta = {
      name: 'ExactStale',
      joinedCount: 1,
      invitedCount: 0,
      isDm: false,
      cachedAt: NOW - TTL_MS,
    };
    data['room-meta:!miss:ex.com'] = JSON.stringify(missMeta);
    const missDb = mockDb([
      { results: [{ content: JSON.stringify({ name: 'Refetched' }) }] },
      { results: [] },
      { results: [] },
      { results: [] },
      { results: [{ count: 1 }] },
      { results: [{ count: 0 }] },
    ]);
    expect(await getRoomMetadata(kv, missDb, '!miss:ex.com')).toMatchObject({
      name: 'Refetched',
    });
    expect(missDb.batch).toHaveBeenCalledOnce();
    expect(JSON.parse(data['room-meta:!miss:ex.com']).cachedAt).toBe(NOW);
  });

  it('batch path applies the same strict TTL boundary per room', async () => {
    const data: Record<string, string> = {
      'room-meta:!fresh:ex.com': JSON.stringify({
        name: 'Fresh',
        joinedCount: 2,
        invitedCount: 0,
        isDm: false,
        cachedAt: NOW - (TTL_MS - 1),
      }),
      'room-meta:!stale:ex.com': JSON.stringify({
        name: 'Stale',
        joinedCount: 1,
        invitedCount: 0,
        isDm: false,
        cachedAt: NOW - TTL_MS,
      }),
    };
    const kv = mockKv(data);
    const db = mockDb([
      { results: [{ content: JSON.stringify({ name: 'FromDB' }) }] },
      { results: [] },
      { results: [] },
      { results: [] },
      { results: [{ count: 4 }] },
      { results: [{ count: 0 }] },
    ]);
    const map = await getBatchRoomMetadata(kv, db, ['!fresh:ex.com', '!stale:ex.com']);
    expect(map.get('!fresh:ex.com')).toMatchObject({ name: 'Fresh' });
    expect(map.get('!stale:ex.com')).toMatchObject({ name: 'FromDB', joinedCount: 4 });
  });

  it('parses avatar url, topic, and canonical alias; ignores malformed JSON fields', async () => {
    const db = mockDb([
      { results: [{ content: '{not-json' }] },
      { results: [{ content: JSON.stringify({ url: 'mxc://ex/av' }) }] },
      { results: [{ content: JSON.stringify({ topic: 'Hello' }) }] },
      { results: [{ content: JSON.stringify({ alias: '#room:ex.com' }) }] },
      { results: [{ count: 0 }] },
      { results: [{ count: 2 }] },
    ]);
    const meta = await getRoomMetadata(mockKv(), db, '!r:ex.com');
    expect(meta).toEqual({
      name: undefined,
      avatar: 'mxc://ex/av',
      topic: 'Hello',
      canonicalAlias: '#room:ex.com',
      joinedCount: 0,
      invitedCount: 2,
      isDm: true,
      cachedAt: NOW,
    });
  });

  it('pins isDm for joinedCount 0–3 without a name', async () => {
    for (const count of [0, 1, 2, 3]) {
      const db = mockDb([
        { results: [] },
        { results: [] },
        { results: [] },
        { results: [] },
        { results: [{ count }] },
        { results: [{ count: 0 }] },
      ]);
      const meta = await getRoomMetadata(mockKv(), db, `!c${count}:ex.com`);
      expect(meta?.isDm).toBe(count <= 2);
      expect(meta?.joinedCount).toBe(count);
    }
  });
});
