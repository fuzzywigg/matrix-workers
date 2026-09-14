/**
 * TOKENMAXX HEAVY leftovers after #314 tridecenary / tip #315 — quattuordecenary
 * room-cache *concurrent race / TOCTOU* niches not landed by tridecenary:
 *   - joinedRaw "2" isDm∥MIN_VALUE isDm∥invitedRaw +Infinity
 *   - name 1 non-DM∥avatar url:0∥avatar url:true under miss
 *   - topic false stored∥topic [] stored∥alias false∥hot sibling
 *   - gen BOM"9"→9∥"4e"→4∥"\\n6"→6 get∥bump
 *   - meta deleteThrows invalidate A swallow∥miss-refill A∥bump B
 *   - get put-hold A∥bump gen A mid∥getBatch hot C isolation
 *   - getBatch getThrows A force-miss∥deleteThrows inv A∥hot B∥miss C
 *
 * Hibernation quattuordecenary leftovers live in call-room-hibernation.test.ts
 * and room-durable-object.test.ts (same PR). Tests-only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file
 * and the hibernation quattuordecenary describes.
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
// joinedRaw "2" / MIN_VALUE / invitedRaw +Infinity
// ---------------------------------------------------------------------------

describe('race quattuordecenary joinedRaw string/MIN + invited +Inf after #314', () => {
  for (let i = 0; i < 8; i++) {
    it(`"2" isDm∥MIN_VALUE isDm∥invited +Inf under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: '2', invitedRaw: 0 },
        [ROOM_B]: { joinedRaw: Number.MIN_VALUE, invitedRaw: 1 },
        [ROOM_C]: { joinedRaw: 1, invitedRaw: Number.POSITIVE_INFINITY },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // '2' truthy stays; '2' <= 2 (coercion) → true → isDm
      expect(a?.joinedCount).toBe('2');
      expect(a?.isDm).toBe(true);
      // MIN_VALUE truthy stays; MIN_VALUE <= 2 → isDm
      expect(b?.joinedCount).toBe(Number.MIN_VALUE);
      expect(b?.invitedCount).toBe(1);
      expect(b?.isDm).toBe(true);
      // +Infinity truthy for invited stays
      expect(c?.joinedCount).toBe(1);
      expect(c?.invitedCount).toBe(Number.POSITIVE_INFINITY);
      expect(c?.isDm).toBe(true);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// name 1 / avatar url:0 / avatar url:true
// ---------------------------------------------------------------------------

describe('race quattuordecenary name 1 + avatar url 0/true after #314', () => {
  for (let i = 0; i < 8; i++) {
    it(`name 1 non-DM∥url 0∥url true under miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { rawNameContent: JSON.stringify({ name: 1 }), joined: 2 },
        [ROOM_B]: { rawAvatarContent: JSON.stringify({ url: 0 }), joined: 1 },
        [ROOM_C]: { rawAvatarContent: JSON.stringify({ url: true }), joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // !1 → false → non-DM; url 0/true stored as-is
      expect(a?.name).toBe(1);
      expect(a?.isDm).toBe(false);
      expect(b?.avatar).toBe(0);
      expect(b?.isDm).toBe(true);
      expect(c?.avatar).toBe(true);
      expect(c?.isDm).toBe(true);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// topic false / topic [] / alias false / hot sibling
// ---------------------------------------------------------------------------

describe('race quattuordecenary topic false/[] / alias false after #314', () => {
  for (let i = 0; i < 8; i++) {
    it(`topic false∥topic []∥alias false∥hot sibling flood-${i}`, async () => {
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
          rawTopicContent: JSON.stringify({ topic: false }),
          rawAliasContent: JSON.stringify({ alias: false }),
          joined: 1,
        },
        [ROOM_B]: { rawTopicContent: JSON.stringify({ topic: [] }), joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      expect(a?.topic).toBe(false);
      expect(a?.canonicalAlias).toBe(false);
      expect(a?.isDm).toBe(true);
      expect(b?.topic).toEqual([]);
      expect(b?.isDm).toBe(true);
      expect(c?.name).toBe('HotC');
      expect(db.batchCalls).toBe(2);
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Generation BOM"9" / "4e" / "\\n6"
// ---------------------------------------------------------------------------

describe('race quattuordecenary gen BOM/4e/newline parse after #314', () => {
  for (let i = 0; i < 8; i++) {
    it(`BOM9→9∥4e→4∥newline6→6 get∥bump flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '\uFEFF9',
          [genKey(ROOM_B)]: '4e',
          [genKey(ROOM_C)]: '\n6',
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

      // parseInt(BOM+'9')=9; parseInt('4e')=4; parseInt('\\n6')=6
      expect(gA).toBe(9);
      expect(bA).toBe(10);
      expect(gB).toBe(4);
      expect(bB).toBe(5);
      expect(gC).toBe(6);
      expect(bC).toBe(7);
      expect(ctl.data[genKey(ROOM_A)]).toBe('10');
      expect(ctl.data[genKey(ROOM_B)]).toBe('5');
      expect(ctl.data[genKey(ROOM_C)]).toBe('7');
    });
  }
});

// ---------------------------------------------------------------------------
// meta deleteThrows invalidate A swallow ∥ miss-refill A ∥ bump B
// ---------------------------------------------------------------------------

describe('race quattuordecenary deleteThrows inv∥miss-refill∥bump after #314', () => {
  for (let i = 0; i < 8; i++) {
    it(`deleteThrow swallows∥A refills FreshA∥bump B→1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StaleA' })),
        },
        deleteThrows: [metaKey(ROOM_A)],
        getThrows: [metaKey(ROOM_A)],
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [genKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 3 },
      });

      const [inv, a, gen] = await Promise.all([
        invalidateRoomCache(kv, ROOM_A),
        getRoomMetadata(kv, db, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
      ]);

      expect(inv).toBeUndefined();
      // getThrows forces D1; put succeeds; deleteThrow left stale key until put overwrites
      expect(a?.name).toBe('FreshA');
      expect(gen).toBe(1);
      expect(db.batchCalls).toBe(1);
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('FreshA');
      expect(ctl.data[genKey(ROOM_B)]).toBe('1');
      expect(ctl.deleteCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// get put-hold A ∥ bump gen A mid ∥ getBatch hot C
// ---------------------------------------------------------------------------

describe('race quattuordecenary put-hold∥bump mid∥batch hot after #314', () => {
  for (let i = 0; i < 8; i++) {
    it(`put-hold A∥bump A mid∥batch C hot isolation flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        data: {
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'HotC' })),
        },
        putHold: [metaKey(ROOM_A)],
        getThrows: [metaKey(ROOM_A)],
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
      expect(gen).toBe(1);
      expect(batch.get(ROOM_C)?.name).toBe('HotC');
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();

      releasePut(metaKey(ROOM_A));
      const a = await getP;
      expect(a?.name).toBe('HoldA');
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('HoldA');
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
      expect(db.batchCalls).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// getBatch getThrows A force-miss ∥ deleteThrows inv A ∥ hot B ∥ miss C
// ---------------------------------------------------------------------------

describe('race quattuordecenary getBatch getThrow∥deleteThrow∥hot after #314', () => {
  for (let i = 0; i < 8; i++) {
    it(`batch A getThrow miss-refill∥inv deleteThrow∥B hot∥C miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StaleA' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HotB' })),
        },
        getThrows: [metaKey(ROOM_A)],
        deleteThrows: [metaKey(ROOM_A)],
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 1 },
        [ROOM_C]: { name: 'FreshC', joined: 2 },
      });

      const [map, inv] = await Promise.all([
        getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B, ROOM_C]),
        invalidateRoomCache(kv, ROOM_A),
      ]);

      expect(inv).toBeUndefined();
      expect(map.get(ROOM_A)?.name).toBe('FreshA');
      expect(map.get(ROOM_B)?.name).toBe('HotB');
      expect(map.get(ROOM_C)?.name).toBe('FreshC');
      expect(db.batchCalls).toBe(2);
      // Batch put may overwrite stale; deleteThrow left key present or put won
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('FreshA');
      expect(ctl.putTtl.get(metaKey(ROOM_C))).toBe(TTL_SECONDS);
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBe(0);
      expect(ctl.deleteCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});
