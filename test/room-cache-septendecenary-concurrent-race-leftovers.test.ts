/**
 * TOKENMAXX HEAVY leftovers after #332 quindecenary / open sexdecenary #353 —
 * septendecenary room-cache *concurrent race / TOCTOU* niches not landed by
 * quindecenary or claimed by sexdecenary:
 *   - joinedRaw " 2" isDm∥"-0" stays∥invitedRaw "1" stays
 *   - name " " non-DM∥avatar url:"0"∥avatar url:"1" under miss
 *   - topic {} stored∥alias null→undefined∥hot sibling
 *   - gen FF form"5"→5∥"6e0"→6∥"1.5"→1 get∥bump
 *   - meta deleteThrows invBatch A swallow∥miss-refill A∥bump B
 *   - get put-hold A∥gen getThrows bump A∥getBatch hot C
 *   - getBatch getThrows A∥putThrows B swallow∥hot C∥invBatch A
 *
 * Hibernation septendecenary leftovers live in call-room-hibernation.test.ts
 * and room-durable-object.test.ts (same PR). Tests-only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file
 * and the hibernation septendecenary describes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import {
  bumpRoomCacheGeneration,
  getBatchRoomMetadata,
  getRoomCacheGeneration,
  getRoomMetadata,
  invalidateBatchRoomCache,
  type RoomMetadata,
} from '../src/services/room-cache';

const ROOM_A = '!alpha:example.com';
const ROOM_B = '!beta:example.com';
const ROOM_C = '!gamma:example.com';
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
// joinedRaw " 2" / "-0" / invitedRaw "1"
// ---------------------------------------------------------------------------

describe('race septendecenary joinedRaw space2/-0 + invited "1" after #332', () => {
  for (let i = 0; i < 8; i++) {
    it(`" 2" isDm∥"-0" stays∥invited "1" under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: ' 2', invitedRaw: 0 },
        [ROOM_B]: { joinedRaw: '-0', invitedRaw: 0 },
        [ROOM_C]: { joinedRaw: 1, invitedRaw: '1' },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // " 2" truthy stays; Number(" 2")=2 <= 2 → isDm
      expect(a?.joinedCount).toBe(' 2');
      expect(a?.isDm).toBe(true);
      // "-0" truthy stays; Number("-0")= -0 <= 2 → isDm
      expect(b?.joinedCount).toBe('-0');
      expect(b?.isDm).toBe(true);
      // invited "1" truthy stays (|| 0 does not coerce)
      expect(c?.joinedCount).toBe(1);
      expect(c?.invitedCount).toBe('1');
      expect(c?.isDm).toBe(true);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// name " " / avatar url:"0" / avatar url:"1"
// ---------------------------------------------------------------------------

describe('race septendecenary name space + avatar url "0"/"1" after #332', () => {
  for (let i = 0; i < 8; i++) {
    it(`name " " non-DM∥url "0"∥url "1" under miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { rawNameContent: JSON.stringify({ name: ' ' }), joined: 1 },
        [ROOM_B]: { rawAvatarContent: JSON.stringify({ url: '0' }), joined: 1 },
        [ROOM_C]: { rawAvatarContent: JSON.stringify({ url: '1' }), joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // " " truthy → !name false → non-DM; url "0"/"1" stored as-is
      expect(a?.name).toBe(' ');
      expect(a?.isDm).toBe(false);
      expect(b?.avatar).toBe('0');
      expect(b?.isDm).toBe(true);
      expect(c?.avatar).toBe('1');
      expect(c?.isDm).toBe(true);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// topic {} / alias null / hot sibling
// ---------------------------------------------------------------------------

describe('race septendecenary topic {} / alias null after #332', () => {
  for (let i = 0; i < 8; i++) {
    it(`topic {}∥alias null→undefined∥hot sibling flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'HotC' })),
        },
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: {
          rawTopicContent: JSON.stringify({ topic: {} }),
          rawAliasContent: JSON.stringify({ alias: null }),
          joined: 1,
        },
        [ROOM_B]: { rawTopicContent: JSON.stringify({ topic: {} }), joined: 2 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      expect(a?.topic).toEqual({});
      // alias: null assigned → canonicalAlias null (key present)
      expect(a?.canonicalAlias).toBeNull();
      expect(a?.isDm).toBe(true);
      expect(b?.topic).toEqual({});
      expect(b?.isDm).toBe(true);
      expect(c?.name).toBe('HotC');
      expect(db.batchCalls).toBe(2);
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Generation form-feed "5" / "6e0" / "1.5"
// ---------------------------------------------------------------------------

describe('race septendecenary gen FF/6e0/1.5 parse after #332', () => {
  for (let i = 0; i < 8; i++) {
    it(`FF5→5∥6e0→6∥1.5→1 get∥bump flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '\f5',
          [genKey(ROOM_B)]: '6e0',
          [genKey(ROOM_C)]: '1.5',
        },
        getBarrier: [
          [genKey(ROOM_A), 2],
          [genKey(ROOM_B), 2],
          [genKey(ROOM_C), 2],
        ],
      });

      const [gA, bA, gB, bB, gC, bC] = await Promise.all([
        getRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_B),
        bumpRoomCacheGeneration(kv, ROOM_B),
        getRoomCacheGeneration(kv, ROOM_C),
        bumpRoomCacheGeneration(kv, ROOM_C),
      ]);

      // parseInt('\\f5')=5; parseInt('6e0')=6; parseInt('1.5')=1
      expect(gA).toBe(5);
      expect(bA).toBe(6);
      expect(gB).toBe(6);
      expect(bB).toBe(7);
      expect(gC).toBe(1);
      expect(bC).toBe(2);
      expect(ctl.data[genKey(ROOM_A)]).toBe('6');
      expect(ctl.data[genKey(ROOM_B)]).toBe('7');
      expect(ctl.data[genKey(ROOM_C)]).toBe('2');
    });
  }
});

// ---------------------------------------------------------------------------
// meta deleteThrows invBatch A ∥ miss-refill A ∥ bump B
// ---------------------------------------------------------------------------

describe('race septendecenary deleteThrow invBatch∥miss-refill∥bump after #332', () => {
  for (let i = 0; i < 8; i++) {
    it(`invBatch deleteThrow∥A refills FreshA∥bump B→1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StaleA' })),
        },
        deleteThrows: [metaKey(ROOM_A)],
        getThrows: [metaKey(ROOM_A)],
        getBarrier: [[genKey(ROOM_B), 1]],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 3 },
      });

      const [inv, a, gen] = await Promise.all([
        invalidateBatchRoomCache(kv, [ROOM_A]),
        getRoomMetadata(kv, db, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
      ]);

      expect(inv).toBeUndefined();
      expect(a?.name).toBe('FreshA');
      expect(gen).toBe(1);
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('FreshA');
      expect(db.batchCalls).toBe(1);
      expect(ctl.data[genKey(ROOM_B)]).toBe('1');
      expect(ctl.deleteCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// get put-hold A ∥ gen getThrows bump A ∥ getBatch hot C
// ---------------------------------------------------------------------------

describe('race septendecenary put-hold∥gen getThrow bump∥batch hot after #332', () => {
  for (let i = 0; i < 8; i++) {
    it(`put-hold A∥bump getThrow→1∥batch C hot isolation flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        data: {
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'HotC' })),
          [genKey(ROOM_A)]: '4',
        },
        putHold: [metaKey(ROOM_A)],
        getThrows: [metaKey(ROOM_A), genKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'HoldA', joined: 2 },
      });

      const getP = getRoomMetadata(kv, db, ROOM_A);
      const bumpP = bumpRoomCacheGeneration(kv, ROOM_A);
      const batchP = getBatchRoomMetadata(kv, db, [ROOM_C]);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${metaKey(ROOM_A)}`))).toBe(true);
      });

      const [gen, batch] = await Promise.all([bumpP, batchP]);
      // getThrows on gen → current=0 → bump writes 1
      expect(gen).toBe(1);
      expect(batch.get(ROOM_C)?.name).toBe('HotC');
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');

      releasePut(metaKey(ROOM_A));
      const a = await getP;
      expect(a?.name).toBe('HoldA');
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('HoldA');
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
      expect(db.batchCalls).toBe(1);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// getBatch getThrows A ∥ putThrows B ∥ hot C ∥ invBatch A
// ---------------------------------------------------------------------------

describe('race septendecenary getBatch getThrow∥putThrow∥hot∥inv after #332', () => {
  for (let i = 0; i < 8; i++) {
    it(`batch A getThrow miss∥B putThrow swallow∥C hot∥inv A flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StaleA' })),
          // B absent → natural miss; putThrows swallows refill write
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'HotC' })),
        },
        getThrows: [metaKey(ROOM_A)],
        putThrows: [metaKey(ROOM_B)],
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 1 },
        [ROOM_B]: { name: 'FreshB', joined: 2 },
      });

      const [map, inv] = await Promise.all([
        getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B, ROOM_C]),
        invalidateBatchRoomCache(kv, [ROOM_A]),
      ]);

      expect(inv).toBeUndefined();
      expect(map.get(ROOM_A)?.name).toBe('FreshA');
      // putThrows on B: fire-and-forget .catch — map still has FreshB from DB
      expect(map.get(ROOM_B)?.name).toBe('FreshB');
      expect(map.get(ROOM_C)?.name).toBe('HotC');
      expect(db.batchCalls).toBe(2);
      // A may be deleted by invBatch or refilled by put — either is coherent
      if (ctl.data[metaKey(ROOM_A)]) {
        expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('FreshA');
      }
      // B put threw — key must remain absent
      expect(ctl.data[metaKey(ROOM_B)]).toBeUndefined();
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBeGreaterThanOrEqual(1);
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
      expect(ctl.deleteCount.get(metaKey(ROOM_A)) ?? 0).toBeGreaterThanOrEqual(1);
    });
  }
});
