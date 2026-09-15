/**
 * TOKENMAXX HEAVY leftovers after #400 novemdenary / tip 4ccd2a5 —
 * vicenary room-cache *concurrent race / TOCTOU* niches not landed by
 * novemdenary:
 *   - joinedRaw "\n" isDm∥"\v" isDm∥invitedRaw NEGATIVE_INFINITY stays
 *   - name " " non-DM∥avatar url:"\t"∥avatar url:"\n" under miss
 *   - topic "true" stored∥alias " "∥alias 0∥hot sibling
 *   - gen THIN"8"→8∥"8f"→8∥HAIR"6"→6 get∥bump
 *   - meta getHold A∥gen getThrows A→0 get∥hot B
 *   - putThrows meta A swallow∥invalidate A mid∥getBatch hot C
 *   - getBatch deleteHold A∥putThrows B∥getThrows C∥hot then miss
 *
 * Hibernation vicenary leftovers live in call-room-hibernation.test.ts
 * and room-durable-object.test.ts (same PR). Tests-only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file
 * and the hibernation vicenary describes.
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
// joinedRaw "\n" / "\v" / invitedRaw NEGATIVE_INFINITY
// ---------------------------------------------------------------------------

describe('race vicenary joinedRaw nl/vt + invited NEG_INF after #400', () => {
  for (let i = 0; i < 8; i++) {
    it(`nl isDm∥vt isDm∥invited NEG_INF stays under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: '\n', invitedRaw: 0 },
        [ROOM_B]: { joinedRaw: '\v', invitedRaw: 1 },
        [ROOM_C]: { joinedRaw: 1, invitedRaw: Number.NEGATIVE_INFINITY },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // '\n' truthy stays; Number('\n')===0 <= 2 → isDm
      expect(a?.joinedCount).toBe('\n');
      expect(a?.isDm).toBe(true);
      // '\v' truthy stays; '\v' <= 2 → isDm
      expect(b?.joinedCount).toBe('\v');
      expect(b?.invitedCount).toBe(1);
      expect(b?.isDm).toBe(true);
      // NEGATIVE_INFINITY invited stays as-is
      expect(c?.joinedCount).toBe(1);
      expect(c?.invitedCount).toBe(Number.NEGATIVE_INFINITY);
      expect(c?.isDm).toBe(true);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// name " " / avatar url:"\t" / avatar url:"\n"
// ---------------------------------------------------------------------------

describe('race vicenary name space + avatar url tab/nl after #400', () => {
  for (let i = 0; i < 8; i++) {
    it(`name " " non-DM∥url "\\t"∥url "\\n" under miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { rawNameContent: JSON.stringify({ name: ' ' }), joined: 2 },
        [ROOM_B]: { rawAvatarContent: JSON.stringify({ url: '\t' }), joined: 1 },
        [ROOM_C]: { rawAvatarContent: JSON.stringify({ url: '\n' }), joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // !' ' → false → non-DM; url tab/nl stored as-is
      expect(a?.name).toBe(' ');
      expect(a?.isDm).toBe(false);
      expect(b?.avatar).toBe('\t');
      expect(b?.isDm).toBe(true);
      expect(c?.avatar).toBe('\n');
      expect(c?.isDm).toBe(true);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// topic "true" / alias " " / alias 0 / hot sibling
// ---------------------------------------------------------------------------

describe('race vicenary topic "true" / alias " "/0 after #400', () => {
  for (let i = 0; i < 8; i++) {
    it(`topic "true"∥alias " "∥alias 0∥hot sibling flood-${i}`, async () => {
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
          rawTopicContent: JSON.stringify({ topic: 'true' }),
          rawAliasContent: JSON.stringify({ alias: ' ' }),
          joined: 1,
        },
        [ROOM_B]: { rawAliasContent: JSON.stringify({ alias: 0 }), joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      expect(a?.topic).toBe('true');
      expect(a?.canonicalAlias).toBe(' ');
      expect(a?.isDm).toBe(true);
      expect(b?.canonicalAlias).toBe(0);
      expect(b?.isDm).toBe(true);
      expect(c?.name).toBe('HotC');
      expect(db.batchCalls).toBe(2);
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Generation THIN SPACE "8" / "8f" / HAIR SPACE trailing "6"
// ---------------------------------------------------------------------------

describe('race vicenary gen THIN/8f/HAIR parse after #400', () => {
  for (let i = 0; i < 8; i++) {
    it(`THIN8→8∥8f→8∥HAIR6→6 get∥bump flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '\u20098',
          [genKey(ROOM_B)]: '8f',
          [genKey(ROOM_C)]: '6\u200A',
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

      // parseInt(THIN+'8')=8; parseInt('8f')=8; parseInt('6'+HAIR)=6
      expect(gA).toBe(8);
      expect(bA).toBe(9);
      expect(gB).toBe(8);
      expect(bB).toBe(9);
      expect(gC).toBe(6);
      expect(bC).toBe(7);
      expect(ctl.data[genKey(ROOM_A)]).toBe('9');
      expect(ctl.data[genKey(ROOM_B)]).toBe('9');
      expect(ctl.data[genKey(ROOM_C)]).toBe('7');
    });
  }
});

// ---------------------------------------------------------------------------
// meta getHold A ∥ gen getThrows A →0 get ∥ hot B
// ---------------------------------------------------------------------------

describe('race vicenary getHold meta∥gen getThrow∥hot after #400', () => {
  for (let i = 0; i < 8; i++) {
    it(`getHold A miss-refill∥gen getThrow→0∥B hot flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        data: {
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HotB' })),
          [genKey(ROOM_A)]: '42',
        },
        getThrows: [genKey(ROOM_A)],
        getHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 3 },
      });

      const getP = getRoomMetadata(kv, db, ROOM_A);
      const genP = getRoomCacheGeneration(kv, ROOM_A);
      const hotP = getRoomMetadata(kv, db, ROOM_B);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${metaKey(ROOM_A)}`))).toBe(true);
      });

      const [gen, b] = await Promise.all([genP, hotP]);
      // getThrows on gen → 0; B stays hot while A get is held
      expect(gen).toBe(0);
      expect(b?.name).toBe('HotB');
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBe(0);

      releaseGet(metaKey(ROOM_A));
      const a = await getP;
      expect(a?.name).toBe('FreshA');
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('FreshA');
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
      expect(db.batchCalls).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// putThrows meta A ∥ invalidate A mid ∥ getBatch hot C
// ---------------------------------------------------------------------------

describe('race vicenary putThrow∥inv mid∥batch hot after #400', () => {
  for (let i = 0; i < 8; i++) {
    it(`putThrow A miss∥inv mid∥batch C hot flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StaleA' })),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'HotC' })),
        },
        putThrows: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 2 },
      });

      const invP = invalidateRoomCache(kv, ROOM_A);
      const getP = getRoomMetadata(kv, db, ROOM_A);
      const batchP = getBatchRoomMetadata(kv, db, [ROOM_C]);

      await Promise.all([invP, batchP]);
      const batch = await batchP;
      expect(batch.get(ROOM_C)?.name).toBe('HotC');
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();

      const a = await getP;
      // After inv: miss→FreshA; putThrows swallows so key may stay absent
      expect(a?.name).toBe('FreshA');
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBeGreaterThanOrEqual(1);
      expect(db.batchCalls).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// getBatch deleteHold A ∥ putThrows B ∥ getThrows C
// ---------------------------------------------------------------------------

describe('race vicenary getBatch deleteHold∥putThrow∥getThrow after #400', () => {
  for (let i = 0; i < 8; i++) {
    it(`batch A deleteHold∥B putThrow∥C getThrow miss flood-${i}`, async () => {
      const { kv, ctl, releaseDelete } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StaleA' })),
        },
        putThrows: [metaKey(ROOM_B)],
        getThrows: [metaKey(ROOM_C)],
        deleteHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 2 },
        [ROOM_B]: { name: 'FreshB', joined: 2 },
        [ROOM_C]: { name: 'FreshC', joined: 2 },
      });

      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B, ROOM_C]);
      const invP = invalidateRoomCache(kv, ROOM_A);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`delete-wait:${metaKey(ROOM_A)}`))).toBe(true);
      });

      // While delete held, A may still be hot in batch; B/C miss→DB
      // Release so batch + inv can finish
      releaseDelete(metaKey(ROOM_A));
      await invP;

      const map = await batchP;
      // A: hot-at-check OR FreshA after mid-inv race
      expect(['StaleA', 'FreshA']).toContain(map.get(ROOM_A)?.name);
      expect(map.get(ROOM_B)?.name).toBe('FreshB');
      expect(map.get(ROOM_C)?.name).toBe('FreshC');
      // B putThrows → key absent; C getThrows → miss refill may put
      expect(ctl.data[metaKey(ROOM_B)]).toBeUndefined();
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBeGreaterThanOrEqual(1);
      await vi.waitFor(() => {
        expect(ctl.data[metaKey(ROOM_C)]).toBeDefined();
      });
      expect(JSON.parse(ctl.data[metaKey(ROOM_C)]).name).toBe('FreshC');
      expect(db.batchCalls).toBeGreaterThanOrEqual(2);
    });
  }
});
