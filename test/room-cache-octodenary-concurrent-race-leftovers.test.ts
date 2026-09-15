/**
 * TOKENMAXX HEAVY leftovers after #380 septendecenary / tip 320fea0 —
 * octodenary room-cache *concurrent race / TOCTOU* niches not landed by
 * septendecenary (relaunch of closed #379 tip-conflict after #380):
 *   - joinedRaw " " isDm∥MIN_SAFE_INTEGER isDm∥invitedRaw MAX_SAFE stays
 *   - name "false" non-DM∥avatar url:2∥avatar url:"false" under miss
 *   - topic "0" stored∥alias ""∥alias 1∥hot sibling
 *   - gen PS"7"→7∥" 8"→8∥"++9"→0 get∥bump
 *   - gen getThrows A→0 bump∥meta miss-refill A∥hot B
 *   - putHold meta A∥invalidate A mid∥getBatch hot C
 *   - getBatch getHold A∥putThrows B∥deleteHold inv C∥hot then miss
 *
 * Hibernation octodenary leftovers live in call-room-hibernation.test.ts
 * and room-durable-object.test.ts (same PR). Tests-only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file
 * and the hibernation octodenary describes.
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
// joinedRaw " " / MIN_SAFE_INTEGER / invitedRaw MAX_SAFE_INTEGER
// ---------------------------------------------------------------------------

describe('race octodenary joinedRaw space/MIN_SAFE + invited MAX_SAFE after #380', () => {
  for (let i = 0; i < 8; i++) {
    it(`space isDm∥MIN_SAFE isDm∥invited MAX_SAFE stays under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: ' ', invitedRaw: 0 },
        [ROOM_B]: { joinedRaw: Number.MIN_SAFE_INTEGER, invitedRaw: 1 },
        [ROOM_C]: { joinedRaw: 1, invitedRaw: Number.MAX_SAFE_INTEGER },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // ' ' truthy stays; Number(' ')===0 <= 2 → isDm
      expect(a?.joinedCount).toBe(' ');
      expect(a?.isDm).toBe(true);
      // MIN_SAFE_INTEGER truthy stays; value <= 2 → isDm
      expect(b?.joinedCount).toBe(Number.MIN_SAFE_INTEGER);
      expect(b?.invitedCount).toBe(1);
      expect(b?.isDm).toBe(true);
      // MAX_SAFE_INTEGER invited stays as-is
      expect(c?.joinedCount).toBe(1);
      expect(c?.invitedCount).toBe(Number.MAX_SAFE_INTEGER);
      expect(c?.isDm).toBe(true);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// name true / avatar url:"" / avatar url:false
// ---------------------------------------------------------------------------

describe('race octodenary name "false" + avatar url 2/"false" after #380', () => {
  for (let i = 0; i < 8; i++) {
    it(`name "false" non-DM∥url 2∥url "false" under miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { rawNameContent: JSON.stringify({ name: 'false' }), joined: 2 },
        [ROOM_B]: { rawAvatarContent: JSON.stringify({ url: 2 }), joined: 1 },
        [ROOM_C]: { rawAvatarContent: JSON.stringify({ url: 'false' }), joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // !'false' → false → non-DM; url 2/"false" stored as-is
      expect(a?.name).toBe('false');
      expect(a?.isDm).toBe(false);
      expect(b?.avatar).toBe(2);
      expect(b?.isDm).toBe(true);
      expect(c?.avatar).toBe('false');
      expect(c?.isDm).toBe(true);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// topic "0" / alias "" / alias true / hot sibling
// ---------------------------------------------------------------------------

describe('race octodenary topic "0" / alias ""/1 after #380', () => {
  for (let i = 0; i < 8; i++) {
    it(`topic "0"∥alias ""∥alias 1∥hot sibling flood-${i}`, async () => {
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
          rawTopicContent: JSON.stringify({ topic: '0' }),
          rawAliasContent: JSON.stringify({ alias: '' }),
          joined: 1,
        },
        [ROOM_B]: { rawAliasContent: JSON.stringify({ alias: 1 }), joined: 1 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      expect(a?.topic).toBe('0');
      expect(a?.canonicalAlias).toBe('');
      expect(a?.isDm).toBe(true);
      expect(b?.canonicalAlias).toBe(1);
      expect(b?.isDm).toBe(true);
      expect(c?.name).toBe('HotC');
      expect(db.batchCalls).toBe(2);
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Generation PS"7" / " 8" / "++9"
// ---------------------------------------------------------------------------

describe('race octodenary gen PS/leading-ws/plus-plus parse after #380', () => {
  for (let i = 0; i < 8; i++) {
    it(`PS7→7∥␠8→8∥++9→0 get∥bump flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '\u20297',
          [genKey(ROOM_B)]: ' 8',
          [genKey(ROOM_C)]: '++9',
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

      // parseInt(PS+'7')=7 (PS is WS); parseInt(' 8')=8; parseInt('++9')=NaN→0
      expect(gA).toBe(7);
      expect(bA).toBe(8);
      expect(gB).toBe(8);
      expect(bB).toBe(9);
      expect(gC).toBe(0);
      expect(bC).toBe(1);
      expect(ctl.data[genKey(ROOM_A)]).toBe('8');
      expect(ctl.data[genKey(ROOM_B)]).toBe('9');
      expect(ctl.data[genKey(ROOM_C)]).toBe('1');
    });
  }
});

// ---------------------------------------------------------------------------
// gen getThrows A →0 bump ∥ meta miss-refill A ∥ hot B
// ---------------------------------------------------------------------------

describe('race octodenary gen getThrow∥miss-refill∥hot after #380', () => {
  for (let i = 0; i < 8; i++) {
    it(`bump getThrow→1∥A refills FreshA∥B hot flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HotB' })),
          [genKey(ROOM_A)]: '99',
        },
        getThrows: [genKey(ROOM_A), metaKey(ROOM_A)],
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [genKey(ROOM_A), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 3 },
      });

      const [gen, a, b] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // getThrows on gen → treat as 0 → bump writes 1
      expect(gen).toBe(1);
      expect(a?.name).toBe('FreshA');
      expect(b?.name).toBe('HotB');
      expect(db.batchCalls).toBe(1);
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('FreshA');
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBe(0);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// putHold meta A ∥ invalidate A mid ∥ getBatch hot C
// ---------------------------------------------------------------------------

describe('race octodenary putHold∥inv mid∥batch hot after #380', () => {
  for (let i = 0; i < 8; i++) {
    it(`putHold A miss-refill∥inv mid∥batch C hot isolation flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        data: {
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'HotC' })),
        },
        putHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 2 },
      });

      const getP = getRoomMetadata(kv, db, ROOM_A);
      const invP = invalidateRoomCache(kv, ROOM_A);
      const batchP = getBatchRoomMetadata(kv, db, [ROOM_C]);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${metaKey(ROOM_A)}`))).toBe(true);
      });

      const [, batch] = await Promise.all([invP, batchP]);
      expect(batch.get(ROOM_C)?.name).toBe('HotC');
      expect(ctl.deleteCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);

      releasePut(metaKey(ROOM_A));
      const a = await getP;
      expect(a?.name).toBe('FreshA');
      // After release, put may rewrite FreshA even if delete raced mid-hold
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('FreshA');
      expect(ctl.putCount.get(metaKey(ROOM_C)) ?? 0).toBe(0);
      expect(db.batchCalls).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// getBatch getHold A ∥ putThrows B ∥ deleteHold inv C
// ---------------------------------------------------------------------------

describe('race octodenary getBatch getHold∥putThrow∥inv deleteHold after #380', () => {
  for (let i = 0; i < 8; i++) {
    it(`batch A getHold hot∥B putThrow miss∥C inv deleteHold flood-${i}`, async () => {
      const { kv, ctl, releaseGet, releaseDelete } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'HotA' })),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'StaleC' })),
        },
        putThrows: [metaKey(ROOM_B)],
        getHold: [metaKey(ROOM_A)],
        deleteHold: [metaKey(ROOM_C)],
      });
      const db = mockDb({
        [ROOM_B]: { name: 'FreshB', joined: 2 },
      });

      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_B, ROOM_C]);
      const invP = invalidateRoomCache(kv, ROOM_C);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${metaKey(ROOM_A)}`))).toBe(true);
        expect(ctl.events.some((e) => e.includes(`delete-wait:${metaKey(ROOM_C)}`))).toBe(true);
      });

      releaseGet(metaKey(ROOM_A));
      const map = await batchP;
      expect(map.get(ROOM_A)?.name).toBe('HotA');
      expect(map.get(ROOM_B)?.name).toBe('FreshB');
      // C still hot while delete is held
      expect(map.get(ROOM_C)?.name).toBe('StaleC');
      expect(db.batchCalls).toBe(1);
      expect(ctl.data[metaKey(ROOM_B)]).toBeUndefined();

      releaseDelete(metaKey(ROOM_C));
      await invP;
      expect(ctl.data[metaKey(ROOM_C)]).toBeUndefined();
      expect(ctl.deleteCount.get(metaKey(ROOM_C)) ?? 0).toBe(1);
      expect(ctl.putTtl.get(metaKey(ROOM_B))).toBe(TTL_SECONDS);
    });
  }
});
