/**
 * TOKENMAXX HEAVY leftovers after #387 octodenary / tip f1983d3 —
 * novemdenary room-cache *concurrent race / TOCTOU* niches not landed by
 * octodenary:
 *   - joinedRaw "\t" isDm∥"1" isDm∥invitedRaw MIN_SAFE stays
 *   - name "true" non-DM∥avatar url:"true"∥avatar url:" " under miss
 *   - topic "false" stored∥alias "false"∥alias 2∥hot sibling
 *   - gen ENQ"9"→9∥"9."→9∥"7x"→7 get∥bump
 *   - meta putHold A∥gen getThrows A→0 get∥hot B
 *   - deleteHold meta A∥get A mid∥getBatch hot C
 *   - getBatch getThrows A∥putHold B∥deleteThrows inv C∥hot then miss
 *
 * Hibernation novemdenary leftovers live in call-room-hibernation.test.ts
 * and room-durable-object.test.ts (same PR). Tests-only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file
 * and the hibernation novemdenary describes.
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
// joinedRaw "\t" / "1" / invitedRaw MIN_SAFE_INTEGER
// ---------------------------------------------------------------------------

describe('race novemdenary joinedRaw tab/"1" + invited MIN_SAFE after #387', () => {
  for (let i = 0; i < 8; i++) {
    it(`tab isDm∥"1" isDm∥invited MIN_SAFE stays under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: '\t', invitedRaw: 0 },
        [ROOM_B]: { joinedRaw: '1', invitedRaw: 1 },
        [ROOM_C]: { joinedRaw: 1, invitedRaw: Number.MIN_SAFE_INTEGER },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // '\t' truthy stays; Number('\t')===0 <= 2 → isDm
      expect(a?.joinedCount).toBe('\t');
      expect(a?.isDm).toBe(true);
      // '1' truthy stays; '1' <= 2 → isDm
      expect(b?.joinedCount).toBe('1');
      expect(b?.invitedCount).toBe(1);
      expect(b?.isDm).toBe(true);
      // MIN_SAFE_INTEGER invited stays as-is
      expect(c?.joinedCount).toBe(1);
      expect(c?.invitedCount).toBe(Number.MIN_SAFE_INTEGER);
      expect(c?.isDm).toBe(true);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// name "true" / avatar url:"true" / avatar url:" "
// ---------------------------------------------------------------------------

describe('race novemdenary name "true" + avatar url "true"/" " after #387', () => {
  for (let i = 0; i < 8; i++) {
    it(`name "true" non-DM∥url "true"∥url " " under miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { rawNameContent: JSON.stringify({ name: 'true' }), joined: 2 },
        [ROOM_B]: { rawAvatarContent: JSON.stringify({ url: 'true' }), joined: 1 },
        [ROOM_C]: { rawAvatarContent: JSON.stringify({ url: ' ' }), joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // !'true' → false → non-DM; url "true"/" " stored as-is
      expect(a?.name).toBe('true');
      expect(a?.isDm).toBe(false);
      expect(b?.avatar).toBe('true');
      expect(b?.isDm).toBe(true);
      expect(c?.avatar).toBe(' ');
      expect(c?.isDm).toBe(true);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// topic "false" / alias "false" / alias 2 / hot sibling
// ---------------------------------------------------------------------------

describe('race novemdenary topic "false" / alias "false"/2 after #387', () => {
  for (let i = 0; i < 8; i++) {
    it(`topic "false"∥alias "false"∥alias 2∥hot sibling flood-${i}`, async () => {
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
          rawTopicContent: JSON.stringify({ topic: 'false' }),
          rawAliasContent: JSON.stringify({ alias: 'false' }),
          joined: 1,
        },
        [ROOM_B]: { rawAliasContent: JSON.stringify({ alias: 2 }), joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      expect(a?.topic).toBe('false');
      expect(a?.canonicalAlias).toBe('false');
      expect(a?.isDm).toBe(true);
      expect(b?.canonicalAlias).toBe(2);
      expect(b?.isDm).toBe(true);
      expect(c?.name).toBe('HotC');
      expect(db.batchCalls).toBe(2);
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Generation EN QUAD "9" / "9." / "7x"
// ---------------------------------------------------------------------------

describe('race novemdenary gen ENQ/dot/trailing-x parse after #387', () => {
  for (let i = 0; i < 8; i++) {
    it(`ENQ9→9∥9.→9∥7x→7 get∥bump flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '\u20009',
          [genKey(ROOM_B)]: '9.',
          [genKey(ROOM_C)]: '7x',
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

      // parseInt(EN QUAD+'9')=9; parseInt('9.')=9; parseInt('7x')=7
      expect(gA).toBe(9);
      expect(bA).toBe(10);
      expect(gB).toBe(9);
      expect(bB).toBe(10);
      expect(gC).toBe(7);
      expect(bC).toBe(8);
      expect(ctl.data[genKey(ROOM_A)]).toBe('10');
      expect(ctl.data[genKey(ROOM_B)]).toBe('10');
      expect(ctl.data[genKey(ROOM_C)]).toBe('8');
    });
  }
});

// ---------------------------------------------------------------------------
// meta putHold A ∥ gen getThrows A →0 get ∥ hot B
// ---------------------------------------------------------------------------

describe('race novemdenary putHold meta∥gen getThrow∥hot after #387', () => {
  for (let i = 0; i < 8; i++) {
    it(`putHold A miss-refill∥gen getThrow→0∥B hot flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        data: {
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HotB' })),
          [genKey(ROOM_A)]: '42',
        },
        getThrows: [genKey(ROOM_A)],
        putHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 3 },
      });

      const getP = getRoomMetadata(kv, db, ROOM_A);
      const genP = getRoomCacheGeneration(kv, ROOM_A);
      const hotP = getRoomMetadata(kv, db, ROOM_B);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${metaKey(ROOM_A)}`))).toBe(true);
      });

      const [gen, b] = await Promise.all([genP, hotP]);
      // getThrows on gen → 0; B stays hot while A put is held
      expect(gen).toBe(0);
      expect(b?.name).toBe('HotB');
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBe(0);

      releasePut(metaKey(ROOM_A));
      const a = await getP;
      expect(a?.name).toBe('FreshA');
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('FreshA');
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
      expect(db.batchCalls).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// deleteHold meta A ∥ get A mid ∥ getBatch hot C
// ---------------------------------------------------------------------------

describe('race novemdenary deleteHold∥get mid∥batch hot after #387', () => {
  for (let i = 0; i < 8; i++) {
    it(`deleteHold A inv∥get mid sees stale∥batch C hot flood-${i}`, async () => {
      const { kv, ctl, releaseDelete } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'StaleA' })),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'HotC' })),
        },
        deleteHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 2 },
      });

      const invP = invalidateRoomCache(kv, ROOM_A);
      const getP = getRoomMetadata(kv, db, ROOM_A);
      const batchP = getBatchRoomMetadata(kv, db, [ROOM_C]);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`delete-wait:${metaKey(ROOM_A)}`))).toBe(true);
      });

      // While delete is held, get/batch may still see A as hot; C stays hot
      const batch = await batchP;
      expect(batch.get(ROOM_C)?.name).toBe('HotC');
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);

      releaseDelete(metaKey(ROOM_A));
      await invP;
      const a = await getP;
      // After delete releases: get may have hit stale mid-hold or missed→FreshA
      expect(['StaleA', 'FreshA']).toContain(a?.name);
      expect(ctl.deleteCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
      expect(db.batchCalls).toBeLessThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// getBatch getThrows A ∥ putHold B ∥ deleteThrows inv C
// ---------------------------------------------------------------------------

describe('race novemdenary getBatch getThrow∥putHold∥inv deleteThrow after #387', () => {
  for (let i = 0; i < 8; i++) {
    it(`batch A getThrow miss∥B putHold∥C inv deleteThrow flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        data: {
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'StaleC' })),
        },
        getThrows: [metaKey(ROOM_A)],
        putHold: [metaKey(ROOM_B)],
        deleteThrows: [metaKey(ROOM_C)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 2 },
        [ROOM_B]: { name: 'FreshB', joined: 2 },
      });

      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B, ROOM_C]);
      const invP = invalidateRoomCache(kv, ROOM_C).then(
        () => ({ ok: true as const }),
        (e: Error) => ({ ok: false as const, message: e.message })
      );

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${metaKey(ROOM_B)}`))).toBe(true);
      });

      // inv deleteThrow swallows (invalidateRoomCache catches); C may still be hot in batch
      const invSettled = await invP;
      // deleteThrows is thrown from kv.delete — invalidateRoomCache catches it
      expect(invSettled.ok).toBe(true);
      expect(ctl.deleteCount.get(metaKey(ROOM_C)) ?? 0).toBe(1);
      // StaleC remains because delete threw before removing
      expect(ctl.data[metaKey(ROOM_C)]).toBeDefined();

      // getBatch returns before fire-and-forget put settles
      const map = await batchP;
      expect(map.get(ROOM_A)?.name).toBe('FreshA');
      expect(map.get(ROOM_B)?.name).toBe('FreshB');
      // C was hot at cache-check time (before/despite failed delete)
      expect(map.get(ROOM_C)?.name).toBe('StaleC');
      expect(db.batchCalls).toBe(2);
      // B put still held — key not written yet
      expect(ctl.data[metaKey(ROOM_B)]).toBeUndefined();
      expect(ctl.putTtl.get(metaKey(ROOM_B))).toBe(TTL_SECONDS);

      releasePut(metaKey(ROOM_B));
      await vi.waitFor(() => {
        expect(ctl.data[metaKey(ROOM_B)]).toBeDefined();
      });
      expect(JSON.parse(ctl.data[metaKey(ROOM_B)]).name).toBe('FreshB');
    });
  }
});
