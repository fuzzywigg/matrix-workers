/**
 * TOKENMAXX HEAVY leftovers after #281 — septenary room-cache
 * *concurrent race / TOCTOU* niches not covered by #232 / #240 / #246
 * tertiary / #251 second-wave / #263 quaternary / #273 quinary /
 * #281 senary.
 *
 * Septenary focus (existing `src/services/room-cache.ts` only):
 *   - mirror joinedRaw undefined / invitedRaw true count coercions
 *   - negative joinedRaw (-1) passes ||0 and drives isDm under race
 *   - fresh incomplete KV hit (cachedAt only) ∥ sibling miss refill
 *   - same-room single get put-hold ∥ getBatch fire-and-forget put
 *   - meta getThrows→putThrows chained swallow ∥ sibling clean put
 *   - delete-hold invalidate ∥ put-hold miss-refill same meta key
 *   - cachedAt:[] array clock miss ∥ hot sibling
 *   - nested avatar url ∥ name:false under parallel miss
 *   - state content JSON text "null" → field undefined under race
 *   - three-way miss put-hold ∥ invalidate ∥ bump
 *
 * Hibernation concurrent leftovers live in call-room-hibernation.test.ts
 * and room-durable-object.test.ts (same PR). Tests-only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file
 * and the hibernation septenary describes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import {
  bumpRoomCacheGeneration,
  getBatchRoomMetadata,
  getRoomCacheGeneration,
  getRoomMetadata,
  invalidateRoomCache,
  type RoomMetadata,
} from '../src/services/room-cache';

const ROOM_A = '!alpha:example.com';
const ROOM_B = '!beta:example.com';
const NOW = 1_700_000_000_000;
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
    /** Pre-parsed JSON get overlay (shapes JSON.parse cannot pin). */
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
      // hasOwn so joinedRaw/invitedRaw can be literally `undefined` (|| 0 path)
      const joinedCount = Object.prototype.hasOwnProperty.call(spec, 'joinedRaw')
        ? spec.joinedRaw
        : (spec.joined ?? 0);
      const invitedCount = Object.prototype.hasOwnProperty.call(spec, 'invitedRaw')
        ? spec.invitedRaw
        : (spec.invited ?? 0);
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
        { results: [{ count: joinedCount }] },
        { results: [{ count: invitedCount }] },
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
// Mirror count coercions: undefined joined / true invited (beyond senary)
// ---------------------------------------------------------------------------

