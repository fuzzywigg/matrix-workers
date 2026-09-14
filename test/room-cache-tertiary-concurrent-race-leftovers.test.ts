/**
 * TOKENMAXX HEAVY leftovers after #241 — tertiary room-cache *concurrent
 * race / TOCTOU* niches not covered by #232 (first-wave Promise.all) or
 * #240 (residual parseInt/TTL/batch-put-hold).
 *
 * Tertiary focus (existing `src/services/room-cache.ts` only):
 *   - put-barrier dual bump collapse (sibling of get-barrier collapse)
 *   - rooms.ts writer order: bump-then-invalidate ∥ concurrent miss get
 *   - delete-hold invalidate vs concurrent get hit/refill
 *   - cachedAt null / epoch-0 / object / boolean / -1 / numeric-string TTL under Promise.all
 *   - parseInt tertiary matrix (decimal/tab/0xGG/1_000/++1/5./2e1/-Infinity)
 *   - batch miss puts pin expirationTtl=300; invalidateBatch duplicate ids
 *   - malformed DB field JSON + missing count rows under parallel miss
 *   - getRoomCacheGeneration get-throw∥sibling; miss put-hold stampede
 *   - empty-object state content → undefined fields; SQL batch length pin
 *
 * Distinct from tip #241 (devices+keybackups) and #240 (residual room-cache).
 * Tests-only. example.com fixtures. Reversible by deleting this file.
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
  joined?: number;
  invited?: number;
  /** Raw content strings override JSON-encoded fields (malformed / empty). */
  rawNameContent?: string | null;
  rawAvatarContent?: string | null;
  rawTopicContent?: string | null;
  rawAliasContent?: string | null;
  /** When true, count query returns empty results (defaults to 0). */
  missingJoined?: boolean;
  missingInvited?: boolean;
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
  deleteBarrier: Map<string, Barrier>;
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
    getBarrier?: Array<[string, number]>;
    putBarrier?: Array<[string, number]>;
    deleteBarrier?: Array<[string, number]>;
    getHold?: string[];
    putHold?: string[];
    deleteHold?: string[];
  } = {}
): {
  kv: KVNamespace;
  ctl: KvCtl;
  releaseGet: (key: string) => void;
  releasePut: (key: string) => void;
  releaseDelete: (key: string) => void;
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
    deleteBarrier: new Map([
      ...(opts.deleteBarrier ?? []).map(
        ([key, count]) => [key, { remaining: count, waiters: [] as Array<() => void> }] as const
      ),
      ...(opts.deleteHold ?? []).map(
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
      await waitBarrier(ctl.deleteBarrier, key, ctl.events, 'delete');
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
    releaseDelete: (key: string) => releaseBarrier(ctl.deleteBarrier, key, ctl.events, 'delete'),
  };
}

function contentResult(raw: string | null | undefined, fallbackObj: unknown): { results: unknown[] } {
  if (raw === null) return { results: [] };
  if (raw !== undefined) return { results: [{ content: raw }] };
  if (fallbackObj === undefined || fallbackObj === null) return { results: [] };
  return { results: [{ content: JSON.stringify(fallbackObj) }] };
}

function mockDb(
  rooms: Record<string, RoomSpec>,
  stmtCounts?: number[]
): D1Database & {
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
      stmtCounts?.push(stmts.length);
      const roomId = stmts[0]?._roomId ?? '';
      state.roomsSeen.push(roomId);
      const spec = rooms[roomId] ?? {};
      return [
        contentResult(
          spec.rawNameContent,
          spec.name !== undefined ? { name: spec.name } : null
        ),
        contentResult(
          spec.rawAvatarContent,
          spec.avatar !== undefined ? { url: spec.avatar } : null
        ),
        contentResult(
          spec.rawTopicContent,
          spec.topic !== undefined ? { topic: spec.topic } : null
        ),
        contentResult(
          spec.rawAliasContent,
          spec.alias !== undefined ? { alias: spec.alias } : null
        ),
        {
          results: spec.missingJoined
            ? []
            : [{ count: spec.joined ?? 0 }],
        },
        {
          results: spec.missingInvited
            ? []
            : [{ count: spec.invited ?? 0 }],
        },
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
// put-barrier dual bump collapse (unsaturated sibling of get-barrier)
// ---------------------------------------------------------------------------

describe('race tertiary put-barrier bump∥bump collapse after #241', () => {
  for (let i = 0; i < 12; i++) {
    it(`same-room dual bump put-barrier collapses to 1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        putBarrier: [[genKey(ROOM_A), 2]],
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

  for (let i = 0; i < 8; i++) {
    it(`A∥B put-barrier bump isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [genKey(ROOM_A)]: '2', [genKey(ROOM_B)]: '8' },
        putBarrier: [
          [genKey(ROOM_A), 1],
          [genKey(ROOM_B), 1],
        ],
      });
      const [a, b] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
      ]);
      expect(a).toBe(3);
      expect(b).toBe(9);
      expect(ctl.data[genKey(ROOM_A)]).toBe('3');
      expect(ctl.data[genKey(ROOM_B)]).toBe('9');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`four-way put-barrier same-room collapse flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [genKey(ROOM_C)]: '5' },
        putBarrier: [[genKey(ROOM_C), 4]],
      });
      const results = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_C),
        bumpRoomCacheGeneration(kv, ROOM_C),
        bumpRoomCacheGeneration(kv, ROOM_C),
        bumpRoomCacheGeneration(kv, ROOM_C),
      ]);
      expect(new Set(results)).toEqual(new Set([6]));
      expect(ctl.data[genKey(ROOM_C)]).toBe('6');
    });
  }
});

// ---------------------------------------------------------------------------
// rooms.ts writer order: bump-then-invalidate ∥ concurrent reader
// ---------------------------------------------------------------------------

describe('race tertiary bump-then-invalidate writer∥reader after #241', () => {
  for (let i = 0; i < 10; i++) {
    it(`writer bump→invalidate while get held → miss refill flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Stale' })) },
        getHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'Fresh', joined: 4, invited: 0 } });

      const readP = getRoomMetadata(kv, db, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.filter((e) => e.startsWith('get-wait:')).length).toBeGreaterThan(0);
      });

      const gen = await bumpRoomCacheGeneration(kv, ROOM_A);
      await invalidateRoomCache(kv, ROOM_A);
      releaseGet(metaKey(ROOM_A));
      const meta = await readP;

      expect(gen).toBe(1);
      expect(meta).toMatchObject({ name: 'Fresh', joinedCount: 4 });
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('Fresh');
      expect(db.batchCalls).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`dual writers bump→invalidate same room gen≥1 meta gone-or-refilled flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Old' })) },
        getBarrier: [[genKey(ROOM_A), 2]],
      });
      const write = async () => {
        await bumpRoomCacheGeneration(kv, ROOM_A);
        await invalidateRoomCache(kv, ROOM_A);
      };
      await Promise.all([write(), write()]);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(Number(ctl.data[genKey(ROOM_A)])).toBeGreaterThanOrEqual(1);
      expect(ctl.deleteCount.get(metaKey(ROOM_A))).toBe(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`bump→invalidate A∥hot get B isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Drop' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'Keep' })),
        },
      });
      const db = mockDb({});
      const [hit] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_B),
        (async () => {
          await bumpRoomCacheGeneration(kv, ROOM_A);
          await invalidateRoomCache(kv, ROOM_A);
        })(),
      ]);
      expect(hit).toMatchObject({ name: 'Keep' });
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeDefined();
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(db.batchCalls).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// delete-hold invalidate vs concurrent get
// ---------------------------------------------------------------------------

