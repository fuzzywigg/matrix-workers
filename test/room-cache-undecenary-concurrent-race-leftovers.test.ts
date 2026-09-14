/**
 * TOKENMAXX HEAVY leftovers after #296 denary — undecenary room-cache
 * *concurrent race / TOCTOU* niches not landed by denary:
 *   - joinedRaw NaN→0∥[] stays array isDm∥{} NaN-compare non-DM
 *   - name content 0 / nested object / avatar url:null under miss
 *   - cachedAt Date(0) miss∥numeric-string NOW hit∥hot sibling
 *   - gen 0b10 / 0o17 parseInt→0 get∥bump
 *   - meta put-hold∥gen put-hold key isolation
 *   - getBatch get-hold mid invalidate deleteThrows still refill
 *   - name JSON "42" no-throw undefined∥topic nested ignore
 *
 * Hibernation undecenary leftovers live in call-room-hibernation.test.ts
 * and room-durable-object.test.ts (same PR). Tests-only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file
 * and the hibernation undecenary describes.
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
// joinedRaw NaN→0; [] stays; {} NaN-compare → non-DM
// ---------------------------------------------------------------------------

describe('race undecenary joinedRaw NaN/[]/{} after #296 denary', () => {
  for (let i = 0; i < 8; i++) {
    it(`NaN→0∥[] truthy isDm∥{} non-DM under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: Number.NaN, invitedRaw: 1 },
        [ROOM_B]: { joinedRaw: [], invitedRaw: 0 },
        [ROOM_C]: { joinedRaw: {}, invitedRaw: 0 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // NaN is falsy → || 0; [] truthy stays; {} truthy stays
      expect(a?.joinedCount).toBe(0);
      expect(a?.invitedCount).toBe(1);
      expect(a?.isDm).toBe(true);
      expect(Array.isArray(b?.joinedCount)).toBe(true);
      expect(b?.isDm).toBe(true); // Number([])=0 <= 2 && !name
      expect(c?.joinedCount).toEqual({});
      // Number({})=NaN; NaN <= 2 → false → non-DM
      expect(c?.isDm).toBe(false);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// State content: name 0 / nested name / avatar url:null / JSON "42"
// ---------------------------------------------------------------------------

describe('race undecenary name/avatar content leftovers after #296', () => {
  for (let i = 0; i < 8; i++) {
    it(`name 0 isDm∥nested name non-DM∥url null under miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { rawNameContent: JSON.stringify({ name: 0 }), joined: 2 },
        [ROOM_B]: { rawNameContent: JSON.stringify({ name: { x: 1 } }), joined: 2 },
        [ROOM_C]: { rawAvatarContent: JSON.stringify({ url: null }), joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // !0 → true → isDm; !{x:1} → false → non-DM; url null stored as-is
      expect(a?.name).toBe(0);
      expect(a?.isDm).toBe(true);
      expect(b?.name).toEqual({ x: 1 });
      expect(b?.isDm).toBe(false);
      expect(c?.avatar).toBeNull();
      expect(c?.isDm).toBe(true);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`name JSON 42 no-throw undefined∥topic nested ignore flood-${i}`, async () => {
      const { kv } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { rawNameContent: '42', joined: 1 },
        [ROOM_B]: { rawTopicContent: JSON.stringify({ topic: { nested: true } }), joined: 1 },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // (42).name → undefined (no throw); nested topic object stored
      expect(a?.name).toBeUndefined();
      expect(a?.isDm).toBe(true);
      expect(b?.topic).toEqual({ nested: true });
    });
  }
});

// ---------------------------------------------------------------------------
// cachedAt Date(0) miss∥numeric-string NOW hit
// ---------------------------------------------------------------------------

describe('race undecenary Date/string cachedAt TTL after #296', () => {
  for (let i = 0; i < 8; i++) {
    it(`Date(0) miss→D1∥string NOW hit∥hot sibling flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        jsonOverlay: {
          [metaKey(ROOM_A)]: {
            name: 'EpochDate',
            joinedCount: 9,
            invitedCount: 0,
            isDm: false,
            cachedAt: new Date(0),
          },
          [metaKey(ROOM_B)]: {
            name: 'StrClock',
            joinedCount: 2,
            invitedCount: 0,
            isDm: true,
            cachedAt: String(NOW),
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
        [ROOM_A]: { name: 'FromD1', joined: 3 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // NOW - Date(0) ≈ NOW ≥ TTL → miss; NOW - "NOW" = 0 → hit
      expect(a?.name).toBe('FromD1');
      expect(b?.name).toBe('StrClock');
      expect(c?.name).toBe('HotC');
      expect(db.batchCalls).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Generation 0b10 / 0o17 → parseInt → 0
// ---------------------------------------------------------------------------

describe('race undecenary gen 0b/0o parse after #296', () => {
  for (let i = 0; i < 8; i++) {
    it(`0b10→0∥0o17→0 get∥bump flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '0b10',
          [genKey(ROOM_B)]: '0o17',
        },
        getBarrier: [
          [genKey(ROOM_A), 2],
          [genKey(ROOM_B), 2],
        ],
      });

      const [gA, bA, gB, bB] = await Promise.all([
        getRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_B),
        bumpRoomCacheGeneration(kv, ROOM_B),
      ]);

      // parseInt stops at non-digit after 0 → 0
      expect(gA).toBe(0);
      expect(bA).toBe(1);
      expect(gB).toBe(0);
      expect(bB).toBe(1);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(ctl.data[genKey(ROOM_B)]).toBe('1');
    });
  }
});

// ---------------------------------------------------------------------------
// Meta put-hold ∥ gen put-hold key isolation
// ---------------------------------------------------------------------------

describe('race undecenary meta∥gen put-hold isolation after #296', () => {
  for (let i = 0; i < 8; i++) {
    it(`gen resolves while meta put held; both fill after release flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [metaKey(ROOM_A), genKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'HoldA', joined: 2 },
      });

      let genSettled = false;
      const getP = getRoomMetadata(kv, db, ROOM_A);
      const bumpP = bumpRoomCacheGeneration(kv, ROOM_A).then((g) => {
        genSettled = true;
        return g;
      });

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${metaKey(ROOM_A)}`))).toBe(true);
        expect(ctl.events.some((e) => e.includes(`put-wait:${genKey(ROOM_A)}`))).toBe(true);
      });

      // Release gen first — bump completes while meta still held
      releasePut(genKey(ROOM_A));
      const gen = await bumpP;
      expect(gen).toBe(1);
      expect(genSettled).toBe(true);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();

      releasePut(metaKey(ROOM_A));
      const a = await getP;
      expect(a?.name).toBe('HoldA');
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('HoldA');
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
      expect(ctl.putTtl.get(genKey(ROOM_A))).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// getBatch get-hold mid invalidate deleteThrows → still refills from D1
// ---------------------------------------------------------------------------

describe('race undecenary batch get-hold∥deleteThrows invalidate after #296', () => {
  for (let i = 0; i < 8; i++) {
    it(`stale overlay deleted-fail still D1 refill after release flood-${i}`, async () => {
      const { kv, ctl, releaseGet } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StaleA' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HotB' })),
        },
        getHold: [metaKey(ROOM_A)],
        deleteThrows: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 4 },
      });

      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B]);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${metaKey(ROOM_A)}`))).toBe(true);
      });

      // invalidate swallows deleteThrows; stale key remains until get sees it
      await invalidateRoomCache(kv, ROOM_A);
      expect(ctl.data[metaKey(ROOM_A)]).toBeDefined();
      expect(ctl.deleteCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);

      // Drop KV entry before releasing get so held reader observes miss
      delete ctl.data[metaKey(ROOM_A)];
      releaseGet(metaKey(ROOM_A));
      const map = await batchP;

      expect(map.get(ROOM_A)?.name).toBe('FreshA');
      expect(map.get(ROOM_B)?.name).toBe('HotB');
      expect(db.batchCalls).toBe(1);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});
