/**
 * TOKENMAXX HEAVY leftovers after #353 sexdecenary / tip #357 — septendecenary
 * room-cache *concurrent race / TOCTOU* niches not landed by sexdecenary:
 *   - joinedRaw "0" isDm∥MAX_SAFE_INTEGER non-DM∥invitedRaw ""→0
 *   - name "0" non-DM∥avatar url:"0"∥avatar {}→undefined under miss
 *   - topic -1 stored∥alias null∥alias "0"∥hot sibling
 *   - gen NEL"6"→0∥LS"6"→6∥"+-4"→0 get∥bump
 *   - meta putThrows A swallow∥bump B→1∥hot C
 *   - getHold gen A∥bump A mid∥invalidateBatch meta A∥batch hot C
 *   - getBatch putHold A∥getThrows B miss∥deleteThrows inv C∥hot then miss
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
// joinedRaw "0" / MAX_SAFE_INTEGER / invitedRaw ""
// ---------------------------------------------------------------------------

describe('race septendecenary joinedRaw "0"/MAX_SAFE + invited "" after #353', () => {
  for (let i = 0; i < 8; i++) {
    it(`"0" isDm∥MAX_SAFE non-DM∥invited ""→0 under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: '0', invitedRaw: 1 },
        [ROOM_B]: { joinedRaw: Number.MAX_SAFE_INTEGER, invitedRaw: 1 },
        [ROOM_C]: { joinedRaw: 1, invitedRaw: '' },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // '0' truthy for || 0 → stays string; '0' <= 2 → isDm
      expect(a?.joinedCount).toBe('0');
      expect(a?.isDm).toBe(true);
      // MAX_SAFE_INTEGER truthy stays; > 2 → non-DM
      expect(b?.joinedCount).toBe(Number.MAX_SAFE_INTEGER);
      expect(b?.invitedCount).toBe(1);
      expect(b?.isDm).toBe(false);
      // '' falsy → || 0 for invited
      expect(c?.joinedCount).toBe(1);
      expect(c?.invitedCount).toBe(0);
      expect(c?.isDm).toBe(true);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// name "0" / avatar url:"0" / avatar url:null
// ---------------------------------------------------------------------------

describe('race septendecenary name "0" + avatar url "0"/empty after #353', () => {
  for (let i = 0; i < 8; i++) {
    it(`name "0" non-DM∥url "0"∥avatar {} undef under miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { rawNameContent: JSON.stringify({ name: '0' }), joined: 2 },
        [ROOM_B]: { rawAvatarContent: JSON.stringify({ url: '0' }), joined: 1 },
        [ROOM_C]: { rawAvatarContent: '{}', joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // !"0" → false → non-DM; url "0" stored; {}.url → undefined
      expect(a?.name).toBe('0');
      expect(a?.isDm).toBe(false);
      expect(b?.avatar).toBe('0');
      expect(b?.isDm).toBe(true);
      expect(c?.avatar).toBeUndefined();
      expect(c?.isDm).toBe(true);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// topic -1 / alias null / alias "0" / hot sibling
// ---------------------------------------------------------------------------

describe('race septendecenary topic -1 / alias null/"0" after #353', () => {
  for (let i = 0; i < 8; i++) {
    it(`topic -1∥alias null∥alias "0"∥hot sibling flood-${i}`, async () => {
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
          rawTopicContent: JSON.stringify({ topic: -1 }),
          rawAliasContent: JSON.stringify({ alias: null }),
          joined: 1,
        },
        [ROOM_B]: { rawAliasContent: JSON.stringify({ alias: '0' }), joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      expect(a?.topic).toBe(-1);
      expect(a?.canonicalAlias).toBeNull();
      expect(a?.isDm).toBe(true);
      expect(b?.canonicalAlias).toBe('0');
      expect(b?.isDm).toBe(true);
      expect(c?.name).toBe('HotC');
      expect(db.batchCalls).toBe(2);
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Generation NEL"6" / LS"6" / "+-4"
// ---------------------------------------------------------------------------

describe('race septendecenary gen NEL/LS/plus-minus parse after #353', () => {
  for (let i = 0; i < 8; i++) {
    it(`NEL6→0∥LS6→6∥+-4→0 get∥bump flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '\u00856',
          [genKey(ROOM_B)]: '\u20286',
          [genKey(ROOM_C)]: '+-4',
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

      // parseInt(NEL+'6')=NaN→0; parseInt(LS+'6')=6; parseInt('+-4')=NaN→0
      expect(gA).toBe(0);
      expect(bA).toBe(1);
      expect(gB).toBe(6);
      expect(bB).toBe(7);
      expect(gC).toBe(0);
      expect(bC).toBe(1);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(ctl.data[genKey(ROOM_B)]).toBe('7');
      expect(ctl.data[genKey(ROOM_C)]).toBe('1');
    });
  }
});

// ---------------------------------------------------------------------------
// meta putThrows A swallow ∥ bump B → 1 ∥ hot C
// ---------------------------------------------------------------------------

describe('race septendecenary meta putThrow∥bump∥hot after #353', () => {
  for (let i = 0; i < 8; i++) {
    it(`A putThrow swallow∥bump B→1∥C hot flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'HotC' })),
        },
        putThrows: [metaKey(ROOM_A)],
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_C), 1],
          [genKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 3 },
      });

      const [a, gen, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // putThrow swallowed → metadata still returned; key absent
      expect(a?.name).toBe('FreshA');
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(gen).toBe(1);
      expect(ctl.data[genKey(ROOM_B)]).toBe('1');
      expect(c?.name).toBe('HotC');
      expect(db.batchCalls).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// getHold gen A ∥ bump A mid ∥ invalidateBatch meta A ∥ getBatch hot C
// ---------------------------------------------------------------------------

describe('race septendecenary getHold gen∥bump∥invBatch∥batch hot after #353', () => {
  for (let i = 0; i < 8; i++) {
    it(`getHold gen A∥bump mid∥invBatch meta∥batch C hot flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '4',
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StaleA' })),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'HotC' })),
        },
        getHold: [genKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 2 },
      });

      const bumpP = bumpRoomCacheGeneration(kv, ROOM_A);
      const getGenP = getRoomCacheGeneration(kv, ROOM_A);
      const invP = invalidateBatchRoomCache(kv, [ROOM_A]);
      const batchP = getBatchRoomMetadata(kv, db, [ROOM_C]);

      await vi.waitFor(() => {
        expect(
          ctl.events.filter((e) => e.includes(`get-wait:${genKey(ROOM_A)}`)).length
        ).toBeGreaterThanOrEqual(1);
      });

      const [batch] = await Promise.all([batchP, invP]);
      expect(batch.get(ROOM_C)?.name).toBe('HotC');
      expect(ctl.deleteCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);

      releaseGet(genKey(ROOM_A));
      const [genBump, genGet] = await Promise.all([bumpP, getGenP]);
      // Both held gets observe '4'; bump then writes 5
      expect(genGet).toBe(4);
      expect(genBump).toBe(5);
      expect(ctl.data[genKey(ROOM_A)]).toBe('5');
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
      expect(db.batchCalls).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// getBatch putHold A ∥ getThrows B miss ∥ deleteThrows inv C ∥ hot then
// ---------------------------------------------------------------------------

describe('race septendecenary getBatch putHold∥getThrow∥inv deleteThrow after #353', () => {
  for (let i = 0; i < 8; i++) {
    it(`batch A putHold∥B getThrow miss∥inv C deleteThrow flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        data: {
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'StaleB' })),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'StaleC' })),
        },
        putHold: [metaKey(ROOM_A)],
        getThrows: [metaKey(ROOM_B)],
        deleteThrows: [metaKey(ROOM_C)],
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 1 },
        [ROOM_B]: { name: 'FreshB', joined: 2 },
      });

      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]);
      const invP = invalidateRoomCache(kv, ROOM_C);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${metaKey(ROOM_A)}`))).toBe(true);
      });

      // getBatch returns before fire-and-forget put settles
      const map = await batchP;
      expect(map.get(ROOM_A)?.name).toBe('FreshA');
      expect(map.get(ROOM_B)?.name).toBe('FreshB');
      expect(db.batchCalls).toBe(2);
      expect(JSON.parse(ctl.data[metaKey(ROOM_B)]).name).toBe('FreshB');
      expect(ctl.putTtl.get(metaKey(ROOM_B))).toBe(TTL_SECONDS);
      // A put still held — key not written yet
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();

      const inv = await invP;
      expect(inv).toBeUndefined();
      expect(ctl.deleteCount.get(metaKey(ROOM_C)) ?? 0).toBe(1);

      releasePut(metaKey(ROOM_A));
      await vi.waitFor(() => {
        expect(ctl.data[metaKey(ROOM_A)]).toBeDefined();
      });
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('FreshA');
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});
