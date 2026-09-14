/**
 * TOKENMAXX HEAVY leftovers after #226 — room-cache service *concurrent
 * race / TOCTOU*.
 *
 * Sequential coverage is deep (room-cache-generation.test.ts: generation
 * parse traps, TTL strict-boundary, KV get/put/delete swallow, batch
 * hit/miss mix, isDm pin). Concurrent-race coverage was zero: no
 * Promise.all, no KV get-barrier stampede, no bump∥bump lost-update
 * (documented non-atomic RMW), no get∥invalidate refill TOCTOU, no
 * room-key isolation under parallel miss.
 *
 * Distinct from tip #226 (rate-limit middleware + RateLimitDO sliding
 * window), #223 (oidc-auth SSO state), and rooms API concurrent-race
 * files which *mock* invalidateRoomCache rather than exercising the KV
 * cache service. Orthogonal to media thumbnail KV races.
 *
 * Focus: bump∥bump generation collapse; get-barrier miss stampede
 * dual-put; hit∥hit isolation; get∥invalidate / invalidate∥put; A∥B
 * room-key isolation; batch∥single / batch∥batch; TTL expiry mid
 * concurrent; KV throw isolation; generation get∥bump.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import {
  bumpRoomCacheGeneration,
  getBatchRoomMetadata,
  getRoomCacheGeneration,
  getRoomMetadata,
  invalidateBatchRoomCache,
  invalidateRoomCache,
  type RoomMetadata,
} from '../src/services/room-cache';

const ROOM_A = '!alpha:example.com';
const ROOM_B = '!beta:example.com';
const ROOM_C = '!gamma:example.com';
const ROOM_D = '!delta:example.com';
const NOW = 1_700_000_000_000;
const TTL_MS = 5 * 60 * 1000;

type RoomSpec = {
  name?: string;
  avatar?: string;
  topic?: string;
  alias?: string;
  joined: number;
  invited: number;
};

type Barrier = { remaining: number; waiters: Array<() => void>; hold?: boolean };

type KvCtl = {
  data: Record<string, string>;
  events: string[];
  getCount: Map<string, number>;
  putCount: Map<string, number>;
  deleteCount: Map<string, number>;
  getThrows: Set<string>;
  putThrows: Set<string>;
  deleteThrows: Set<string>;
  getBarrier: Map<string, Barrier>;
  putBarrier: Map<string, Barrier>;
};

function bumpGet(ctl: KvCtl, key: string) {
  ctl.getCount.set(key, (ctl.getCount.get(key) ?? 0) + 1);
}

function bumpPut(ctl: KvCtl, key: string) {
  ctl.putCount.set(key, (ctl.putCount.get(key) ?? 0) + 1);
}

function bumpDel(ctl: KvCtl, key: string) {
  ctl.deleteCount.set(key, (ctl.deleteCount.get(key) ?? 0) + 1);
}

function releaseBarrier(map: Map<string, Barrier>, key: string, events: string[], kind: string) {
  const barrier = map.get(key);
  if (!barrier) return;
  map.delete(key);
  const all = [...barrier.waiters];
  barrier.waiters.length = 0;
  events.push(`${kind}-release:${key}`);
  for (const w of all) w();
}

async function waitBarrier(map: Map<string, Barrier>, key: string, events: string[], kind: string) {
  const barrier = map.get(key);
  if (!barrier) return;
  await new Promise<void>((resolve) => {
    barrier.waiters.push(resolve);
    barrier.remaining -= 1;
    events.push(`${kind}-wait:${key}:${barrier.waiters.length}`);
    if (!barrier.hold && barrier.remaining <= 0) {
      releaseBarrier(map, key, events, kind);
    }
  });
}

function createRacingKv(opts: {
  data?: Record<string, string>;
  getThrows?: string[];
  putThrows?: string[];
  deleteThrows?: string[];
  getBarrier?: Array<[string, number]>;
  putBarrier?: Array<[string, number]>;
  getHold?: string[];
  putHold?: string[];
} = {}): {
  kv: KVNamespace;
  ctl: KvCtl;
  releaseGet: (key: string) => void;
  releasePut: (key: string) => void;
} {
  const ctl: KvCtl = {
    data: opts.data ?? {},
    events: [],
    getCount: new Map(),
    putCount: new Map(),
    deleteCount: new Map(),
    getThrows: new Set(opts.getThrows ?? []),
    putThrows: new Set(opts.putThrows ?? []),
    deleteThrows: new Set(opts.deleteThrows ?? []),
    getBarrier: new Map([
      ...(opts.getBarrier ?? []).map(
        ([key, count]) => [key, { remaining: count, waiters: [] as Array<() => void> }] as const
      ),
      ...(opts.getHold ?? []).map(
        (key) => [key, { remaining: 99, waiters: [] as Array<() => void>, hold: true }] as const
      ),
    ]),
    putBarrier: new Map([
      ...(opts.putBarrier ?? []).map(
        ([key, count]) => [key, { remaining: count, waiters: [] as Array<() => void> }] as const
      ),
      ...(opts.putHold ?? []).map(
        (key) => [key, { remaining: 99, waiters: [] as Array<() => void>, hold: true }] as const
      ),
    ]),
  };

  const kv = {
    get: async (key: string, type?: string) => {
      bumpGet(ctl, key);
      ctl.events.push(`get:${key}`);
      await waitBarrier(ctl.getBarrier, key, ctl.events, 'get');
      if (ctl.getThrows.has(key) || ctl.getThrows.has('*')) {
        throw new Error(`kv-get-throw:${key}`);
      }
      const raw = ctl.data[key];
      if (raw === undefined) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    put: async (key: string, value: string) => {
      bumpPut(ctl, key);
      ctl.events.push(`put:${key}`);
      await waitBarrier(ctl.putBarrier, key, ctl.events, 'put');
      if (ctl.putThrows.has(key) || ctl.putThrows.has('*')) {
        throw new Error(`kv-put-throw:${key}`);
      }
      ctl.data[key] = value;
    },
    delete: async (key: string) => {
      bumpDel(ctl, key);
      ctl.events.push(`delete:${key}`);
      if (ctl.deleteThrows.has(key) || ctl.deleteThrows.has('*')) {
        throw new Error(`kv-delete-throw:${key}`);
      }
      delete ctl.data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;

  return {
    kv,
    ctl,
    releaseGet: (key: string) => releaseBarrier(ctl.getBarrier, key, ctl.events, 'get'),
    releasePut: (key: string) => releaseBarrier(ctl.putBarrier, key, ctl.events, 'put'),
  };
}

function mockDb(rooms: Record<string, RoomSpec>): D1Database & {
  batchCalls: number;
  roomsSeen: string[];
} {
  const state = { batchCalls: 0, roomsSeen: [] as string[] };
  const db = {
    get batchCalls() {
      return state.batchCalls;
    },
    get roomsSeen() {
      return state.roomsSeen;
    },
    prepare(_sql: string) {
      return {
        bind(roomId: string) {
          return { _roomId: roomId };
        },
      };
    },
    batch: vi.fn(async (stmts: Array<{ _roomId: string }>) => {
      state.batchCalls += 1;
      const roomId = stmts[0]?._roomId ?? '';
      state.roomsSeen.push(roomId);
      const spec = rooms[roomId] ?? { joined: 0, invited: 0 };
      return [
        { results: spec.name ? [{ content: JSON.stringify({ name: spec.name }) }] : [] },
        { results: spec.avatar ? [{ content: JSON.stringify({ url: spec.avatar }) }] : [] },
        { results: spec.topic ? [{ content: JSON.stringify({ topic: spec.topic }) }] : [] },
        { results: spec.alias ? [{ content: JSON.stringify({ alias: spec.alias }) }] : [] },
        { results: [{ count: spec.joined }] },
        { results: [{ count: spec.invited }] },
      ];
    }),
  };
  return db as unknown as D1Database & { batchCalls: number; roomsSeen: string[] };
}

function freshMeta(overrides: Partial<RoomMetadata> = {}): RoomMetadata {
  return {
    name: 'Cached',
    joinedCount: 3,
    invitedCount: 0,
    isDm: false,
    cachedAt: NOW,
    ...overrides,
  };
}

function metaKey(roomId: string) {
  return `room-meta:${roomId}`;
}

function genKey(roomId: string) {
  return `room-meta-gen:${roomId}`;
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// bump∥bump generation lost-update (documented non-atomic RMW)
// ---------------------------------------------------------------------------

describe('race room-cache bump∥bump generation lost-update after #226', () => {
  for (let i = 0; i < 14; i++) {
    it(`same-room dual bump get-barrier collapses to 1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[genKey(ROOM_A), 2]],
      });
      const [a, b] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_A),
      ]);
      expect(new Set([a, b])).toEqual(new Set([1]));
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(ctl.getCount.get(genKey(ROOM_A))).toBe(2);
      expect(ctl.putCount.get(genKey(ROOM_A))).toBe(2);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`A∥B bump isolation get-barrier flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [genKey(ROOM_A)]: '4', [genKey(ROOM_B)]: '9' },
        getBarrier: [
          [genKey(ROOM_A), 1],
          [genKey(ROOM_B), 1],
        ],
      });
      const [a, b] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
      ]);
      expect(a).toBe(5);
      expect(b).toBe(10);
      expect(ctl.data[genKey(ROOM_A)]).toBe('5');
      expect(ctl.data[genKey(ROOM_B)]).toBe('10');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`four-way same-room bump collapse flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [genKey(ROOM_C)]: '2' },
        getBarrier: [[genKey(ROOM_C), 4]],
      });
      const results = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_C),
        bumpRoomCacheGeneration(kv, ROOM_C),
        bumpRoomCacheGeneration(kv, ROOM_C),
        bumpRoomCacheGeneration(kv, ROOM_C),
      ]);
      expect(new Set(results)).toEqual(new Set([3]));
      expect(ctl.data[genKey(ROOM_C)]).toBe('3');
      expect(ctl.getCount.get(genKey(ROOM_C))).toBe(4);
    });
  }
});

describe('race room-cache generation get∥bump isolation after #226', () => {
  for (let i = 0; i < 12; i++) {
    it(`get-before-put sees stale 0 while bump writes 1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[genKey(ROOM_A), 2]],
      });
      const [gen, bumped] = await Promise.all([
        getRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_A),
      ]);
      expect(gen).toBe(0);
      expect(bumped).toBe(1);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(await getRoomCacheGeneration(kv, ROOM_A)).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`parallel get after seeded gen stays isolated flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: { [genKey(ROOM_A)]: '7', [genKey(ROOM_B)]: '11' },
      });
      const [a, b, a2] = await Promise.all([
        getRoomCacheGeneration(kv, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_B),
        getRoomCacheGeneration(kv, ROOM_A),
      ]);
      expect(a).toBe(7);
      expect(a2).toBe(7);
      expect(b).toBe(11);
    });
  }
});

// ---------------------------------------------------------------------------
// getRoomMetadata miss stampede — dual D1 fetch + dual put
// ---------------------------------------------------------------------------

describe('race room-cache metadata miss stampede after #226', () => {
  for (let i = 0; i < 14; i++) {
    it(`same-room miss get-barrier dual D1 + dual put flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[metaKey(ROOM_A), 2]],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'Alpha', joined: 4, invited: 1 },
      });
      const [left, right] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_A),
      ]);
      expect(left).toMatchObject({ name: 'Alpha', joinedCount: 4, invitedCount: 1, isDm: false });
      expect(right).toMatchObject({ name: 'Alpha', joinedCount: 4, invitedCount: 1, isDm: false });
      expect(db.batchCalls).toBe(2);
      expect(ctl.putCount.get(metaKey(ROOM_A))).toBe(2);
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('Alpha');
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).cachedAt).toBe(NOW);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`A∥B miss isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'Alpha', joined: 5, invited: 0 },
        [ROOM_B]: { name: 'Beta', joined: 2, invited: 3 },
      });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(a).toMatchObject({ name: 'Alpha', joinedCount: 5 });
      expect(b).toMatchObject({ name: 'Beta', joinedCount: 2, invitedCount: 3 });
      expect(new Set(db.roomsSeen)).toEqual(new Set([ROOM_A, ROOM_B]));
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('Alpha');
      expect(JSON.parse(ctl.data[metaKey(ROOM_B)]).name).toBe('Beta');
    });
  }
});

describe('race room-cache metadata hit∥hit isolation after #226', () => {
  for (let i = 0; i < 12; i++) {
    it(`same-room dual hit never touches D1 flood-${i}`, async () => {
      const cached = freshMeta({ name: 'Hot' });
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(cached) },
        getBarrier: [[metaKey(ROOM_A), 2]],
      });
      const db = mockDb({ [ROOM_A]: { name: 'ShouldNotSee', joined: 99, invited: 0 } });
      const [left, right] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_A),
      ]);
      expect(left).toMatchObject({ name: 'Hot', joinedCount: 3 });
      expect(right).toMatchObject({ name: 'Hot', joinedCount: 3 });
      expect(db.batchCalls).toBe(0);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`hit∥miss rooms isolate D1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'HitA' })) },
      });
      const db = mockDb({
        [ROOM_B]: { name: 'FromDB', joined: 1, invited: 0 },
      });
      const [hit, miss] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(hit).toMatchObject({ name: 'HitA' });
      expect(miss).toMatchObject({ name: 'FromDB', joinedCount: 1 });
      expect(db.roomsSeen).toEqual([ROOM_B]);
      expect(ctl.data[metaKey(ROOM_B)]).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// get∥invalidate / invalidate∥put TOCTOU
// ---------------------------------------------------------------------------

describe('race room-cache get∥invalidate TOCTOU after #226', () => {
  for (let i = 0; i < 12; i++) {
    it(`invalidate while dual get parked → both miss and refill flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StaleName' })) },
        getHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'Refilled', joined: 6, invited: 0 } });

      const reads = Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_A),
      ]);
      await vi.waitFor(() => {
        expect(ctl.events.filter((e) => e.startsWith('get-wait:')).length).toBe(2);
      });
      await invalidateRoomCache(kv, ROOM_A);
      releaseGet(metaKey(ROOM_A));
      const [left, right] = await reads;
      expect(left).toMatchObject({ name: 'Refilled', joinedCount: 6 });
      expect(right).toMatchObject({ name: 'Refilled', joinedCount: 6 });
      expect(db.batchCalls).toBe(2);
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('Refilled');
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`put-hold miss refill vs concurrent invalidate last-writer flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'Filled', joined: 2, invited: 0 } });

      const fillP = getRoomMetadata(kv, db, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.filter((e) => e.startsWith('put-wait:')).length).toBeGreaterThan(0);
      });
      await invalidateRoomCache(kv, ROOM_A);
      releasePut(metaKey(ROOM_A));
      const filled = await fillP;
      expect(filled).toMatchObject({ name: 'Filled' });
      // put runs after invalidate: last-writer-wins refill (documented TOCTOU).
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('Filled');
      expect(ctl.deleteCount.get(metaKey(ROOM_A))).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_A))).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`invalidate∥invalidate same key is idempotent flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta()) },
      });
      await Promise.all([
        invalidateRoomCache(kv, ROOM_A),
        invalidateRoomCache(kv, ROOM_A),
        invalidateRoomCache(kv, ROOM_A),
      ]);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.deleteCount.get(metaKey(ROOM_A))).toBe(3);
    });
  }
});

describe('race room-cache invalidate A∥B isolation after #226', () => {
  for (let i = 0; i < 10; i++) {
    it(`batch invalidate∥single get isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'KeepMe' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'DropMe' })),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'DropMeToo' })),
        },
      });
      const db = mockDb({});
      const [hit, _inv] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        invalidateBatchRoomCache(kv, [ROOM_B, ROOM_C]),
      ]);
      expect(hit).toMatchObject({ name: 'KeepMe' });
      expect(ctl.data[metaKey(ROOM_A)]).toBeDefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_C)]).toBeUndefined();
      expect(db.batchCalls).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Stale TTL under concurrent readers
// ---------------------------------------------------------------------------

describe('race room-cache TTL miss∥hit concurrent after #226', () => {
  for (let i = 0; i < 10; i++) {
    it(`stale TTL dual miss both refetch flood-${i}`, async () => {
      const stale = freshMeta({ name: 'Expired', cachedAt: NOW - TTL_MS });
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(stale) },
        getBarrier: [[metaKey(ROOM_A), 2]],
      });
      const db = mockDb({ [ROOM_A]: { name: 'Rewritten', joined: 8, invited: 0 } });
      const [left, right] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_A),
      ]);
      expect(left).toMatchObject({ name: 'Rewritten', joinedCount: 8 });
      expect(right).toMatchObject({ name: 'Rewritten', joinedCount: 8 });
      expect(db.batchCalls).toBe(2);
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).cachedAt).toBe(NOW);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`almost-stale hit∥exact-stale miss isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(
            freshMeta({ name: 'Almost', cachedAt: NOW - (TTL_MS - 1) })
          ),
          [metaKey(ROOM_B)]: JSON.stringify(
            freshMeta({ name: 'Exact', cachedAt: NOW - TTL_MS })
          ),
        },
      });
      const db = mockDb({ [ROOM_B]: { name: 'BFromDB', joined: 1, invited: 0 } });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(a).toMatchObject({ name: 'Almost' });
      expect(b).toMatchObject({ name: 'BFromDB' });
      expect(db.roomsSeen).toEqual([ROOM_B]);
      expect(JSON.parse(ctl.data[metaKey(ROOM_B)]).name).toBe('BFromDB');
    });
  }
});

// ---------------------------------------------------------------------------
// KV throw isolation under Promise.all
// ---------------------------------------------------------------------------

describe('race room-cache KV throw isolation after #226', () => {
  for (let i = 0; i < 10; i++) {
    it(`get-throw miss falls to D1 while sibling hits flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HitB' })) },
        getThrows: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'ViaThrow', joined: 2, invited: 0 } });
      const [viaThrow, hit] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(viaThrow).toMatchObject({ name: 'ViaThrow', joinedCount: 2 });
      expect(hit).toMatchObject({ name: 'HitB' });
      expect(db.roomsSeen).toEqual([ROOM_A]);
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('ViaThrow');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`put-throw still returns DB meta∥sibling caches flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        putThrows: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'NoCache', joined: 1, invited: 0 },
        [ROOM_B]: { name: 'CachedB', joined: 3, invited: 0 },
      });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(a).toMatchObject({ name: 'NoCache' });
      expect(b).toMatchObject({ name: 'CachedB' });
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(JSON.parse(ctl.data[metaKey(ROOM_B)]).name).toBe('CachedB');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`delete-throw invalidate swallows∥sibling delete succeeds flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'A' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'B' })),
        },
        deleteThrows: [metaKey(ROOM_A)],
      });
      await Promise.all([
        invalidateRoomCache(kv, ROOM_A),
        invalidateRoomCache(kv, ROOM_B),
      ]);
      expect(ctl.data[metaKey(ROOM_A)]).toBeDefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeUndefined();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`bump put-throw rejects∥sibling bump succeeds flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        putThrows: [genKey(ROOM_A)],
      });
      const [failed, ok] = await Promise.allSettled([
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
      ]);
      expect(failed.status).toBe('rejected');
      expect(ok).toEqual({ status: 'fulfilled', value: 1 });
      expect(ctl.data[genKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[genKey(ROOM_B)]).toBe('1');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`bump get-throw treats zero then writes 1∥sibling seeded flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [genKey(ROOM_B)]: '5' },
        getThrows: [genKey(ROOM_A)],
      });
      const [a, b] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
      ]);
      expect(a).toBe(1);
      expect(b).toBe(6);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
    });
  }
});

// ---------------------------------------------------------------------------
// getBatchRoomMetadata concurrent isolation
// ---------------------------------------------------------------------------

describe('race room-cache batch∥single isolation after #226', () => {
  for (let i = 0; i < 10; i++) {
    it(`batch A+B∥single C isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Ahit' })),
        },
      });
      const db = mockDb({
        [ROOM_B]: { name: 'Bdb', joined: 2, invited: 1 },
        [ROOM_C]: { name: 'Cdb', joined: 9, invited: 0 },
      });
      const [batch, single] = await Promise.all([
        getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]),
        getRoomMetadata(kv, db, ROOM_C),
      ]);
      expect(batch.get(ROOM_A)).toMatchObject({ name: 'Ahit' });
      expect(batch.get(ROOM_B)).toMatchObject({ name: 'Bdb', joinedCount: 2, invitedCount: 1 });
      expect(single).toMatchObject({ name: 'Cdb', joinedCount: 9 });
      expect(new Set(db.roomsSeen)).toEqual(new Set([ROOM_B, ROOM_C]));
      expect(JSON.parse(ctl.data[metaKey(ROOM_C)]).name).toBe('Cdb');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`two batches overlapping A isolate values flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Shared' })),
        },
      });
      const db = mockDb({
        [ROOM_B]: { name: 'Bonly', joined: 1, invited: 0 },
        [ROOM_C]: { name: 'Conly', joined: 1, invited: 0 },
      });
      const [left, right] = await Promise.all([
        getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]),
        getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_C]),
      ]);
      expect(left.get(ROOM_A)).toMatchObject({ name: 'Shared' });
      expect(right.get(ROOM_A)).toMatchObject({ name: 'Shared' });
      expect(left.get(ROOM_B)).toMatchObject({ name: 'Bonly' });
      expect(right.get(ROOM_C)).toMatchObject({ name: 'Conly' });
      expect(left.has(ROOM_C)).toBe(false);
      expect(right.has(ROOM_B)).toBe(false);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`batch all-miss four rooms put isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: { name: 'A', joined: 1, invited: 0 },
        [ROOM_B]: { name: 'B', joined: 2, invited: 0 },
        [ROOM_C]: { name: 'C', joined: 3, invited: 0 },
        [ROOM_D]: { name: 'D', joined: 4, invited: 0 },
      });
      const map = await getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B, ROOM_C, ROOM_D]);
      expect([...map.keys()].sort()).toEqual([ROOM_A, ROOM_B, ROOM_C, ROOM_D].sort());
      expect(map.get(ROOM_A)).toMatchObject({ name: 'A', joinedCount: 1 });
      expect(map.get(ROOM_D)).toMatchObject({ name: 'D', joinedCount: 4 });
      expect(db.batchCalls).toBe(4);
      await vi.waitFor(() => {
        expect(ctl.putCount.size).toBe(4);
      });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`empty batch∥populated batch isolation flood-${i}`, async () => {
      const { kv } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: { name: 'Only', joined: 2, invited: 0 },
      });
      const [empty, populated] = await Promise.all([
        getBatchRoomMetadata(kv, db, []),
        getBatchRoomMetadata(kv, db, [ROOM_A]),
      ]);
      expect([...empty.keys()]).toEqual([]);
      expect(populated.get(ROOM_A)).toMatchObject({ name: 'Only' });
    });
  }
});

describe('race room-cache batch get-throw per-room isolation after #226', () => {
  for (let i = 0; i < 8; i++) {
    it(`batch get-throw on A still fills B from D1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getThrows: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'Athrow', joined: 2, invited: 0 },
        [ROOM_B]: { name: 'Bok', joined: 5, invited: 1 },
      });
      const map = await getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]);
      expect(map.get(ROOM_A)).toMatchObject({ name: 'Athrow' });
      expect(map.get(ROOM_B)).toMatchObject({ name: 'Bok', joinedCount: 5 });
      expect(new Set(db.roomsSeen)).toEqual(new Set([ROOM_A, ROOM_B]));
      await vi.waitFor(() => {
        expect(ctl.putCount.get(metaKey(ROOM_A))).toBe(1);
        expect(ctl.putCount.get(metaKey(ROOM_B))).toBe(1);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// bump does not rewrite room-meta; get does not bump generation
// ---------------------------------------------------------------------------

describe('race room-cache meta key ∥ generation key orthogonality after #226', () => {
  for (let i = 0; i < 10; i++) {
    it(`metadata miss put never writes gen key flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      const db = mockDb({ [ROOM_A]: { name: 'Ortho', joined: 2, invited: 0 } });
      const [meta, gen] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_A),
      ]);
      expect(meta).toMatchObject({ name: 'Ortho' });
      expect(gen).toBe(0);
      expect(ctl.data[genKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_A)]).toBeDefined();
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`bump∥get hit: generation moves, hot meta still served flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StillHot' })) },
      });
      const db = mockDb({ [ROOM_A]: { name: 'ShouldNotFetch', joined: 99, invited: 0 } });
      const [bumped, meta] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        getRoomMetadata(kv, db, ROOM_A),
      ]);
      expect(bumped).toBe(1);
      expect(meta).toMatchObject({ name: 'StillHot' });
      expect(db.batchCalls).toBe(0);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('StillHot');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`invalidate meta preserves generation key flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta()),
          [genKey(ROOM_A)]: '4',
        },
      });
      await Promise.all([
        invalidateRoomCache(kv, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_A),
      ]);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[genKey(ROOM_A)]).toBe('4');
    });
  }
});

// ---------------------------------------------------------------------------
// Field parse isolation under concurrent DB fills
// ---------------------------------------------------------------------------

describe('race room-cache DB field isolation under parallel miss after #226', () => {
  for (let i = 0; i < 8; i++) {
    it(`avatar/topic/alias rooms isolate flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: { avatar: 'mxc://example.com/av', joined: 1, invited: 0 },
        [ROOM_B]: { topic: 'hello topic', joined: 2, invited: 0 },
        [ROOM_C]: { alias: '#room:example.com', joined: 3, invited: 2 },
      });
      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);
      expect(a).toMatchObject({ avatar: 'mxc://example.com/av', name: undefined, isDm: true });
      expect(b).toMatchObject({ topic: 'hello topic', joinedCount: 2, isDm: true });
      expect(c).toMatchObject({
        canonicalAlias: '#room:example.com',
        invitedCount: 2,
        isDm: false,
      });
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).avatar).toBe('mxc://example.com/av');
      expect(JSON.parse(ctl.data[metaKey(ROOM_B)]).topic).toBe('hello topic');
      expect(JSON.parse(ctl.data[metaKey(ROOM_C)]).canonicalAlias).toBe('#room:example.com');
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`unnamed joinedCount DM pin concurrent flood-${i}`, async () => {
      const { kv } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: { joined: 0, invited: 0 },
        [ROOM_B]: { joined: 2, invited: 0 },
        [ROOM_C]: { joined: 3, invited: 0 },
        [ROOM_D]: { name: 'Named', joined: 2, invited: 0 },
      });
      const [a, b, c, d] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
        getRoomMetadata(kv, db, ROOM_D),
      ]);
      expect(a?.isDm).toBe(true);
      expect(b?.isDm).toBe(true);
      expect(c?.isDm).toBe(false);
      expect(d?.isDm).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — malformed generation + charset room ids under parallel
// ---------------------------------------------------------------------------

describe('race room-cache generation parse concurrent after #226', () => {
  const cases: Array<[string, string, number]> = [
    ['nope', ROOM_A, 1],
    ['Infinity', ROOM_B, 1],
    ['', ROOM_C, 1],
    ['1e3', ROOM_D, 2],
  ];

  for (let i = 0; i < 6; i++) {
    it(`malformed gen parse∥bump matrix flood-${i}`, async () => {
      const data: Record<string, string> = {};
      for (const [raw, room] of cases) {
        data[genKey(room)] = raw;
      }
      const { kv } = createRacingKv({ data });
      const results = await Promise.all(
        cases.map(([, room]) => bumpRoomCacheGeneration(kv, room))
      );
      expect(results).toEqual(cases.map((c) => c[2]));
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`get generation parse matrix concurrent flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: 'nope',
          [genKey(ROOM_B)]: 'Infinity',
          [genKey(ROOM_C)]: '',
          [genKey(ROOM_D)]: '1e3',
        },
      });
      const [a, b, c, d] = await Promise.all([
        getRoomCacheGeneration(kv, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_B),
        getRoomCacheGeneration(kv, ROOM_C),
        getRoomCacheGeneration(kv, ROOM_D),
      ]);
      expect([a, b, c, d]).toEqual([0, 0, 0, 1]);
    });
  }
});

describe('race room-cache concurrent SQL/KV bind contracts after #226', () => {
  it('miss stampede bind room_id matches request for both legs', async () => {
    const { kv } = createRacingKv({
      getBarrier: [[metaKey(ROOM_A), 2]],
    });
    const db = mockDb({ [ROOM_A]: { name: 'Bind', joined: 1, invited: 0 } });
    await Promise.all([
      getRoomMetadata(kv, db, ROOM_A),
      getRoomMetadata(kv, db, ROOM_A),
    ]);
    expect(db.roomsSeen).toEqual([ROOM_A, ROOM_A]);
  });

  it('batch miss binds each uncached room once', async () => {
    const { kv } = createRacingKv();
    const db = mockDb({
      [ROOM_A]: { name: 'A', joined: 1, invited: 0 },
      [ROOM_B]: { name: 'B', joined: 1, invited: 0 },
    });
    await getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]);
    expect(new Set(db.roomsSeen)).toEqual(new Set([ROOM_A, ROOM_B]));
    expect(db.batchCalls).toBe(2);
  });

  it('generation keys never collide with metadata keys under parallel', async () => {
    const { kv, ctl } = createRacingKv();
    const db = mockDb({ [ROOM_A]: { name: 'X', joined: 1, invited: 0 } });
    await Promise.all([
      getRoomMetadata(kv, db, ROOM_A),
      bumpRoomCacheGeneration(kv, ROOM_A),
    ]);
    expect(Object.keys(ctl.data).sort()).toEqual([metaKey(ROOM_A), genKey(ROOM_A)].sort());
  });
});