describe('race tertiary delete-hold invalidate∥get after #241', () => {
  for (let i = 0; i < 10; i++) {
    it(`delete-hold: get still hits until delete releases flood-${i}`, async () => {
      const { kv, ctl, releaseDelete } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StillThere' })) },
        deleteHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'ShouldNotFetch', joined: 99, invited: 0 } });

      const delP = invalidateRoomCache(kv, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.filter((e) => e.startsWith('delete-wait:')).length).toBeGreaterThan(0);
      });
      const hit = await getRoomMetadata(kv, db, ROOM_A);
      expect(hit).toMatchObject({ name: 'StillThere' });
      expect(db.batchCalls).toBe(0);

      releaseDelete(metaKey(ROOM_A));
      await delP;
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`delete-hold then release: subsequent get refills flood-${i}`, async () => {
      const { kv, ctl, releaseDelete } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Gone' })) },
        deleteHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'Refilled', joined: 2, invited: 0 } });
      const delP = invalidateRoomCache(kv, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.startsWith('delete-wait:'))).toBe(true);
      });
      releaseDelete(metaKey(ROOM_A));
      await delP;
      const meta = await getRoomMetadata(kv, db, ROOM_A);
      expect(meta).toMatchObject({ name: 'Refilled', joinedCount: 2 });
      expect(db.batchCalls).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`dual delete-barrier invalidate∥invalidate idempotent flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta()) },
        deleteBarrier: [[metaKey(ROOM_A), 2]],
      });
      await Promise.all([
        invalidateRoomCache(kv, ROOM_A),
        invalidateRoomCache(kv, ROOM_A),
      ]);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.deleteCount.get(metaKey(ROOM_A))).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// cachedAt null / Infinity / -Infinity / string TTL leftovers
// ---------------------------------------------------------------------------

describe('race tertiary cachedAt type TTL leftovers after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`null cachedAt miss∥sibling hot hit flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify({
            name: 'NullClock',
            joinedCount: 1,
            invitedCount: 0,
            isDm: true,
            cachedAt: null,
          }),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HotB' })),
        },
      });
      const db = mockDb({ [ROOM_A]: { name: 'A2', joined: 2, invited: 0 } });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(a).toMatchObject({ name: 'A2' });
      expect(b).toMatchObject({ name: 'HotB' });
      expect(db.roomsSeen).toEqual([ROOM_A]);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`epoch-0 cachedAt miss∥object cachedAt miss∥hot sibling flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(
            freshMeta({ name: 'Epoch', cachedAt: 0 })
          ),
          [metaKey(ROOM_B)]: JSON.stringify({
            name: 'ObjClock',
            joinedCount: 1,
            invitedCount: 0,
            isDm: true,
            cachedAt: {},
          }),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'HotC' })),
        },
      });
      const db = mockDb({
        [ROOM_A]: { name: 'A2', joined: 1, invited: 0 },
        [ROOM_B]: { name: 'B2', joined: 1, invited: 0 },
      });
      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);
      // epoch 0 → age ≈ NOW → miss; object cachedAt → NaN age → miss.
      expect(a).toMatchObject({ name: 'A2' });
      expect(b).toMatchObject({ name: 'B2' });
      expect(c).toMatchObject({ name: 'HotC' });
      expect(new Set(db.roomsSeen)).toEqual(new Set([ROOM_A, ROOM_B]));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`boolean cachedAt miss∥-1 cachedAt miss isolation flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify({
            name: 'BoolClock',
            joinedCount: 1,
            invitedCount: 0,
            isDm: true,
            cachedAt: true,
          }),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'NegOne', cachedAt: -1 })),
        },
      });
      const db = mockDb({
        [ROOM_A]: { name: 'Adb', joined: 1, invited: 0 },
        [ROOM_B]: { name: 'Bdb', joined: 1, invited: 0 },
      });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(a).toMatchObject({ name: 'Adb' });
      expect(b).toMatchObject({ name: 'Bdb' });
      expect(new Set(db.roomsSeen)).toEqual(new Set([ROOM_A, ROOM_B]));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`numeric-string cachedAt coerces to hit∥exact-stale miss flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify({
            name: 'StrClock',
            joinedCount: 2,
            invitedCount: 0,
            isDm: false,
            cachedAt: String(NOW),
          }),
          [metaKey(ROOM_B)]: JSON.stringify(
            freshMeta({ name: 'Stale', cachedAt: NOW - TTL_MS })
          ),
        },
      });
      const db = mockDb({ [ROOM_B]: { name: 'B2', joined: 1, invited: 0 } });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      // String cachedAt: NOW - "1700..." → numeric coercion → age 0 → hit.
      expect(a).toMatchObject({ name: 'StrClock' });
      expect(b).toMatchObject({ name: 'B2' });
      expect(db.roomsSeen).toEqual([ROOM_B]);
    });
  }
});

// ---------------------------------------------------------------------------
// parseInt tertiary matrix
// ---------------------------------------------------------------------------

describe('race tertiary parseInt generation matrix after #241', () => {
  const cases: Array<[string, string, number, number]> = [
    ['3.7', ROOM_A, 3, 4],
    ['\t5', ROOM_B, 5, 6],
    ['0xGG', ROOM_C, 0, 1],
    ['1_000', ROOM_D, 1, 2],
  ];

  for (let i = 0; i < 8; i++) {
    it(`decimal/tab/0xGG/underscore get∥bump matrix flood-${i}`, async () => {
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
    it(`++1 / 5. / 2e1 / -Infinity concurrent bump flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '++1',
          [genKey(ROOM_B)]: '5.',
          [genKey(ROOM_C)]: '2e1',
          [genKey(ROOM_D)]: '-Infinity',
        },
      });
      const [a, b, c, d] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
        bumpRoomCacheGeneration(kv, ROOM_C),
        bumpRoomCacheGeneration(kv, ROOM_D),
      ]);
      expect(a).toBe(1); // NaN → 0 → 1
      expect(b).toBe(6); // parseInt('5.') → 5 → 6
      expect(c).toBe(3); // parseInt('2e1') → 2 → 3
      expect(d).toBe(1); // NaN → 0 → 1
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(ctl.data[genKey(ROOM_B)]).toBe('6');
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`space-only / plus / minus / .5 concurrent get→0 flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: ' ',
          [genKey(ROOM_B)]: '+',
          [genKey(ROOM_C)]: '-',
          [genKey(ROOM_D)]: '.5',
        },
      });
      const gens = await Promise.all([
        getRoomCacheGeneration(kv, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_B),
        getRoomCacheGeneration(kv, ROOM_C),
        getRoomCacheGeneration(kv, ROOM_D),
      ]);
      expect(gens).toEqual([0, 0, 0, 0]);
    });
  }
});

// ---------------------------------------------------------------------------
// batch expirationTtl + invalidateBatch duplicates
// ---------------------------------------------------------------------------

describe('race tertiary batch TTL pin + duplicate invalidate after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`batch miss puts pin expirationTtl=${TTL_SECONDS} flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: { name: 'A', joined: 1, invited: 0 },
        [ROOM_B]: { name: 'B', joined: 1, invited: 0 },
      });
      await getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]);
      await vi.waitFor(() => {
        expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
        expect(ctl.putTtl.get(metaKey(ROOM_B))).toBe(TTL_SECONDS);
      });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`invalidateBatch duplicate roomIds double-deletes flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Dup' })) },
      });
      await Promise.all([
        invalidateBatchRoomCache(kv, [ROOM_A, ROOM_A, ROOM_A]),
        invalidateBatchRoomCache(kv, [ROOM_A]),
      ]);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.deleteCount.get(metaKey(ROOM_A))).toBe(4);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`batch put TTL∥generation put no-TTL under parallel flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      const db = mockDb({ [ROOM_A]: { name: 'X', joined: 1, invited: 0 } });
      await Promise.all([
        getBatchRoomMetadata(kv, db, [ROOM_A]),
        bumpRoomCacheGeneration(kv, ROOM_A),
      ]);
      await vi.waitFor(() => {
        expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
      });
      expect(ctl.putTtl.get(genKey(ROOM_A))).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// malformed DB fields + missing counts under parallel miss
