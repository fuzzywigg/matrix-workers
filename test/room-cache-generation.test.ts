import { describe, it, expect } from 'vitest';
import {
  bumpRoomCacheGeneration,
  getRoomCacheGeneration,
  invalidateRoomCache,
  invalidateBatchRoomCache,
} from '../src/services/room-cache';

function mockKv(
  data: Record<string, string> = {},
  opts: { getThrows?: boolean; putThrows?: boolean; deleteThrows?: boolean } = {}
) {
  return {
    get: async (key: string) => {
      if (opts.getThrows) throw new Error('kv get failed');
      return data[key] ?? null;
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