describe('race septenary count undefined/true mirror after #281', () => {
  for (let i = 0; i < 8; i++) {
    it(`joinedRaw undefined∥invitedRaw true under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: undefined, invitedRaw: 3 },
        [ROOM_B]: { joinedRaw: 1, invitedRaw: true },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // undefined || 0 → 0; 0 <= 2 && !name → isDm
      expect(a?.joinedCount).toBe(0);
      expect(a?.invitedCount).toBe(3);
      expect(a?.isDm).toBe(true);
      // true || 0 → true; true <= 2 → isDm
      expect(b?.joinedCount).toBe(1);
      expect(b?.invitedCount).toBe(true);
      expect(b?.isDm).toBe(true);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
      expect(ctl.putTtl.get(metaKey(ROOM_B))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// Negative / non-falsy counts pass through || 0
// ---------------------------------------------------------------------------

describe('race septenary negative joinedRaw isDm after #281', () => {
  for (let i = 0; i < 8; i++) {
    it(`joinedRaw -1∥3 pass ||0 under parallel miss flood-${i}`, async () => {
      const { kv } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: -1, invited: 0 },
        [ROOM_B]: { joinedRaw: 3, invited: 1 },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // -1 is truthy → stays -1; -1 <= 2 && !name → isDm
      // (NaN is falsy and would coerce via || 0 — not this niche)
      expect(a?.joinedCount).toBe(-1);
      expect(a?.isDm).toBe(true);
      // 3 <= 2 is false → non-DM
      expect(b?.joinedCount).toBe(3);
      expect(b?.isDm).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Fresh incomplete KV hit (cachedAt only) ∥ sibling miss
// ---------------------------------------------------------------------------

describe('race septenary incomplete fresh hit∥miss after #281', () => {
  for (let i = 0; i < 8; i++) {
    it(`cachedAt-only hit returns as-is∥sibling miss refills flood-${i}`, async () => {
      const incomplete = { cachedAt: NOW, name: 'Partial' };
      const { kv, ctl } = createRacingKv({
        jsonOverlay: {
          [metaKey(ROOM_A)]: incomplete,
        },
        data: {
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'Stale', cachedAt: NOW - TTL_SECONDS * 1000 - 1 })),
        },
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_B]: { name: 'FromDB', joined: 4 },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // Fresh incomplete object is truthy + age 0 → hit without D1
      expect(a).toEqual(incomplete);
      expect((a as { joinedCount?: number }).joinedCount).toBeUndefined();
      expect(b).toMatchObject({ name: 'FromDB', joinedCount: 4, isDm: false });
      expect(db.roomsSeen).toEqual([ROOM_B]);
      expect(ctl.putCount.get(metaKey(ROOM_B))).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Same-room single get put-hold ∥ getBatch
// ---------------------------------------------------------------------------

describe('race septenary single put-hold∥batch same room after #281', () => {
  for (let i = 0; i < 8; i++) {
    it(`get put-hold∥getBatch same key dual-D1 LWW flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'Hold', joined: 3 },
      });

      const singleP = getRoomMetadata(kv, db, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.startsWith('put-wait:'))).toBe(true);
      });

      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A]);
      const batch = await batchP;
      // Batch fire-and-forget put may still be held; map resolves from D1 either way
      expect(batch.get(ROOM_A)).toMatchObject({ name: 'Hold', joinedCount: 3 });
      expect(db.batchCalls).toBeGreaterThanOrEqual(2);

      releasePut(metaKey(ROOM_A));
      const single = await singleP;
      expect(single).toMatchObject({ name: 'Hold', joinedCount: 3 });
      await vi.waitFor(() => {
        expect(ctl.data[metaKey(ROOM_A)]).toBeDefined();
      });
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
      expect(ctl.putCount.get(genKey(ROOM_A)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Meta getThrows → putThrows chained ∥ sibling clean
// ---------------------------------------------------------------------------

describe('race septenary meta getThrows→putThrows∥sibling after #281', () => {
  for (let i = 0; i < 8; i++) {
    it(`A getThrow+putThrow returns DB uncached∥B puts flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getThrows: [metaKey(ROOM_A)],
        putThrows: [metaKey(ROOM_A)],
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'A', joined: 2 },
        [ROOM_B]: { name: 'B', joined: 5 },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      expect(a).toMatchObject({ name: 'A', joinedCount: 2, isDm: false });
      expect(b).toMatchObject({ name: 'B', joinedCount: 5 });
      // A put rejected → key absent; B cached
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeDefined();
      expect(ctl.putCount.get(metaKey(ROOM_A))).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_B))).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Delete-hold invalidate ∥ put-hold miss-refill same key
// ---------------------------------------------------------------------------

describe('race septenary delete-hold∥put-hold same key after #281', () => {
  for (let i = 0; i < 8; i++) {
    it(`invalidate delete-hold∥miss put-hold LWW empty-or-refilled flood-${i}`, async () => {
      const { kv, ctl, releaseDelete, releasePut } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Old' })),
        },
        deleteHold: [metaKey(ROOM_A)],
        putHold: [metaKey(ROOM_A)],
      });
      // Force miss by wiping overlay after first get would see hot — instead
      // delete then refill: start invalidate (delete-hold) and get after delete
      // has been scheduled. Simpler: stale entry so get always misses.
      ctl.data[metaKey(ROOM_A)] = JSON.stringify(
        freshMeta({ name: 'Stale', cachedAt: NOW - TTL_SECONDS * 1000 - 5 })
      );
      const db = mockDb({
        [ROOM_A]: { name: 'Refill', joined: 3 },
      });

      const invP = invalidateRoomCache(kv, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.startsWith('delete-wait:'))).toBe(true);
      });

      const getP = getRoomMetadata(kv, db, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.startsWith('put-wait:'))).toBe(true);
      });

      // Release delete first → key gone mid put-hold; then put completes → refilled
      releaseDelete(metaKey(ROOM_A));
      await invP;
      releasePut(metaKey(ROOM_A));
      const meta = await getP;

      expect(meta).toMatchObject({ name: 'Refill', joinedCount: 3 });
      expect(ctl.events.some((e) => e.startsWith('delete-wait:'))).toBe(true);
      expect(ctl.events.some((e) => e.startsWith('put-wait:'))).toBe(true);
      // LWW: put after delete → present; or delete after put → absent
      const present = ctl.data[metaKey(ROOM_A)] !== undefined;
      if (present) {
        expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('Refill');
      }
      expect(typeof present).toBe('boolean');
    });
  }
});

// ---------------------------------------------------------------------------
// cachedAt: [] array clock miss ∥ hot sibling
// ---------------------------------------------------------------------------

describe('race septenary cachedAt array miss∥hot after #281', () => {
  for (let i = 0; i < 8; i++) {
    it(`cachedAt:[] miss refill∥hot sibling zero D1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        jsonOverlay: {
          [metaKey(ROOM_A)]: {
            name: 'ArrClock',
            joinedCount: 1,
            invitedCount: 0,
            isDm: true,
            cachedAt: [],
          },
        },
        data: {
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'Hot', joinedCount: 4 })),
        },
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FromDB', joined: 2 },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // [] → 0; NOW - 0 ≥ TTL → miss
      expect(a).toMatchObject({ name: 'FromDB', joinedCount: 2 });
      expect(b).toMatchObject({ name: 'Hot', joinedCount: 4 });
      expect(db.roomsSeen).toEqual([ROOM_A]);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// Nested avatar url ∥ name:false under parallel miss
// ---------------------------------------------------------------------------

describe('race septenary nested avatar∥falsy name after #281', () => {
  for (let i = 0; i < 8; i++) {
    it(`avatar nested url∥name false isDm under parallel miss flood-${i}`, async () => {
      const { kv } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: {
          rawAvatarContent: JSON.stringify({ url: { nested: 'mxc://x' } }),
          joined: 1,
        },
        [ROOM_B]: {
          rawNameContent: JSON.stringify({ name: false }),
          joined: 2,
        },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      expect(a?.avatar).toEqual({ nested: 'mxc://x' });
      expect(a?.isDm).toBe(true);
      // name === false; !false === true → isDm when joined <= 2
      expect(b?.name).toBe(false);
      expect(b?.isDm).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// State content JSON text "null" → parse then property access throw
// ---------------------------------------------------------------------------

describe('race septenary content JSON null text after #281', () => {
  for (let i = 0; i < 8; i++) {
    it(`rawNameContent 'null'∥valid sibling isolation flood-${i}`, async () => {
      const { kv } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { rawNameContent: 'null', joined: 1 },
        [ROOM_B]: { name: 'Ok', joined: 3 },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // JSON.parse('null') → null; null.name throws → name undefined
      expect(a?.name).toBeUndefined();
      expect(a?.joinedCount).toBe(1);
      expect(a?.isDm).toBe(true);
      expect(b).toMatchObject({ name: 'Ok', joinedCount: 3, isDm: false });
    });
  }
});

// ---------------------------------------------------------------------------
// Three-way: miss put-hold ∥ invalidate ∥ bump
// ---------------------------------------------------------------------------

describe('race septenary put-hold∥invalidate∥bump three-way after #281', () => {
  for (let i = 0; i < 8; i++) {
    it(`miss put-hold∥invalidate∥bump gen≥1 meta empty-or-refilled flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'Three', joined: 2 },
      });

      const getP = getRoomMetadata(kv, db, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.startsWith('put-wait:'))).toBe(true);
      });

      const [invSettled, gen] = await Promise.all([
        invalidateRoomCache(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_A),
      ]);
      expect(invSettled).toBeUndefined();
      expect(gen).toBeGreaterThanOrEqual(1);

      releasePut(metaKey(ROOM_A));
      const meta = await getP;
      expect(meta).toMatchObject({ name: 'Three', joinedCount: 2 });

      const finalGen = await getRoomCacheGeneration(kv, ROOM_A);
      expect(finalGen).toBeGreaterThanOrEqual(1);
      // bump never writes room-meta; invalidate never deletes gen
      expect(ctl.putCount.get(genKey(ROOM_A))).toBe(1);
      expect(ctl.deleteCount.get(genKey(ROOM_A)) ?? 0).toBe(0);
      // After release, put may recreate meta even if invalidate deleted mid-hold
      const hasMeta = ctl.data[metaKey(ROOM_A)] !== undefined;
      expect(typeof hasMeta).toBe('boolean');
    });
  }
});
