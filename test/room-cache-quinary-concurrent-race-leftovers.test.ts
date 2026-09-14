/**
 * TOKENMAXX HEAVY leftovers after #263/#266 — quinary room-cache
 * *concurrent race / TOCTOU* niches not covered by #232 / #240 / #246
 * tertiary / #251 second-wave / #263 quaternary.
 *
 * Quinary focus (existing `src/services/room-cache.ts` only):
 *   - TTL ±1ms boundary under Promise.all (fresh-by-1 hit ∥ stale-by-1 miss)
 *   - joinedRaw 0 / invitedRaw null / false count coercions under parallel miss
 *   - empty `{}` name content + empty-string avatar url under concurrent miss
 *   - nested-object name truthy → isDm=false ∥ unnamed sibling
 *   - KV json overlay non-object (array/number/string) → miss refill
 *   - generation `"NaN"` / `"+0"` get∥bump parse leftovers
 *   - deleteThrows invalidate swallow ∥ bump still advances
 *   - putThrows meta stampede swallow ∥ sibling room put succeeds
 *   - overlapping invalidateBatch A,B ∥ B,C partial isolation
 *   - all-hot batch ∥ bump gen mid get-barrier (no D1)
 *   - gen getThrows A∥B isolation returns 0
 *   - duplicate-id batch A,A ∥ invalidate A mid get-barrier
 *
 * Hibernation concurrent leftovers live in call-room-hibernation.test.ts
 * and room-durable-object.test.ts (same PR). Tests-only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file
 * and the hibernation quinary describes.
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
  rawNameContent?: string | null;
  rawAvatarContent?: string | null;
  rawTopicContent?: string | null;
  rawAliasContent?: string | null;
  joinedRaw?: unknown;
  invitedRaw?: unknown;
  throwBatch?: boolean;
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
    /** Pre-parsed JSON get overlay (array/number/string shapes that JSON.parse cannot pin). */
    jsonOverlay?: Record<string, unknown>;
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
  const jsonOverlay = opts.jsonOverlay ?? {};
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
      if (type === 'json' && Object.prototype.hasOwnProperty.call(jsonOverlay, key)) {
        return jsonOverlay[key];
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
  if (raw === null) return { results: [{ content: null }] };
  if (raw !== undefined) return { results: [{ content: raw }] };
  if (fallbackObj === undefined || fallbackObj === null) return { results: [] };
  return { results: [{ content: JSON.stringify(fallbackObj) }] };
}

function mockDb(
  rooms: Record<string, RoomSpec>
): D1Database & {
  batchCalls: number;
  roomsSeen: string[];
  batchErrors: string[];
} {
  const state = {
    batchCalls: 0,
    roomsSeen: [] as string[],
    batchErrors: [] as string[],
  };
  const db = {
    get batchCalls() {
      return state.batchCalls;
    },
    get roomsSeen() {
      return state.roomsSeen;
    },
    get batchErrors() {
      return state.batchErrors;
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
      const spec = rooms[roomId] ?? {};
      if (spec.throwBatch) {
        state.batchErrors.push(roomId);
        throw new Error(`d1-batch-throw:${roomId}`);
      }
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
          results: [
            {
              count:
                spec.joinedRaw !== undefined ? spec.joinedRaw : (spec.joined ?? 0),
            },
          ],
        },
        {
          results: [
            {
              count:
                spec.invitedRaw !== undefined ? spec.invitedRaw : (spec.invited ?? 0),
            },
          ],
        },
      ];
    }),
  };
  return db as unknown as D1Database & {
    batchCalls: number;
    roomsSeen: string[];
    batchErrors: string[];
  };
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
// TTL ±1ms boundary under concurrent get
// ---------------------------------------------------------------------------

describe('race quinary TTL ±1ms boundary concurrent after #263', () => {
  for (let i = 0; i < 8; i++) {
    it(`fresh-by-1 hit∥stale-by-1 miss∥exact-stale miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(
            freshMeta({ name: 'Fresh1', cachedAt: NOW - TTL_MS + 1 })
          ),
          [metaKey(ROOM_B)]: JSON.stringify(
            freshMeta({ name: 'Stale1', cachedAt: NOW - TTL_MS - 1 })
          ),
          [metaKey(ROOM_C)]: JSON.stringify(
            freshMeta({ name: 'Exact', cachedAt: NOW - TTL_MS })
          ),
        },
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_B]: { name: 'RefillB', joined: 2 },
        [ROOM_C]: { name: 'RefillC', joined: 2 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // age < TTL → hit; age > TTL and age === TTL → miss (strict <)
      expect(a?.name).toBe('Fresh1');
      expect(b?.name).toBe('RefillB');
      expect(c?.name).toBe('RefillC');
      expect(db.batchCalls).toBe(2);
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(0);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`batch TTL ±1 same pins flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(
            freshMeta({ name: 'Hot', cachedAt: NOW - TTL_MS + 1 })
          ),
          [metaKey(ROOM_B)]: JSON.stringify(
            freshMeta({ name: 'Cold', cachedAt: NOW - TTL_MS - 1 })
          ),
        },
      });
      const db = mockDb({ [ROOM_B]: { name: 'B2', joined: 1 } });

      const batch = await getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]);
      expect(batch.get(ROOM_A)?.name).toBe('Hot');
      expect(batch.get(ROOM_B)?.name).toBe('B2');
      expect(db.batchCalls).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Count coercions: 0 / null / false
