/**
 * TOKENMAXX HEAVY leftovers after #325 quattuordecenary / tip #330 — sexdecenary
 * room-cache *concurrent race / TOCTOU* niches not landed by quattuordecenary
 * (and disjoint from open quindecenary #332):
 *   - joinedRaw EPSILON isDm∥MAX_VALUE non-DM∥invitedRaw "0" stays
 *   - name null→isDm∥avatar url:-1∥avatar url:1 under miss
 *   - topic 1 stored∥topic "" stored∥alias -1∥hot sibling
 *   - gen FF"5"→5∥"3 "→3∥"-2"→-2 get∥bump
 *   - gen putThrows bump A reject∥meta miss-refill A∥hot B
 *   - getHold meta A∥bump A mid∥invalidateBatch A mid∥batch hot C
 *   - getBatch putThrows A∥getThrows B miss∥hot C∥deleteThrows inv A
 *
 * Room-cache niche only (no hibernation invent). Tests/CI only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file.
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
// joinedRaw EPSILON / MAX_VALUE / invitedRaw "0"
// ---------------------------------------------------------------------------

describe('race sexdecenary joinedRaw EPSILON/MAX + invited "0" after #325', () => {
  for (let i = 0; i < 8; i++) {
    it(`EPSILON isDm∥MAX_VALUE non-DM∥invited "0" stays under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: Number.EPSILON, invitedRaw: 0 },
        [ROOM_B]: { joinedRaw: Number.MAX_VALUE, invitedRaw: 1 },
        [ROOM_C]: { joinedRaw: 1, invitedRaw: '0' },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // EPSILON truthy stays; EPSILON <= 2 → isDm
      expect(a?.joinedCount).toBe(Number.EPSILON);
      expect(a?.isDm).toBe(true);
      // MAX_VALUE truthy stays; MAX_VALUE <= 2 → false → non-DM
      expect(b?.joinedCount).toBe(Number.MAX_VALUE);
      expect(b?.invitedCount).toBe(1);
      expect(b?.isDm).toBe(false);
      // '0' truthy for || 0 → stays string '0'
      expect(c?.joinedCount).toBe(1);
      expect(c?.invitedCount).toBe('0');
      expect(c?.isDm).toBe(true);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// name null / avatar url:-1 / avatar url:1
// ---------------------------------------------------------------------------

describe('race sexdecenary name null + avatar url -1/1 after #325', () => {
  for (let i = 0; i < 8; i++) {
    it(`name null isDm∥url -1∥url 1 under miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { rawNameContent: JSON.stringify({ name: null }), joined: 2 },
        [ROOM_B]: { rawAvatarContent: JSON.stringify({ url: -1 }), joined: 1 },
        [ROOM_C]: { rawAvatarContent: JSON.stringify({ url: 1 }), joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // !null → true → isDm; url -1/1 stored as-is
      expect(a?.name).toBeNull();
      expect(a?.isDm).toBe(true);
      expect(b?.avatar).toBe(-1);
      expect(b?.isDm).toBe(true);
      expect(c?.avatar).toBe(1);
      expect(c?.isDm).toBe(true);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// topic 1 / topic "" / alias -1 / hot sibling
// ---------------------------------------------------------------------------

describe('race sexdecenary topic 1/"" / alias -1 after #325', () => {
  for (let i = 0; i < 8; i++) {
    it(`topic 1∥topic ""∥alias -1∥hot sibling flood-${i}`, async () => {
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
          rawTopicContent: JSON.stringify({ topic: 1 }),
          rawAliasContent: JSON.stringify({ alias: -1 }),
          joined: 1,
        },
        [ROOM_B]: { rawTopicContent: JSON.stringify({ topic: '' }), joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      expect(a?.topic).toBe(1);
      expect(a?.canonicalAlias).toBe(-1);
      expect(a?.isDm).toBe(true);
      expect(b?.topic).toBe('');
      expect(b?.isDm).toBe(true);
      expect(c?.name).toBe('HotC');
      expect(db.batchCalls).toBe(2);
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Generation FF"5" / "3 " / "-2"
// ---------------------------------------------------------------------------

describe('race sexdecenary gen FF/trailing-ws/negative parse after #325', () => {
  for (let i = 0; i < 8; i++) {
    it(`FF5→5∥3␠→3∥-2→-2 get∥bump flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '\f5',
          [genKey(ROOM_B)]: '3 ',
          [genKey(ROOM_C)]: '-2',
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

      // parseInt(FF+'5')=5; parseInt('3 ')=3; parseInt('-2')=-2
      expect(gA).toBe(5);
      expect(bA).toBe(6);
      expect(gB).toBe(3);
      expect(bB).toBe(4);
      expect(gC).toBe(-2);
      expect(bC).toBe(-1);
      expect(ctl.data[genKey(ROOM_A)]).toBe('6');
      expect(ctl.data[genKey(ROOM_B)]).toBe('4');
      expect(ctl.data[genKey(ROOM_C)]).toBe('-1');
    });
  }
});

// ---------------------------------------------------------------------------
// gen putThrows bump A reject ∥ meta miss-refill A ∥ hot B
// ---------------------------------------------------------------------------

describe('race sexdecenary gen putThrow∥miss-refill∥hot after #325', () => {
  for (let i = 0; i < 8; i++) {
    it(`bump putThrow rejects∥A refills FreshA∥B hot flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HotB' })),
        },
        putThrows: [genKey(ROOM_A)],
        getThrows: [metaKey(ROOM_A)],
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [genKey(ROOM_A), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 3 },
      });

      const [bumpSettled, a, b] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A).then(
          (v) => ({ ok: true as const, v }),
          (e: Error) => ({ ok: false as const, message: e.message })
        ),
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      expect(bumpSettled.ok).toBe(false);
      if (!bumpSettled.ok) {
        expect(bumpSettled.message).toMatch(/kv-put-throw/);
      }
      expect(a?.name).toBe('FreshA');
      expect(b?.name).toBe('HotB');
      expect(db.batchCalls).toBe(1);
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('FreshA');
      expect(ctl.data[genKey(ROOM_A)]).toBeUndefined();
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBe(0);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// getHold meta A ∥ bump A mid ∥ invalidateBatch A mid ∥ getBatch hot C
// ---------------------------------------------------------------------------

describe('race sexdecenary getHold∥bump∥invBatch∥batch hot after #325', () => {
  for (let i = 0; i < 8; i++) {
    it(`getHold A∥bump+invBatch mid∥batch C hot isolation flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StaleA' })),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'HotC' })),
        },
        getHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 2 },
      });

      const getP = getRoomMetadata(kv, db, ROOM_A);
      const bumpP = bumpRoomCacheGeneration(kv, ROOM_A);
      const invP = invalidateBatchRoomCache(kv, [ROOM_A]);
      const batchP = getBatchRoomMetadata(kv, db, [ROOM_C]);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${metaKey(ROOM_A)}`))).toBe(true);
      });

      const [gen, , batch] = await Promise.all([bumpP, invP, batchP]);
      expect(gen).toBe(1);
      expect(batch.get(ROOM_C)?.name).toBe('HotC');
      // delete from invalidate may have dropped stale before get resumes
      expect(ctl.deleteCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);

      releaseGet(metaKey(ROOM_A));
      const a = await getP;
      // After release: either hot stale hit (if delete raced after get read)
      // or miss→D1 FreshA. Pin allowed outcomes under TOCTOU.
      expect(['StaleA', 'FreshA']).toContain(a?.name);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
      expect(db.batchCalls).toBeLessThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// getBatch putThrows A ∥ getThrows B miss ∥ hot C ∥ deleteThrows inv A
// ---------------------------------------------------------------------------

describe('race sexdecenary getBatch putThrow∥getThrow∥hot∥inv after #325', () => {
  for (let i = 0; i < 8; i++) {
    it(`batch A putThrow swallow∥B getThrow miss∥C hot∥inv deleteThrow flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'StaleB' })),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'HotC' })),
        },
        putThrows: [metaKey(ROOM_A)],
        getThrows: [metaKey(ROOM_B)],
        deleteThrows: [metaKey(ROOM_A)],
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
        invalidateRoomCache(kv, ROOM_A),
      ]);

      expect(inv).toBeUndefined();
      expect(map.get(ROOM_A)?.name).toBe('FreshA');
      expect(map.get(ROOM_B)?.name).toBe('FreshB');
      expect(map.get(ROOM_C)?.name).toBe('HotC');
      expect(db.batchCalls).toBe(2);
      // A putThrow → no cache write; deleteThrow left key absent or prior
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(JSON.parse(ctl.data[metaKey(ROOM_B)]).name).toBe('FreshB');
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
      expect(ctl.putTtl.get(metaKey(ROOM_B))).toBe(TTL_SECONDS);
      expect(ctl.deleteCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});
