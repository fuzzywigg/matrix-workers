import { describe, it, expect } from 'vitest';
import {
  bumpRoomCacheGeneration,
  getRoomCacheGeneration,
  invalidateRoomCache,
} from '../src/services/room-cache';

function mockKv(store: Record<string, string> = {}): KVNamespace & { store: Record<string, string> } {
  const kv = {
    store,
    get: async (key: string) => store[key] ?? null,
    put: async (key: string, value: string) => {
      store[key] = value;
    },
    delete: async (key: string) => {
      delete store[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
  return kv as unknown as KVNamespace & { store: Record<string, string> };
}

describe('room cache generation', () => {
  const roomId = '!room:example.com';

  it('returns 0 on miss and bumps 0→1→2 monotonically', async () => {
    const cache = mockKv();
    expect(await getRoomCacheGeneration(cache, roomId)).toBe(0);
    expect(await bumpRoomCacheGeneration(cache, roomId)).toBe(1);
    expect(await bumpRoomCacheGeneration(cache, roomId)).toBe(2);
    expect(cache.store[`room-meta-gen:${roomId}`]).toBe('2');
    expect(await getRoomCacheGeneration(cache, roomId)).toBe(2);
  });

  it('treats non-numeric / empty / NaN / Infinity as 0 on get and bump', async () => {
    const cache = mockKv();
    const key = `room-meta-gen:${roomId}`;

    cache.store[key] = '';
    expect(await getRoomCacheGeneration(cache, roomId)).toBe(0);

    cache.store[key] = 'NaN';
    expect(await getRoomCacheGeneration(cache, roomId)).toBe(0);
    expect(await bumpRoomCacheGeneration(cache, roomId)).toBe(1);

    cache.store[key] = 'Infinity';
    expect(await getRoomCacheGeneration(cache, roomId)).toBe(0);

    cache.store[key] = 'garbage';
    expect(await getRoomCacheGeneration(cache, roomId)).toBe(0);
    expect(await bumpRoomCacheGeneration(cache, roomId)).toBe(1);
  });

  it('collapses concurrent bumps from the same read into current+1', async () => {
    const cache = mockKv({ [`room-meta-gen:${roomId}`]: '5' });
    const [a, b] = await Promise.all([
      bumpRoomCacheGeneration(cache, roomId),
      bumpRoomCacheGeneration(cache, roomId),
    ]);
    // Both read 5 then write 6 — exactness not guaranteed, monotonicity is
    expect(a).toBe(6);
    expect(b).toBe(6);
    expect(await getRoomCacheGeneration(cache, roomId)).toBe(6);
  });

  it('rethrows when put fails; get returns 0 when get throws', async () => {
    const cache = mockKv();
    cache.put = async () => {
      throw new Error('put boom');
    };
    await expect(bumpRoomCacheGeneration(cache, roomId)).rejects.toThrow(/put boom/);

    const failingGet = mockKv();
    failingGet.get = async () => {
      throw new Error('get boom');
    };
    expect(await getRoomCacheGeneration(failingGet, roomId)).toBe(0);
    // bump still advances from treated-zero current
    expect(await bumpRoomCacheGeneration(failingGet, roomId)).toBe(1);
  });

  it('invalidateRoomCache deletes room-meta key and swallows delete errors', async () => {
    const cache = mockKv({ [`room-meta:${roomId}`]: '{"name":"x"}' });
    await invalidateRoomCache(cache, roomId);
    expect(cache.store[`room-meta:${roomId}`]).toBeUndefined();

    cache.delete = async () => {
      throw new Error('delete boom');
    };
    await expect(invalidateRoomCache(cache, roomId)).resolves.toBeUndefined();
  });
});
