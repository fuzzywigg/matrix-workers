/**
 * TOKENMAXX HEAVY leftovers after #232 — residual room-cache *concurrent
 * race / TOCTOU* slices not covered by #232 (KV get-barrier stampede,
 * bump∥bump collapse, get∥invalidate refill, batch∥single isolation).
 *
 * Residual focus:
 *   - parseInt leftover matrix (hex/octal/plus/leading-zero/negative/ws)
 *   - missing/NaN/future cachedAt TTL decisions under Promise.all
 *   - batch miss stampede + duplicate roomIds in one batch
 *   - fire-and-forget batch put (not awaited) vs immediate single get
 *   - batch put-throw swallow vs sibling cache
 *   - bump put-hold generation read sees stale until release
 *   - collapse then sequential bump monotonicity
 *   - overlapping invalidateBatch lists; empty∥populated batch invalidate
 *   - KV json parse throw isolation; expirationTtl pin on concurrent put
 *   - unnamed invited-only / never-null miss isolation
 *
 * Call-room hibernation concurrent leftovers live in
 * test/call-room-hibernation.test.ts (same PR). Tests-only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file
 * and the hibernation concurrent describes.
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
const TTL_SECONDS = 60 * 5;

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
  jsonThrows: Set<string>;
  getBarrier: Map<string, Barrier>;
  putBarrier: Map<string, Barrier>;
  putTtl: Map<string, number | undefined>;
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

function createRacingKv(
  opts: {
    data?: Record<string, string>;
    getThrows?: string[];
    putThrows?: string[];
    deleteThrows?: string[];
    jsonThrows?: string[];
    getBarrier?: Array<[string, number]>;
    putBarrier?: Array<[string, number]>;
    getHold?: string[];
    putHold?: string[];
  } = {}
): {
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
    jsonThrows: new Set(opts.jsonThrows ?? []),
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
    putTtl: new Map(),
  };

  const kv = {
    get: async (key: string, type?: string) => {
      bumpGet(ctl, key);
      ctl.events.push(`get:${key}`);
      await waitBarrier(ctl.getBarrier, key, ctl.events, 'get');
      if (ctl.getThrows.has(key) || ctl.getThrows.has('*')) {
        throw new Error(`kv-get-throw:${key}`);
      }
      if (type === 'json' && ctl.jsonThrows.has(key)) {
        throw new SyntaxError(`kv-json-throw:${key}`);
      }
      const raw = ctl.data[key];
      if (raw === undefined) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      bumpPut(ctl, key);
      ctl.events.push(`put:${key}`);
      ctl.putTtl.set(key, options?.expirationTtl);
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

describe('race residual parseInt generation matrix after #232', () => {
  const cases: Array<[string, string, number, number]> = [
    ['0x10', ROOM_A, 0, 1],
    ['010', ROOM_B, 10, 11],
    ['+7', ROOM_C, 7, 8],
    ['  4', ROOM_D, 4, 5],
  ];

  for (let i = 0; i < 8; i++) {
    it(`hex/octal/plus/ws get∥bump matrix flood-${i}`, async () => {
      const data: Record<string, string> = {};
      for (const [raw, room] of cases) data[genKey(room)] = raw;
      const { kv } = createRacingKv({ data });
      const gets = await Promise.all(cases.map(([, room]) => getRoomCacheGeneration(kv, room)));
      expect(gets).toEqual(cases.map((c) => c[2]));
      const bumps = await Promise.all(cases.map(([, room]) => bumpRoomCacheGeneration(kv, room)));
      expect(bumps).toEqual(cases.map((c) => c[3]));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`negative/trailing-junk/null-token concurrent bump flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '-3',
          [genKey(ROOM_B)]: '5abc',
          [genKey(ROOM_C)]: 'null',
          [genKey(ROOM_D)]: 'NaN',
        },
      });
      const [a, b, c, d] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
        bumpRoomCacheGeneration(kv, ROOM_C),
        bumpRoomCacheGeneration(kv, ROOM_D),
      ]);
      expect(a).toBe(-2);
      expect(b).toBe(6);
      expect(c).toBe(1);
      expect(d).toBe(1);
      expect(ctl.data[genKey(ROOM_A)]).toBe('-2');
      expect(ctl.data[genKey(ROOM_B)]).toBe('6');
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`leading-zero vs 1e3 isolation already-covered sibling flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '00',
          [genKey(ROOM_B)]: '-0',
        },
      });
      const [a, b] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
      ]);
      expect(a).toBe(1);
      expect(b).toBe(1);
    });
  }
});

describe('race residual cachedAt TTL leftovers after #232', () => {
  for (let i = 0; i < 8; i++) {
    it(`missing cachedAt is miss∥sibling hot hit flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify({ name: 'NoClock', joinedCount: 1, invitedCount: 0, isDm: true }),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HotB' })),
        },
      });
      const db = mockDb({ [ROOM_A]: { name: 'FilledA', joined: 4, invited: 0 } });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(a).toMatchObject({ name: 'FilledA', joinedCount: 4 });
      expect(b).toMatchObject({ name: 'HotB' });
      expect(db.roomsSeen).toEqual([ROOM_A]);
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).cachedAt).toBe(NOW);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`NaN cachedAt miss∥far-past TTL dual isolation flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'NanClock', cachedAt: Number.NaN })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'Ancient', cachedAt: NOW - TTL_MS * 10 })),
        },
      });
      const db = mockDb({
        [ROOM_A]: { name: 'A2', joined: 1, invited: 0 },
        [ROOM_B]: { name: 'B2', joined: 2, invited: 0 },
      });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(a).toMatchObject({ name: 'A2' });
      expect(b).toMatchObject({ name: 'B2' });
      expect(new Set(db.roomsSeen)).toEqual(new Set([ROOM_A, ROOM_B]));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`future cachedAt clock-skew still hits∥stale sibling misses flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'FromFuture', cachedAt: NOW + 60_000 })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'ExactStale', cachedAt: NOW - TTL_MS })),
        },
      });
      const db = mockDb({ [ROOM_B]: { name: 'Bdb', joined: 1, invited: 0 } });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(a).toMatchObject({ name: 'FromFuture' });
      expect(b).toMatchObject({ name: 'Bdb' });
      expect(db.roomsSeen).toEqual([ROOM_B]);
    });
  }
});

describe('race residual batch miss stampede + duplicate ids after #232', () => {
  for (let i = 0; i < 10; i++) {
    it(`two batches same uncached room dual D1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[metaKey(ROOM_A), 2]],
      });
      const db = mockDb({ [ROOM_A]: { name: 'Stampede', joined: 3, invited: 0 } });
      const [left, right] = await Promise.all([
        getBatchRoomMetadata(kv, db, [ROOM_A]),
        getBatchRoomMetadata(kv, db, [ROOM_A]),
      ]);
      expect(left.get(ROOM_A)).toMatchObject({ name: 'Stampede' });
      expect(right.get(ROOM_A)).toMatchObject({ name: 'Stampede' });
      expect(db.batchCalls).toBe(2);
      await vi.waitFor(() => {
        expect(ctl.putCount.get(metaKey(ROOM_A))).toBe(2);
      });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`duplicate roomIds in one batch refetch twice flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      const db = mockDb({ [ROOM_A]: { name: 'Dup', joined: 2, invited: 1 } });
      const map = await getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_A]);
      expect(map.get(ROOM_A)).toMatchObject({ name: 'Dup', invitedCount: 1 });
      expect(db.roomsSeen).toEqual([ROOM_A, ROOM_A]);
      await vi.waitFor(() => {
        expect(ctl.putCount.get(metaKey(ROOM_A))).toBe(2);
      });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`batch A+A∥single B isolation flood-${i}`, async () => {
      const { kv } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: { name: 'A', joined: 1, invited: 0 },
        [ROOM_B]: { name: 'B', joined: 9, invited: 0 },
      });
      const [batch, single] = await Promise.all([
        getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_A]),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(batch.get(ROOM_A)).toMatchObject({ name: 'A' });
      expect(single).toMatchObject({ name: 'B' });
      expect(batch.has(ROOM_B)).toBe(false);
    });
  }
});

describe('race residual fire-and-forget batch put vs single get after #232', () => {
  for (let i = 0; i < 10; i++) {
    it(`batch put-hold returns map before KV write then hit flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'BatchFill', joined: 2, invited: 0 } });

      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A]);
      await vi.waitFor(() => {
        expect(ctl.events.filter((e) => e.startsWith('put-wait:')).length).toBeGreaterThan(0);
      });
      const batch = await batchP;
      expect(batch.get(ROOM_A)).toMatchObject({ name: 'BatchFill' });
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(db.batchCalls).toBe(1);

      releasePut(metaKey(ROOM_A));
      await vi.waitFor(() => {
        expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('BatchFill');
      });
      const hit = await getRoomMetadata(kv, db, ROOM_A);
      expect(hit).toMatchObject({ name: 'BatchFill' });
      expect(db.batchCalls).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`batch put-throw swallows and still returns metadata flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        putThrows: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'NoPut', joined: 1, invited: 0 },
        [ROOM_B]: { name: 'PutB', joined: 3, invited: 0 },
      });
      const map = await getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]);
      expect(map.get(ROOM_A)).toMatchObject({ name: 'NoPut' });
      expect(map.get(ROOM_B)).toMatchObject({ name: 'PutB' });
      await vi.waitFor(() => {
        expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
        expect(JSON.parse(ctl.data[metaKey(ROOM_B)]).name).toBe('PutB');
      });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`batch get-hold invalidate mid-read both rooms refill flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'OldA' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'OldB' })),
        },
        getHold: [metaKey(ROOM_A), metaKey(ROOM_B)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'NewA', joined: 5, invited: 0 },
        [ROOM_B]: { name: 'NewB', joined: 6, invited: 0 },
      });
      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]);
      await vi.waitFor(() => {
        expect(ctl.events.filter((e) => e.startsWith('get-wait:')).length).toBe(2);
      });
      await invalidateBatchRoomCache(kv, [ROOM_A, ROOM_B]);
      releaseGet(metaKey(ROOM_A));
      releaseGet(metaKey(ROOM_B));
      const map = await batchP;
      expect(map.get(ROOM_A)).toMatchObject({ name: 'NewA' });
      expect(map.get(ROOM_B)).toMatchObject({ name: 'NewB' });
      expect(db.batchCalls).toBe(2);
    });
  }
});

describe('race residual bump put-hold + collapse then sequential after #232', () => {
  for (let i = 0; i < 10; i++) {
    it(`put-hold bump: generation get still 0 until release flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [genKey(ROOM_A)],
      });
      const bumpP = bumpRoomCacheGeneration(kv, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.filter((e) => e.startsWith('put-wait:')).length).toBeGreaterThan(0);
      });
      expect(await getRoomCacheGeneration(kv, ROOM_A)).toBe(0);
      releasePut(genKey(ROOM_A));
      expect(await bumpP).toBe(1);
      expect(await getRoomCacheGeneration(kv, ROOM_A)).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`dual bump collapse then sequential bump reaches 2 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[genKey(ROOM_A), 2]],
      });
      const [a, b] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_A),
      ]);
      expect(new Set([a, b])).toEqual(new Set([1]));
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(await bumpRoomCacheGeneration(kv, ROOM_A)).toBe(2);
      expect(ctl.data[genKey(ROOM_A)]).toBe('2');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`bump∥invalidateBatch: gen moves, meta dropped flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Drop' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'Keep' })),
        },
      });
      const [gen] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        invalidateBatchRoomCache(kv, [ROOM_A]),
      ]);
      expect(gen).toBe(1);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(ctl.data[metaKey(ROOM_B)]).toBeDefined();
    });
  }
});

describe('race residual overlapping invalidateBatch after #232', () => {
  for (let i = 0; i < 8; i++) {
    it(`overlapping A,B ∥ B,C deletes union flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'A' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'B' })),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'C' })),
          [metaKey(ROOM_D)]: JSON.stringify(freshMeta({ name: 'D' })),
        },
      });
      await Promise.all([
        invalidateBatchRoomCache(kv, [ROOM_A, ROOM_B]),
        invalidateBatchRoomCache(kv, [ROOM_B, ROOM_C]),
      ]);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_C)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_D)]).toBeDefined();
      expect(ctl.deleteCount.get(metaKey(ROOM_B))).toBe(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`empty batch invalidate∥populated is no-op isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Stay' })) },
      });
      await Promise.all([
        invalidateBatchRoomCache(kv, []),
        invalidateBatchRoomCache(kv, [ROOM_B]),
      ]);
      expect(ctl.data[metaKey(ROOM_A)]).toBeDefined();
      expect(ctl.deleteCount.get(metaKey(ROOM_B)) ?? 0).toBe(1);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`invalidate missing keys ∥ hot get isolation flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Hot' })) },
      });
      const db = mockDb({});
      const [hit] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        invalidateRoomCache(kv, ROOM_C),
        invalidateBatchRoomCache(kv, [ROOM_D, ROOM_B]),
      ]);
      expect(hit).toMatchObject({ name: 'Hot' });
      expect(db.batchCalls).toBe(0);
    });
  }
});

describe('race residual KV json parse + expirationTtl after #232', () => {
  for (let i = 0; i < 8; i++) {
    it(`json parse throw on A falls to D1∥B hits flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: '{not-json',
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HitB' })),
        },
        jsonThrows: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'Recovered', joined: 2, invited: 0 } });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(a).toMatchObject({ name: 'Recovered' });
      expect(b).toMatchObject({ name: 'HitB' });
      expect(db.roomsSeen).toEqual([ROOM_A]);
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('Recovered');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`malformed stored json without jsonThrows still D1 via JSON.parse flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: { [metaKey(ROOM_A)]: '{broken' },
      });
      const db = mockDb({ [ROOM_A]: { name: 'FromParse', joined: 1, invited: 0 } });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_A),
      ]);
      expect(a).toMatchObject({ name: 'FromParse' });
      expect(b).toBe(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`concurrent miss puts pin expirationTtl=${TTL_SECONDS} flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'A', joined: 1, invited: 0 },
        [ROOM_B]: { name: 'B', joined: 1, invited: 0 },
      });
      await Promise.all([getRoomMetadata(kv, db, ROOM_A), getRoomMetadata(kv, db, ROOM_B)]);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
      expect(ctl.putTtl.get(metaKey(ROOM_B))).toBe(TTL_SECONDS);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`generation put has no expirationTtl∥meta put does flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      const db = mockDb({ [ROOM_A]: { name: 'X', joined: 1, invited: 0 } });
      await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_A),
      ]);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
      expect(ctl.putTtl.get(genKey(ROOM_A))).toBeUndefined();
    });
  }
});

describe('race residual never-null miss + invited/isDm leftovers after #232', () => {
  for (let i = 0; i < 8; i++) {
    it(`unknown rooms still return metadata objects under miss stampede flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[metaKey(ROOM_A), 2]],
      });
      const db = mockDb({});
      const [left, right] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_A),
      ]);
      expect(left).toMatchObject({ joinedCount: 0, invitedCount: 0, isDm: true, name: undefined });
      expect(right).toMatchObject({ joinedCount: 0, isDm: true });
      expect(left).not.toBeNull();
      expect(db.batchCalls).toBe(2);
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).isDm).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`invited-only unnamed isDm∥named non-DM isolation flood-${i}`, async () => {
      const { kv } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: { joined: 0, invited: 5 },
        [ROOM_B]: { name: 'Public', joined: 0, invited: 5 },
        [ROOM_C]: { joined: 2, invited: 2 },
        [ROOM_D]: { name: 'Lobby', joined: 2, invited: 2 },
      });
      const [a, b, c, d] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
        getRoomMetadata(kv, db, ROOM_D),
      ]);
      expect(a).toMatchObject({ invitedCount: 5, isDm: true });
      expect(b).toMatchObject({ name: 'Public', isDm: false });
      expect(c).toMatchObject({ joinedCount: 2, invitedCount: 2, isDm: true });
      expect(d).toMatchObject({ isDm: false });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`batch mix hot/stale/missing isolation flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Hot' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'Stale', cachedAt: NOW - TTL_MS })),
        },
      });
      const db = mockDb({
        [ROOM_B]: { name: 'Bdb', joined: 1, invited: 0 },
        [ROOM_C]: { name: 'Cdb', joined: 2, invited: 0 },
      });
      const map = await getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B, ROOM_C]);
      expect(map.get(ROOM_A)).toMatchObject({ name: 'Hot' });
      expect(map.get(ROOM_B)).toMatchObject({ name: 'Bdb' });
      expect(map.get(ROOM_C)).toMatchObject({ name: 'Cdb' });
      expect(new Set(db.roomsSeen)).toEqual(new Set([ROOM_B, ROOM_C]));
    });
  }
});

describe('race residual SQL bind leftover after #232', () => {
  it('duplicate-id batch binds the same room_id twice', async () => {
    const { kv } = createRacingKv();
    const db = mockDb({ [ROOM_A]: { name: 'Bind', joined: 1, invited: 0 } });
    await getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_A]);
    expect(db.roomsSeen).toEqual([ROOM_A, ROOM_A]);
  });

  it('cross-room miss stampede never cross-binds', async () => {
    const { kv } = createRacingKv({
      getBarrier: [
        [metaKey(ROOM_A), 1],
        [metaKey(ROOM_B), 1],
      ],
    });
    const db = mockDb({
      [ROOM_A]: { name: 'A', joined: 1, invited: 0 },
      [ROOM_B]: { name: 'B', joined: 1, invited: 0 },
    });
    await Promise.all([getRoomMetadata(kv, db, ROOM_A), getRoomMetadata(kv, db, ROOM_B)]);
    expect(new Set(db.roomsSeen)).toEqual(new Set([ROOM_A, ROOM_B]));
    expect(db.roomsSeen).toHaveLength(2);
  });
});