// ---------------------------------------------------------------------------

describe('race tertiary DB field parse + missing counts after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`malformed name/avatar/topic/alias isolate under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: { rawNameContent: '{bad', joined: 1, invited: 0 },
        [ROOM_B]: { rawAvatarContent: '{bad', joined: 1, invited: 0 },
        [ROOM_C]: { rawTopicContent: '{}', joined: 2, invited: 0 },
        [ROOM_D]: { rawAliasContent: JSON.stringify({ notAlias: true }), joined: 1, invited: 0 },
      });
      const [a, b, c, d] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
        getRoomMetadata(kv, db, ROOM_D),
      ]);
      expect(a).toMatchObject({ name: undefined, joinedCount: 1, isDm: true });
      expect(b).toMatchObject({ avatar: undefined, isDm: true });
      expect(c).toMatchObject({ topic: undefined, joinedCount: 2, isDm: true });
      expect(d).toMatchObject({ canonicalAlias: undefined, isDm: true });
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBeUndefined();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`missing count rows default to 0 under concurrent miss flood-${i}`, async () => {
      const { kv } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: { name: 'A', missingJoined: true, missingInvited: true },
        [ROOM_B]: { name: 'B', joined: 3, missingInvited: true },
        [ROOM_C]: { missingJoined: true, invited: 4 },
      });
      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);
      expect(a).toMatchObject({ joinedCount: 0, invitedCount: 0, name: 'A', isDm: false });
      expect(b).toMatchObject({ joinedCount: 3, invitedCount: 0, isDm: false });
      expect(c).toMatchObject({ joinedCount: 0, invitedCount: 4, isDm: true });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`empty-object state content → undefined fields flood-${i}`, async () => {
      const { kv } = createRacingKv({
        getBarrier: [[metaKey(ROOM_A), 2]],
      });
      const db = mockDb({
        [ROOM_A]: {
          rawNameContent: '{}',
          rawAvatarContent: '{}',
          rawTopicContent: '{}',
          rawAliasContent: '{}',
          joined: 1,
          invited: 0,
        },
      });
      const [left, right] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_A),
      ]);
      for (const meta of [left, right]) {
        expect(meta).toMatchObject({
          name: undefined,
          avatar: undefined,
          topic: undefined,
          canonicalAlias: undefined,
          joinedCount: 1,
          isDm: true,
        });
      }
      expect(db.batchCalls).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// get-throw generation + miss put-hold stampede