// ---------------------------------------------------------------------------

describe('race quinary count 0/null/false coercions after #263', () => {
  for (let i = 0; i < 8; i++) {
    it(`joinedRaw 0∥invitedRaw null∥false under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: 0, invitedRaw: 2 },
        [ROOM_B]: { joinedRaw: 3, invitedRaw: null },
        [ROOM_C]: { joinedRaw: false, invitedRaw: false },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // `|| 0` collapses falsy raw counts
      expect(a?.joinedCount).toBe(0);
      expect(a?.invitedCount).toBe(2);
      expect(a?.isDm).toBe(true); // joined<=2 && !name
      expect(b?.joinedCount).toBe(3);
      expect(b?.invitedCount).toBe(0); // null || 0
      expect(c?.joinedCount).toBe(0); // false || 0
      expect(c?.invitedCount).toBe(0);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// Empty {} name + empty avatar url; nested-object name isDm
// ---------------------------------------------------------------------------

describe('race quinary empty/nested name field leftovers after #263', () => {
  for (let i = 0; i < 8; i++) {
    it(`{} name∥empty avatar url∥nested name isDm flood-${i}`, async () => {
      const { kv } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: {
          rawNameContent: JSON.stringify({}),
          joined: 2,
          invited: 0,
        },
        [ROOM_B]: {
          rawAvatarContent: JSON.stringify({ url: '' }),
          joined: 1,
        },
        [ROOM_C]: {
          rawNameContent: JSON.stringify({ name: { nested: true } }),
          joined: 2,
        },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      expect(a?.name).toBeUndefined();
      expect(a?.isDm).toBe(true);
      expect(b?.avatar).toBe('');
      expect(b?.isDm).toBe(true);
      // nested object is truthy → !name is false → non-DM
      expect(c?.name).toEqual({ nested: true });
      expect(c?.isDm).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Non-object KV json overlay → miss refill
// ---------------------------------------------------------------------------

describe('race quinary non-object KV json overlay miss after #263', () => {
  for (let i = 0; i < 8; i++) {
    it(`array∥number∥string overlay → D1 refill isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        jsonOverlay: {
          [metaKey(ROOM_A)]: [{ name: 'Arr' }],
          [metaKey(ROOM_B)]: 42,
          [metaKey(ROOM_C)]: 'hot-string',
        },
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'A2', joined: 2 },
        [ROOM_B]: { name: 'B2', joined: 2 },
        [ROOM_C]: { name: 'C2', joined: 2 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // cached.cachedAt on non-objects → NaN age → miss
      expect(a?.name).toBe('A2');
      expect(b?.name).toBe('B2');
      expect(c?.name).toBe('C2');
      expect(db.batchCalls).toBe(3);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Generation NaN / +0 parse leftovers
// ---------------------------------------------------------------------------

describe('race quinary generation NaN/+0 parse concurrent after #263', () => {
  for (let i = 0; i < 8; i++) {
    it(`NaN-string get→0∥bump writes 1; +0 bump→1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: 'NaN',
          [genKey(ROOM_B)]: '+0',
        },
        getBarrier: [
          [genKey(ROOM_A), 2],
          [genKey(ROOM_B), 1],
        ],
      });

      const [g0, bumpedA, bumpedB] = await Promise.all([
        getRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
      ]);

      // parseInt('NaN') → NaN → 0; parseInt('+0') → 0
      expect(g0).toBe(0);
      expect(bumpedA).toBe(1);
      expect(bumpedB).toBe(1);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(ctl.data[genKey(ROOM_B)]).toBe('1');
    });
  }
});

// ---------------------------------------------------------------------------
// deleteThrows invalidate swallow ∥ bump
// ---------------------------------------------------------------------------

describe('race quinary deleteThrows invalidate∥bump after #263', () => {
  for (let i = 0; i < 8; i++) {
    it(`invalidate delete-throw swallowed∥bump advances flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Keep' })),
        },
        deleteThrows: [metaKey(ROOM_A)],
      });

      await Promise.all([
        invalidateRoomCache(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_A),
      ]);

      // delete threw → meta still present; gen still moved
      expect(ctl.data[metaKey(ROOM_A)]).toBeDefined();
      expect(await getRoomCacheGeneration(kv, ROOM_A)).toBe(1);
      expect(ctl.deleteCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`invalidateBatch delete-throw A∥clean B flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'A' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'B' })),
        },
        deleteThrows: [metaKey(ROOM_A)],
      });

      await invalidateBatchRoomCache(kv, [ROOM_A, ROOM_B]);
      expect(ctl.data[metaKey(ROOM_A)]).toBeDefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// putThrows meta stampede ∥ sibling success
// ---------------------------------------------------------------------------

describe('race quinary putThrows meta stampede isolation after #263', () => {
  for (let i = 0; i < 8; i++) {
    it(`A put-throw miss still returns meta∥B put ok flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        putThrows: [metaKey(ROOM_A)],
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'NoPut', joined: 2 },
        [ROOM_B]: { name: 'PutOk', joined: 3 },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // put failure is non-critical — metadata still returned
      expect(a?.name).toBe('NoPut');
      expect(b?.name).toBe('PutOk');
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeDefined();
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Overlapping invalidateBatch + all-hot batch∥bump
// ---------------------------------------------------------------------------

describe('race quinary overlapping invalidate + hot batch∥bump after #263', () => {
  for (let i = 0; i < 8; i++) {
    it(`invalidateBatch A,B∥B,C leaves D hot flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'A' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'B' })),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'C' })),
          [metaKey(ROOM_D)]: JSON.stringify(freshMeta({ name: 'D' })),
        },
        deleteBarrier: [
          [metaKey(ROOM_B), 2],
        ],
      });

      await Promise.all([
        invalidateBatchRoomCache(kv, [ROOM_A, ROOM_B]),
        invalidateBatchRoomCache(kv, [ROOM_B, ROOM_C]),
      ]);

      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_C)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_D)]).toBeDefined();
      expect(ctl.deleteCount.get(metaKey(ROOM_B)) ?? 0).toBe(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`all-hot batch∥bump A mid get-barrier no D1 flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'HotA' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HotB' })),
        },
        getHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({});

      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${metaKey(ROOM_A)}`))).toBe(
          true
        );
      });

      const gen = await bumpRoomCacheGeneration(kv, ROOM_A);
      expect(gen).toBe(1);
      releaseGet(metaKey(ROOM_A));

      const batch = await batchP;
      expect(batch.get(ROOM_A)?.name).toBe('HotA');
      expect(batch.get(ROOM_B)?.name).toBe('HotB');
      expect(db.batchCalls).toBe(0);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
    });
  }
});

// ---------------------------------------------------------------------------
// gen getThrows isolation + duplicate-id batch∥invalidate
// ---------------------------------------------------------------------------

describe('race quinary gen getThrows + dup-id batch leftovers after #263', () => {
  for (let i = 0; i < 8; i++) {
    it(`gen getThrows A→0∥B readable isolation flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '7',
          [genKey(ROOM_B)]: '3',
        },
        getThrows: [genKey(ROOM_A)],
        getBarrier: [
          [genKey(ROOM_A), 1],
          [genKey(ROOM_B), 1],
        ],
      });

      const [a, b] = await Promise.all([
        getRoomCacheGeneration(kv, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_B),
      ]);

      expect(a).toBe(0);
      expect(b).toBe(3);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`dup-id batch A,A∥invalidate mid get-barrier refill once flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Stale' })),
        },
        getHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'Fresh', joined: 4 } });

      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_A]);
      await vi.waitFor(() => {
        expect(ctl.getCount.get(metaKey(ROOM_A)) ?? 0).toBeGreaterThanOrEqual(2);
      });

      await invalidateRoomCache(kv, ROOM_A);
      releaseGet(metaKey(ROOM_A));

      const batch = await batchP;
      expect(batch.get(ROOM_A)?.name).toBe('Fresh');
      expect(batch.size).toBe(1);
      // Two parallel cache gets for same key; both miss after delete → up to 2 D1
      expect(db.batchCalls).toBeGreaterThanOrEqual(1);
      expect(db.batchCalls).toBeLessThanOrEqual(2);
      expect(db.roomsSeen.every((r) => r === ROOM_A)).toBe(true);
    });
  }
});
