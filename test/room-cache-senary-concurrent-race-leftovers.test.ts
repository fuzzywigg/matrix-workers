/**
 * TOKENMAXX HEAVY leftovers after #273/#276 — senary room-cache
 * *concurrent race / TOCTOU* niches not covered by #232 / #240 / #246
 * tertiary / #251 second-wave / #263 quaternary / #273 quinary.
 *
 * Senary focus (existing `src/services/room-cache.ts` only):
 *   - joinedRaw true / invitedRaw undefined count coercions under parallel miss
 *   - empty-string topic/alias + nested topic/alias under concurrent miss
 *   - KV json overlay null/true/false/{} → miss refill
 *   - overlay object with cachedAt:undefined (key present) vs omit-key
 *   - generation "1e2" / "-0" get∥bump parse leftovers
 *   - dual getBatch miss stampede + putThrows A .catch ∥ B put ok
 *   - empty getBatch∥empty invalidateBatch∥hot sibling
 *   - batch getThrows A + get-barrier B + invalidate mid-hold TOCTOU
 *   - bump getThrows→put-hold: gen stays 0 until release
 *   - bump getThrows then putThrows reject ∥ sibling bump ok
 *   - batch putThrows A .catch ∥ immediate single re-get (no cached put)
 *   - empty invalidateBatch∥bump∥hot meta (gen moves, meta stays)
 *
 * Hibernation concurrent leftovers live in call-room-hibernation.test.ts
 * and room-durable-object.test.ts (same PR). Tests-only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file
 * and the hibernation senary describes.
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
// Count coercions: true / undefined (beyond quinary 0/null/false)
// ---------------------------------------------------------------------------

describe('race senary count true/undefined coercions after #273', () => {
  for (let i = 0; i < 8; i++) {
    it(`joinedRaw true∥invitedRaw undefined under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: true, invitedRaw: 1 },
        [ROOM_B]: { joinedRaw: 2, invitedRaw: undefined },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // true || 0 → true (stays boolean); true <= 2 → isDm
      expect(a?.joinedCount).toBe(true);
      expect(a?.invitedCount).toBe(1);
      expect(a?.isDm).toBe(true);
      // undefined || 0 → 0
      expect(b?.joinedCount).toBe(2);
      expect(b?.invitedCount).toBe(0);
      expect(b?.isDm).toBe(true);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// Empty-string + nested topic/alias (quinary covered name/avatar only)
// ---------------------------------------------------------------------------

describe('race senary topic/alias empty+nested leftovers after #273', () => {
  for (let i = 0; i < 8; i++) {
    it(`topic ''∥alias ''∥nested topic/alias under parallel miss flood-${i}`, async () => {
      const { kv } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
          [metaKey(ROOM_D), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: {
          rawTopicContent: JSON.stringify({ topic: '' }),
          joined: 1,
        },
        [ROOM_B]: {
          rawAliasContent: JSON.stringify({ alias: '' }),
          joined: 1,
        },
        [ROOM_C]: {
          rawTopicContent: JSON.stringify({ topic: { nested: true } }),
          joined: 2,
        },
        [ROOM_D]: {
          rawAliasContent: JSON.stringify({ alias: { nested: true } }),
          joined: 2,
        },
      });

      const [a, b, c, d] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
        getRoomMetadata(kv, db, ROOM_D),
      ]);

      expect(a?.topic).toBe('');
      expect(b?.canonicalAlias).toBe('');
      expect(c?.topic).toEqual({ nested: true });
      expect(d?.canonicalAlias).toEqual({ nested: true });
    });
  }
});

// ---------------------------------------------------------------------------
// null / bool / {} KV json overlay → miss (quinary: array/number/string)
// ---------------------------------------------------------------------------

describe('race senary null/bool/{} KV overlay miss after #273', () => {
  for (let i = 0; i < 8; i++) {
    it(`null∥true∥false∥{} overlay → D1 refill isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        jsonOverlay: {
          [metaKey(ROOM_A)]: null,
          [metaKey(ROOM_B)]: true,
          [metaKey(ROOM_C)]: false,
          [metaKey(ROOM_D)]: {},
        },
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
          [metaKey(ROOM_D), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'A2', joined: 2 },
        [ROOM_B]: { name: 'B2', joined: 2 },
        [ROOM_C]: { name: 'C2', joined: 2 },
        [ROOM_D]: { name: 'D2', joined: 2 },
      });

      const [a, b, c, d] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
        getRoomMetadata(kv, db, ROOM_D),
      ]);

      // null/false falsy short-circuit; true/{} truthy but cachedAt → NaN age → miss
      expect(a?.name).toBe('A2');
      expect(b?.name).toBe('B2');
      expect(c?.name).toBe('C2');
      expect(d?.name).toBe('D2');
      expect(db.batchCalls).toBe(4);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// cachedAt: undefined (key present) vs omit-key vs hot
// ---------------------------------------------------------------------------

describe('race senary cachedAt undefined-key overlay after #273', () => {
  for (let i = 0; i < 8; i++) {
    it(`cachedAt:undefined miss∥omit-key miss∥hot sibling flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        jsonOverlay: {
          [metaKey(ROOM_A)]: {
            name: 'UndefAt',
            joinedCount: 2,
            invitedCount: 0,
            isDm: true,
            cachedAt: undefined,
          },
          [metaKey(ROOM_B)]: {
            name: 'OmitAt',
            joinedCount: 2,
            invitedCount: 0,
            isDm: true,
          },
        },
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
        [ROOM_A]: { name: 'A2', joined: 2 },
        [ROOM_B]: { name: 'B2', joined: 2 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      expect(a?.name).toBe('A2');
      expect(b?.name).toBe('B2');
      expect(c?.name).toBe('HotC');
      expect(db.batchCalls).toBe(2);
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Generation "1e2" / "-0" parse leftovers (beyond quinary NaN/+0)
// ---------------------------------------------------------------------------

describe('race senary gen 1e2/-0 get∥bump after #273', () => {
  for (let i = 0; i < 8; i++) {
    it(`1e2 get→1∥bump→2; -0 get→0∥bump→1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '1e2',
          [genKey(ROOM_B)]: '-0',
        },
        getBarrier: [
          [genKey(ROOM_A), 2],
          [genKey(ROOM_B), 2],
        ],
      });

      const [gA, bumpedA, gB, bumpedB] = await Promise.all([
        getRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_B),
        bumpRoomCacheGeneration(kv, ROOM_B),
      ]);

      // parseInt('1e2',10)→1; parseInt('-0',10)→-0 (Object.is distinct from +0)
      expect(gA).toBe(1);
      expect(bumpedA).toBe(2);
      expect(gB === 0).toBe(true);
      expect(Object.is(gB, -0)).toBe(true);
      expect(bumpedB).toBe(1);
      expect(ctl.data[genKey(ROOM_A)]).toBe('2');
      expect(ctl.data[genKey(ROOM_B)]).toBe('1');
    });
  }
});

// ---------------------------------------------------------------------------
// Dual getBatch stampede + putThrows A .catch ∥ B put ok
// ---------------------------------------------------------------------------

describe('race senary batch putThrows dual-stampede .catch after #273', () => {
  for (let i = 0; i < 8; i++) {
    it(`dual getBatch miss putThrows A swallow∥B put ok flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        putThrows: [metaKey(ROOM_A)],
        getBarrier: [
          [metaKey(ROOM_A), 2],
          [metaKey(ROOM_B), 2],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'NoPut', joined: 2 },
        [ROOM_B]: { name: 'PutOk', joined: 3 },
      });

      const [m1, m2] = await Promise.all([
        getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]),
        getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]),
      ]);

      expect(m1.get(ROOM_A)?.name).toBe('NoPut');
      expect(m1.get(ROOM_B)?.name).toBe('PutOk');
      expect(m2.get(ROOM_A)?.name).toBe('NoPut');
      expect(m2.get(ROOM_B)?.name).toBe('PutOk');
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeDefined();
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBeGreaterThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Empty batch ∥ empty invalidate ∥ hot sibling
// ---------------------------------------------------------------------------

describe('race senary empty batch∥empty invalidate∥hot sibling after #273', () => {
  for (let i = 0; i < 8; i++) {
    it(`empty ops never touch KV∥hot get hits flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Hot' })),
        },
        getBarrier: [[metaKey(ROOM_A), 1]],
      });
      const db = mockDb({});

      const [emptyBatch, , hot] = await Promise.all([
        getBatchRoomMetadata(kv, db, []),
        invalidateBatchRoomCache(kv, []),
        getRoomMetadata(kv, db, ROOM_A),
      ]);

      expect(emptyBatch.size).toBe(0);
      expect(hot?.name).toBe('Hot');
      expect(db.batchCalls).toBe(0);
      expect(ctl.deleteCount.size).toBe(0);
      expect(ctl.putCount.size).toBe(0);
      expect(ctl.getCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Batch getThrows A + get-barrier B + invalidate mid-hold
// ---------------------------------------------------------------------------

describe('race senary batch getThrows+barrier invalidate TOCTOU after #273', () => {
  for (let i = 0; i < 8; i++) {
    it(`getThrows A→D1∥B hold then invalidate refill flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        data: {
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'StaleB' })),
        },
        getThrows: [metaKey(ROOM_A)],
        getHold: [metaKey(ROOM_B)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'A2', joined: 2 },
        [ROOM_B]: { name: 'B2', joined: 3 },
      });

      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${metaKey(ROOM_B)}`))).toBe(true);
      });

      await invalidateRoomCache(kv, ROOM_B);
      releaseGet(metaKey(ROOM_B));

      const batch = await batchP;
      expect(batch.get(ROOM_A)?.name).toBe('A2');
      expect(batch.get(ROOM_B)?.name).toBe('B2');
      expect(db.batchCalls).toBe(2);
      expect(ctl.deleteCount.get(metaKey(ROOM_B)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Bump getThrows → put-hold: gen stays 0 until release
// ---------------------------------------------------------------------------

describe('race senary bump getThrows→put-hold visibility after #273', () => {
  for (let i = 0; i < 8; i++) {
    it(`getThrows treat-0 then put-hold: concurrent get stays 0 flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '9',
        },
        getThrows: [genKey(ROOM_A)],
        putHold: [genKey(ROOM_A)],
      });

      const bumpP = bumpRoomCacheGeneration(kv, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${genKey(ROOM_A)}`))).toBe(true);
      });

      // Put not committed yet — generation still absent / unread
      expect(ctl.data[genKey(ROOM_A)]).toBe('9'); // get threw before read; put pending
      const mid = await getRoomCacheGeneration(kv, ROOM_A);
      expect(mid).toBe(0); // getThrows path

      releasePut(genKey(ROOM_A));
      expect(await bumpP).toBe(1);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
    });
  }
});

// ---------------------------------------------------------------------------
// Bump getThrows then putThrows reject ∥ sibling bump ok
// ---------------------------------------------------------------------------

describe('race senary bump getThrows then putThrows reject after #273', () => {
  for (let i = 0; i < 8; i++) {
    it(`A getThrow+putThrow rejects∥B bump ok flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '5',
          [genKey(ROOM_B)]: '3',
        },
        getThrows: [genKey(ROOM_A)],
        putThrows: [genKey(ROOM_A)],
        getBarrier: [
          [genKey(ROOM_A), 1],
          [genKey(ROOM_B), 1],
        ],
      });

      const [aSettled, bSettled] = await Promise.allSettled([
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
      ]);

      expect(aSettled.status).toBe('rejected');
      expect(bSettled.status).toBe('fulfilled');
      if (bSettled.status === 'fulfilled') {
        expect(bSettled.value).toBe(4);
      }
      expect(ctl.data[genKey(ROOM_A)]).toBe('5'); // put never committed
      expect(ctl.data[genKey(ROOM_B)]).toBe('4');
    });
  }
});

// ---------------------------------------------------------------------------
// Batch putThrows A .catch ∥ immediate single re-get (no cached put)
// ---------------------------------------------------------------------------

describe('race senary batch putThrows∥single re-get after #273', () => {
  for (let i = 0; i < 8; i++) {
    it(`batch putThrows A∥single get A still DB (uncached) flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        putThrows: [metaKey(ROOM_A)],
        getBarrier: [[metaKey(ROOM_A), 2]],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'Live', joined: 4 },
      });

      const [batch, single] = await Promise.all([
        getBatchRoomMetadata(kv, db, [ROOM_A]),
        getRoomMetadata(kv, db, ROOM_A),
      ]);

      expect(batch.get(ROOM_A)?.name).toBe('Live');
      expect(single?.name).toBe('Live');
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(db.batchCalls).toBeGreaterThanOrEqual(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Empty invalidateBatch ∥ bump ∥ hot meta
// ---------------------------------------------------------------------------

describe('race senary empty invalidate∥bump∥hot meta after #273', () => {
  for (let i = 0; i < 8; i++) {
    it(`empty invalidate no-op∥bump moves gen∥meta stays hot flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Stay' })),
        },
        getBarrier: [[metaKey(ROOM_A), 1]],
      });
      const db = mockDb({});

      const [, gen, hot] = await Promise.all([
        invalidateBatchRoomCache(kv, []),
        bumpRoomCacheGeneration(kv, ROOM_A),
        getRoomMetadata(kv, db, ROOM_A),
      ]);

      expect(gen).toBe(1);
      expect(hot?.name).toBe('Stay');
      expect(ctl.data[metaKey(ROOM_A)]).toBeDefined();
      expect(ctl.deleteCount.size).toBe(0);
      expect(db.batchCalls).toBe(0);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
    });
  }
});
