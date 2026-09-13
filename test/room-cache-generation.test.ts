import { describe, it, expect } from 'vitest';
import {
  bumpRoomCacheGeneration,
  getRoomCacheGeneration,
} from '../src/services/room-cache';

function mockKv(data: Record<string, string> = {}, opts: { getThrows?: boolean; putThrows?: boolean } = {}) {
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
