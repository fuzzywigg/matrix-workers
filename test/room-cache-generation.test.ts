import { describe, it, expect, vi } from 'vitest';
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
