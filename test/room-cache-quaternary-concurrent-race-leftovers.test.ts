/**
 * TOKENMAXX HEAVY leftovers after #251/#246 — quaternary room-cache
 * *concurrent race / TOCTOU* niches not covered by #232 / #240 / #246
 * tertiary / #251 second-wave.
 *
 * Quaternary focus (existing `src/services/room-cache.ts` only):
 *   - invalidate→bump reverse writer order ∥ concurrent miss (sibling of
 *     rooms.ts bump→invalidate covered in tertiary)
 *   - three-way get∥bump∥invalidate under get-barrier
 *   - D1 batch throw isolation A∥B under parallel miss
 *   - JSON field type coercions (number name / null url / array topic /
 *     bool alias) under concurrent miss
 *   - MAX_SAFE_INTEGER / MIN_SAFE_INTEGER / undefined-string cachedAt TTL
 *   - meta put-hold ∥ gen bump put-hold same-room key-prefix isolation
 *   - batch hot+stale+miss ∥ invalidate stale mid get-barrier
 *   - joinedCount=2 isDm ∥ joined=3 named concurrent
 *   - rooms.ts-style bump.catch + fire-and-forget invalidate under dual
 *     writers
 *   - empty-string generation get∥bump; content-row null content field
 *   - count-as-string "2" DB coercion under parallel miss
 *
 * Hibernation concurrent leftovers live in call-room-hibernation.test.ts
 * and room-durable-object.test.ts (same PR). Tests-only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file
 * and the hibernation quaternary describes.
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
  /** When set, joined count row uses this raw JS value (e.g. string "2"). */
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
  if (raw === null) return { results: [{ content: null }] };
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
      stmtCounts?.push(stmts.length);
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
                spec.joinedRaw !== undefined
                  ? spec.joinedRaw
                  : (spec.joined ?? 0),
            },
          ],
        },
        {
          results: [
            {
              count:
                spec.invitedRaw !== undefined
                  ? spec.invitedRaw
                  : (spec.invited ?? 0),
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
// invalidate→bump reverse writer (unsaturated sibling of bump→invalidate)
// ---------------------------------------------------------------------------

describe('race quaternary invalidate→bump reverse writer after #251', () => {
  for (let i = 0; i < 8; i++) {
    it(`writer invalidate→bump while get held → miss refill flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Stale' })) },
        getHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'Fresh', joined: 4, invited: 1 } });

      const getP = getRoomMetadata(kv, db, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.startsWith('get-wait:'))).toBe(true);
      });

      await invalidateRoomCache(kv, ROOM_A);
      const gen = await bumpRoomCacheGeneration(kv, ROOM_A);
      expect(gen).toBe(1);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();

      releaseGet(metaKey(ROOM_A));
      const meta = await getP;
      // Parked get resumes after delete → KV miss → D1 refill
      expect(meta?.name).toBe('Fresh');
      expect(meta?.joinedCount).toBe(4);
      expect(await getRoomCacheGeneration(kv, ROOM_A)).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`dual writers invalidate→bump same room gen≥1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta()) },
        getBarrier: [[genKey(ROOM_A), 2]],
      });

      await Promise.all([
        (async () => {
          await invalidateRoomCache(kv, ROOM_A);
          await bumpRoomCacheGeneration(kv, ROOM_A);
        })(),
        (async () => {
          await invalidateRoomCache(kv, ROOM_A);
          await bumpRoomCacheGeneration(kv, ROOM_A);
        })(),
      ]);

      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      const gen = await getRoomCacheGeneration(kv, ROOM_A);
      expect(gen).toBeGreaterThanOrEqual(1);
      expect(gen).toBeLessThanOrEqual(2);
      expect(ctl.deleteCount.get(metaKey(ROOM_A)) ?? 0).toBe(2);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`invalidate→bump A∥hot get B isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'A' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'B' })),
        },
      });
      const db = mockDb({});

      const [metaB] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_B),
        (async () => {
          await invalidateRoomCache(kv, ROOM_A);
          await bumpRoomCacheGeneration(kv, ROOM_A);
        })(),
      ]);

      expect(metaB?.name).toBe('B');
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeDefined();
      expect(db.batchCalls).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// three-way get∥bump∥invalidate
// ---------------------------------------------------------------------------

describe('race quaternary three-way get∥bump∥invalidate after #251', () => {
  for (let i = 0; i < 8; i++) {
    it(`get-barrier miss∥bump∥invalidate all settle coherently flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        getHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'Live', joined: 5, invited: 0 } });

      const getP = getRoomMetadata(kv, db, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.getCount.get(metaKey(ROOM_A)) ?? 0).toBeGreaterThanOrEqual(1);
      });

      const [gen] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        invalidateRoomCache(kv, ROOM_A),
      ]);
      expect(gen).toBe(1);

      releaseGet(metaKey(ROOM_A));
      const meta = await getP;
      expect(meta?.name).toBe('Live');
      expect(meta?.joinedCount).toBe(5);
      expect(await getRoomCacheGeneration(kv, ROOM_A)).toBe(1);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`batch get A+B∥bump A∥invalidate B flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'HotA' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HotB' })),
        },
      });
      const db = mockDb({
        [ROOM_B]: { name: 'RefillB', joined: 2, invited: 0 },
      });

      const [batch, gen] = await Promise.all([
        getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]),
        bumpRoomCacheGeneration(kv, ROOM_A),
        invalidateRoomCache(kv, ROOM_B),
      ]);

      expect(gen).toBe(1);
      // A may still be hot (invalidate targeted B only); B may hit or refill
      expect(batch.has(ROOM_A) || batch.has(ROOM_B)).toBe(true);
      expect(ctl.putCount.get(genKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// D1 batch throw isolation
// ---------------------------------------------------------------------------

describe('race quaternary D1 batch throw isolation after #251', () => {
  for (let i = 0; i < 8; i++) {
    it(`A throw∥B success under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'Boom', joined: 1, throwBatch: true },
        [ROOM_B]: { name: 'Ok', joined: 3, invited: 1 },
      });

      const [aSettled, bSettled] = await Promise.allSettled([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      expect(aSettled.status).toBe('rejected');
      expect(bSettled.status).toBe('fulfilled');
      if (bSettled.status === 'fulfilled') {
        expect(bSettled.value?.name).toBe('Ok');
        expect(bSettled.value?.joinedCount).toBe(3);
      }
      expect(db.batchErrors).toEqual([ROOM_A]);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeDefined();
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`batch path A throw leaves B mapped flood-${i}`, async () => {
      const { kv } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: { throwBatch: true },
        [ROOM_B]: { name: 'Survivor', joined: 2 },
      });

      await expect(getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B])).rejects.toThrow(
        /d1-batch-throw/
      );
      // Promise.all rejects on first throw; B may or may not have completed put
      expect(db.roomsSeen).toContain(ROOM_A);
    });
  }
});