// ---------------------------------------------------------------------------

describe('race tertiary generation get-throw + miss put-hold after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`getRoomCacheGeneration get-throw→0∥sibling seeded flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: { [genKey(ROOM_B)]: '9' },
        getThrows: [genKey(ROOM_A)],
      });
      const [a, b] = await Promise.all([
        getRoomCacheGeneration(kv, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_B),
      ]);
      expect(a).toBe(0);
      expect(b).toBe(9);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`miss put-hold: second get also misses until put releases flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'Held', joined: 2, invited: 0 } });

      const firstP = getRoomMetadata(kv, db, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.filter((e) => e.startsWith('put-wait:')).length).toBeGreaterThan(0);
      });
      // Put not committed yet — second reader also misses, fetches D1, and parks on put.
      const secondP = getRoomMetadata(kv, db, ROOM_A);
      await vi.waitFor(() => {
        expect(db.batchCalls).toBe(2);
        expect(ctl.events.filter((e) => e.startsWith('put-wait:')).length).toBe(2);
      });
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();

      releasePut(metaKey(ROOM_A));
      const [first, second] = await Promise.all([firstP, secondP]);
      expect(first).toMatchObject({ name: 'Held' });
      expect(second).toMatchObject({ name: 'Held' });
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('Held');
      expect(ctl.putCount.get(metaKey(ROOM_A))).toBe(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`batch miss put-hold: map returns while KV empty then hit flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [metaKey(ROOM_A), metaKey(ROOM_B)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'A', joined: 1, invited: 0 },
        [ROOM_B]: { name: 'B', joined: 1, invited: 0 },
      });
      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]);
      await vi.waitFor(() => {
        expect(ctl.events.filter((e) => e.startsWith('put-wait:')).length).toBe(2);
      });
      const map = await batchP;
      expect(map.get(ROOM_A)).toMatchObject({ name: 'A' });
      expect(map.get(ROOM_B)).toMatchObject({ name: 'B' });
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeUndefined();
      releasePut(metaKey(ROOM_A));
      releasePut(metaKey(ROOM_B));
      await vi.waitFor(() => {
        expect(ctl.data[metaKey(ROOM_A)]).toBeDefined();
        expect(ctl.data[metaKey(ROOM_B)]).toBeDefined();
      });
    });
  }
});

