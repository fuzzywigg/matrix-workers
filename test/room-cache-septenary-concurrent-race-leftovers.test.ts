/**
 * TOKENMAXX HEAVY leftovers after #273/#276 + senary — septenary room-cache
 * *concurrent race / TOCTOU* niches not covered by prior waves or senary
 * (true invitedRaw, falsy name 0/false isDm, BigInt/array-own-cachedAt
 * overlays, gen 0e0/8./+1, triple invalidate mid getBatch).
 *
 * Hibernation septenary leftovers live in call-room-hibernation.test.ts
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
// invitedRaw: true (senary only did joinedRaw true)
// ---------------------------------------------------------------------------

describe('race septenary invitedRaw true coercion after #273 senary', () => {
  for (let i = 0; i < 8; i++) {
    it(`invitedRaw true∥joinedRaw false under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: 2, invitedRaw: true },
        [ROOM_B]: { joinedRaw: false, invitedRaw: true },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      expect(a?.invitedCount).toBe(true);
      expect(a?.joinedCount).toBe(2);
      expect(a?.isDm).toBe(true);
      expect(b?.joinedCount).toBe(0); // false || 0
      expect(b?.invitedCount).toBe(true);
      expect(b?.isDm).toBe(true);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// Falsy non-string name 0 / false → isDm (quaternary had truthy number name)
// ---------------------------------------------------------------------------

describe('race septenary falsy name 0/false isDm after #273 senary', () => {
  for (let i = 0; i < 8; i++) {
    it(`name 0∥false → isDm under parallel miss flood-${i}`, async () => {
      const { kv } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: {
          rawNameContent: JSON.stringify({ name: 0 }),
          joined: 2,
        },
        [ROOM_B]: {
          rawNameContent: JSON.stringify({ name: false }),
          joined: 1,
        },
        [ROOM_C]: {
          rawNameContent: JSON.stringify({ name: 'Named' }),
          joined: 2,
        },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // falsy name → !name true → isDm
      expect(a?.name).toBe(0);
      expect(a?.isDm).toBe(true);
      expect(b?.name).toBe(false);
      expect(b?.isDm).toBe(true);
      expect(c?.name).toBe('Named');
      expect(c?.isDm).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// BigInt cachedAt throw → miss; array-with-own-cachedAt false hit
// ---------------------------------------------------------------------------

describe('race septenary BigInt/array-own-cachedAt overlay after #273 senary', () => {
  for (let i = 0; i < 8; i++) {
    it(`BigInt cachedAt throw→D1∥array-own-cachedAt false hit flood-${i}`, async () => {
      const arrayHit = Object.assign([], {
        name: 'ArrHit',
        joinedCount: 2,
        invitedCount: 0,
        isDm: true,
        cachedAt: NOW,
      });
      const { kv, ctl } = createRacingKv({
        jsonOverlay: {
          [metaKey(ROOM_A)]: {
            name: 'Big',
            joinedCount: 1,
            invitedCount: 0,
            isDm: true,
            cachedAt: 1n,
          },
          [metaKey(ROOM_B)]: arrayHit,
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
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // Date.now() - 1n throws → catch → D1 refill
      expect(a?.name).toBe('A2');
      // array with own cachedAt fresh → returned as-is (false hit)
      expect(Array.isArray(b)).toBe(true);
      expect((b as unknown as { name: string }).name).toBe('ArrHit');
      expect(c?.name).toBe('HotC');
      expect(db.batchCalls).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Generation "0e0" / "8." / "+1"
// ---------------------------------------------------------------------------

describe('race septenary gen 0e0/8./+1 get∥bump after #273 senary', () => {
  for (let i = 0; i < 8; i++) {
    it(`0e0→0∥8.→8∥+1→1 get∥bump flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '0e0',
          [genKey(ROOM_B)]: '8.',
          [genKey(ROOM_C)]: '+1',
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

      expect(gA).toBe(0); // parseInt('0e0')→0
      expect(bA).toBe(1);
      expect(gB).toBe(8); // parseInt('8.')→8
      expect(bB).toBe(9);
      expect(gC).toBe(1); // parseInt('+1')→1
      expect(bC).toBe(2);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(ctl.data[genKey(ROOM_B)]).toBe('9');
      expect(ctl.data[genKey(ROOM_C)]).toBe('2');
    });
  }
});

// ---------------------------------------------------------------------------
// Triple invalidate mid getBatch get-hold
// ---------------------------------------------------------------------------

describe('race septenary triple invalidate mid getBatch after #273 senary', () => {
  for (let i = 0; i < 8; i++) {
    it(`invalidate×3 mid get-hold A∥hot B refill A flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StaleA' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HotB' })),
        },
        getHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 4 },
      });

      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${metaKey(ROOM_A)}`))).toBe(
          true
        );
      });

      await Promise.all([
        invalidateRoomCache(kv, ROOM_A),
        invalidateRoomCache(kv, ROOM_A),
        invalidateRoomCache(kv, ROOM_A),
      ]);
      releaseGet(metaKey(ROOM_A));

      const batch = await batchP;
      expect(batch.get(ROOM_A)?.name).toBe('FreshA');
      expect(batch.get(ROOM_B)?.name).toBe('HotB');
      expect(ctl.deleteCount.get(metaKey(ROOM_A)) ?? 0).toBe(3);
      expect(db.batchCalls).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Octonary deepen (same PR): nested avatar + missing-count-row ∥ hot sibling
// ---------------------------------------------------------------------------

describe('race octonary nested avatar + missing count row after #281', () => {
  for (let i = 0; i < 8; i++) {
    it(`nested avatar url∥missing joined row→0∥hot sibling flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'CachedC' })),
        },
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = {
        batchCalls: 0,
        prepare(_sql: string) {
          return {
            bind(roomId: string) {
              return { _roomId: roomId };
            },
          };
        },
        batch: vi.fn(async (stmts: Array<{ _roomId: string }>) => {
          db.batchCalls += 1;
          const roomId = stmts[0]?._roomId ?? '';
          if (roomId === ROOM_A) {
            return [
              { results: [] },
              { results: [{ content: JSON.stringify({ url: { nested: true } }) }] },
              { results: [] },
              { results: [] },
              { results: [{ count: 2 }] },
              { results: [{ count: 0 }] },
            ];
          }
          // ROOM_B: missing joined count row → undefined?.count || 0
          return [
            { results: [] },
            { results: [] },
            { results: [] },
            { results: [] },
            { results: [] },
            { results: [{ count: 3 }] },
          ];
        }),
      } as unknown as D1Database & { batchCalls: number };

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      expect(a?.avatar).toEqual({ nested: true });
      expect(a?.joinedCount).toBe(2);
      expect(b?.joinedCount).toBe(0);
      expect(b?.invitedCount).toBe(3);
      expect(b?.isDm).toBe(true);
      expect(c?.name).toBe('CachedC');
      expect(db.batchCalls).toBe(2);
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Nonary deepen (same PR): empty-string / whitespace count coercions
// ---------------------------------------------------------------------------

describe('race nonary empty-string/whitespace count coercions after #281', () => {
  for (let i = 0; i < 8; i++) {
    it(`joinedRaw ''→0∥invitedRaw ' ' truthy under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: '', invitedRaw: 2 },
        [ROOM_B]: { joinedRaw: 1, invitedRaw: ' ' },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // '' || 0 → 0; ' ' || 0 → ' ' (truthy whitespace string)
      expect(a?.joinedCount).toBe(0);
      expect(a?.invitedCount).toBe(2);
      expect(a?.isDm).toBe(true);
      expect(b?.joinedCount).toBe(1);
      expect(b?.invitedCount).toBe(' ');
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});