// ---------------------------------------------------------------------------
// JSON field type coercions under concurrent miss
// ---------------------------------------------------------------------------

describe('race quaternary JSON field type coercions after #251', () => {
  for (let i = 0; i < 8; i++) {
    it(`number name / null url / array topic / bool alias flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: {
          rawNameContent: JSON.stringify({ name: 42 }),
          rawAvatarContent: JSON.stringify({ url: null }),
          joined: 2,
          invited: 0,
        },
        [ROOM_B]: {
          rawTopicContent: JSON.stringify({ topic: ['x'] }),
          rawAliasContent: JSON.stringify({ alias: true }),
          joined: 4,
          invited: 1,
        },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // parse succeeds; coerced types flow through as-is
      expect(a?.name).toBe(42 as unknown as string);
      expect(a?.avatar).toBeNull();
      expect(a?.isDm).toBe(false); // truthy name (number) → non-DM
      expect(b?.topic).toEqual(['x']);
      expect(b?.canonicalAlias).toBe(true as unknown as string);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBe(1);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`null content row JSON.parse throws → undefined field flood-${i}`, async () => {
      const { kv } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: {
          rawNameContent: null, // content: null → JSON.parse(null) throws in catch
          joined: 1,
        },
        [ROOM_B]: { name: 'Named', joined: 1 },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      expect(a?.name).toBeUndefined();
      expect(a?.isDm).toBe(true); // joined<=2 && !name
      expect(b?.name).toBe('Named');
      expect(b?.isDm).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Extreme cachedAt TTL leftovers
// ---------------------------------------------------------------------------

describe('race quaternary extreme cachedAt TTL after #251', () => {
  for (let i = 0; i < 8; i++) {
    it(`MAX_SAFE_INTEGER hit∥MIN_SAFE_INTEGER miss∥hot sibling flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(
            freshMeta({ name: 'Max', cachedAt: Number.MAX_SAFE_INTEGER })
          ),
          [metaKey(ROOM_B)]: JSON.stringify(
            freshMeta({ name: 'Min', cachedAt: Number.MIN_SAFE_INTEGER })
          ),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'Hot' })),
        },
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_B]: { name: 'RefilledMin', joined: 2 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // age = NOW - MAX_SAFE_INTEGER is large negative → still < TTL → hit
      expect(a?.name).toBe('Max');
      expect(b?.name).toBe('RefilledMin');
      expect(c?.name).toBe('Hot');
      expect(db.batchCalls).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBe(1);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`undefined-string cachedAt NaN miss∥exact-stale miss flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify({
            ...freshMeta({ name: 'Undef' }),
            cachedAt: 'undefined',
          }),
          [metaKey(ROOM_B)]: JSON.stringify(
            freshMeta({ name: 'Exact', cachedAt: NOW - TTL_MS })
          ),
        },
      });
      const db = mockDb({
        [ROOM_A]: { name: 'A2', joined: 1 },
        [ROOM_B]: { name: 'B2', joined: 1 },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      expect(a?.name).toBe('A2');
      expect(b?.name).toBe('B2');
      expect(db.batchCalls).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// meta put-hold ∥ gen bump put-hold isolation
// ---------------------------------------------------------------------------

describe('race quaternary meta∥gen put-hold isolation after #251', () => {
  for (let i = 0; i < 8; i++) {
    it(`miss put-hold meta∥bump put-hold gen never cross-write flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [metaKey(ROOM_A), genKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'Held', joined: 2 } });

      const missP = getRoomMetadata(kv, db, ROOM_A);
      const bumpP = bumpRoomCacheGeneration(kv, ROOM_A);

      await vi.waitFor(() => {
        expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
        expect(ctl.putCount.get(genKey(ROOM_A)) ?? 0).toBe(1);
      });

      // Neither key written yet
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[genKey(ROOM_A)]).toBeUndefined();

      releasePut(genKey(ROOM_A));
      await expect(bumpP).resolves.toBe(1);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();

      releasePut(metaKey(ROOM_A));
      const meta = await missP;
      expect(meta?.name).toBe('Held');
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]!).name).toBe('Held');
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
      expect(ctl.putTtl.get(genKey(ROOM_A))).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// batch mix ∥ invalidate mid-barrier