// ---------------------------------------------------------------------------
// SQL batch length pin + key prefix contracts under parallel
// ---------------------------------------------------------------------------

describe('race tertiary SQL batch length + key prefixes after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`each miss issues exactly 6 batched statements flood-${i}`, async () => {
      const stmtCounts: number[] = [];
      const { kv } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb(
        {
          [ROOM_A]: { name: 'A', joined: 1, invited: 0 },
          [ROOM_B]: { name: 'B', joined: 1, invited: 0 },
        },
        stmtCounts
      );
      await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(stmtCounts).toEqual([6, 6]);
      expect(db.batchCalls).toBe(2);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`meta vs gen key prefixes never collide under parallel flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      const db = mockDb({ [ROOM_A]: { name: 'P', joined: 1, invited: 0 } });
      await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_B),
        invalidateRoomCache(kv, ROOM_C),
      ]);
      const keys = Object.keys(ctl.data).sort();
      expect(keys).toEqual([genKey(ROOM_A), metaKey(ROOM_A)].sort());
      expect(keys.every((k) => k.startsWith('room-meta'))).toBe(true);
      expect(keys.some((k) => k.startsWith('room-meta-gen:'))).toBe(true);
      expect(keys.some((k) => k.startsWith('room-meta:') && !k.startsWith('room-meta-gen:'))).toBe(
        true
      );
    });
  }

  it('batch path also issues 6 statements per uncached room', async () => {
    const stmtCounts: number[] = [];
    const { kv } = createRacingKv();
    const db = mockDb(
      {
        [ROOM_A]: { name: 'A', joined: 1, invited: 0 },
        [ROOM_B]: { name: 'B', joined: 1, invited: 0 },
      },
      stmtCounts
    );
    await getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]);
    expect(stmtCounts.sort()).toEqual([6, 6]);
  });
});