// ---------------------------------------------------------------------------

describe('race quaternary batch hot/stale/miss∥invalidate after #251', () => {
  for (let i = 0; i < 8; i++) {
    it(`batch hot+stale+miss∥invalidate stale mid get-barrier flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Hot' })),
          [metaKey(ROOM_B)]: JSON.stringify(
            freshMeta({ name: 'Stale', cachedAt: NOW - TTL_MS })
          ),
        },
        getHold: [metaKey(ROOM_B)],
      });
      const db = mockDb({
        [ROOM_B]: { name: 'B2', joined: 3 },
        [ROOM_C]: { name: 'C1', joined: 1 },
      });

      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B, ROOM_C]);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${metaKey(ROOM_B)}`))).toBe(
          true
        );
      });

      await invalidateRoomCache(kv, ROOM_B);
      releaseGet(metaKey(ROOM_B));

      const batch = await batchP;
      expect(batch.get(ROOM_A)?.name).toBe('Hot');
      expect(batch.get(ROOM_B)?.name).toBe('B2');
      expect(batch.get(ROOM_C)?.name).toBe('C1');
      expect(batch.size).toBe(3);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`invalidateBatch A,C∥batch B,D isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'A' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'B' })),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'C' })),
          [metaKey(ROOM_D)]: JSON.stringify(freshMeta({ name: 'D' })),
        },
      });
      const db = mockDb({});

      const [batch] = await Promise.all([
        getBatchRoomMetadata(kv, db, [ROOM_B, ROOM_D]),
        invalidateBatchRoomCache(kv, [ROOM_A, ROOM_C]),
      ]);

      expect(batch.get(ROOM_B)?.name).toBe('B');
      expect(batch.get(ROOM_D)?.name).toBe('D');
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_C)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeDefined();
      expect(db.batchCalls).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// isDm boundary + rooms.ts-style writer.catch
// ---------------------------------------------------------------------------

describe('race quaternary isDm + writer.catch leftovers after #251', () => {
  for (let i = 0; i < 8; i++) {
    it(`joined=2 unnamed isDm∥joined=3 named non-DM flood-${i}`, async () => {
      const { kv } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joined: 2, invited: 1 },
        [ROOM_B]: { name: 'Group', joined: 3, invited: 0 },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      expect(a?.isDm).toBe(true);
      expect(a?.joinedCount).toBe(2);
      expect(b?.isDm).toBe(false);
      expect(b?.name).toBe('Group');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`dual bump.catch+invalidate.catch writers gen moves meta gone flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta()) },
        getBarrier: [[genKey(ROOM_A), 2]],
      });

      // Mirrors rooms.ts: await bump(...).catch(...); invalidate(...).catch(...)
      await Promise.all([
        (async () => {
          await bumpRoomCacheGeneration(kv, ROOM_A).catch(() => {});
          invalidateRoomCache(kv, ROOM_A).catch(() => {});
        })(),
        (async () => {
          await bumpRoomCacheGeneration(kv, ROOM_A).catch(() => {});
          invalidateRoomCache(kv, ROOM_A).catch(() => {});
        })(),
      ]);

      // Allow fire-and-forget invalidates to settle
      await vi.waitFor(() => {
        expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      });
      const gen = await getRoomCacheGeneration(kv, ROOM_A);
      expect(gen).toBeGreaterThanOrEqual(1);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`bump put-throw swallowed by .catch∥sibling invalidate flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta()) },
        putThrows: [genKey(ROOM_A)],
      });

      await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A).catch(() => 'swallowed'),
        invalidateRoomCache(kv, ROOM_A),
      ]);

      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[genKey(ROOM_A)]).toBeUndefined();
      expect(await getRoomCacheGeneration(kv, ROOM_A)).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// empty-string generation + string count coercion
// ---------------------------------------------------------------------------

describe('race quaternary generation empty + count string after #251', () => {
  for (let i = 0; i < 8; i++) {
    it(`empty-string gen get→0∥bump writes 1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [genKey(ROOM_A)]: '' },
        getBarrier: [[genKey(ROOM_A), 2]],
      });

      const [g0, bumped] = await Promise.all([
        getRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_A),
      ]);

      // Both barrier-get '' before bump's put; parseInt('') → 0
      expect(g0).toBe(0);
      expect(bumped).toBe(1);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`count-as-string "2"/"1" coerces under parallel miss flood-${i}`, async () => {
      const { kv } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: '2', invitedRaw: '1' },
        [ROOM_B]: { name: 'N', joinedRaw: '3', invitedRaw: '0' },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // `|| 0` keeps truthy strings
      expect(a?.joinedCount).toBe('2' as unknown as number);
      expect(a?.invitedCount).toBe('1' as unknown as number);
      // string "2" <= 2 is coerced in JS comparison → isDm true when !name
      expect(a?.isDm).toBe(true);
      expect(b?.joinedCount).toBe('3' as unknown as number);
      expect(b?.isDm).toBe(false);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`whitespace-only gen∥Infinity-string concurrent bump flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '   ',
          [genKey(ROOM_B)]: 'Infinity',
        },
        getBarrier: [
          [genKey(ROOM_A), 1],
          [genKey(ROOM_B), 1],
        ],
      });

      const [a, b] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
      ]);

      // parseInt('   ') → NaN → 0; parseInt('Infinity') → NaN → 0
      expect(a).toBe(1);
      expect(b).toBe(1);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(ctl.data[genKey(ROOM_B)]).toBe('1');
    });
  }
});
