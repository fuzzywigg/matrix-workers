/**
 * TOKENMAXX HEAVY leftovers after #288 septenary→nonary — denary room-cache
 * *concurrent race / TOCTOU* niches closed #291 claimed but #288 never landed
 * (joinedRaw undefined/-1, cachedAt-only incomplete hit, same-room get
 * put-hold∥getBatch, meta getThrows→putThrows, delete-hold∥put-hold,
 * cachedAt:[], JSON "null" content, three-way put-hold∥invalidate∥bump).
 *
 * Hibernation denary leftovers live in call-room-hibernation.test.ts
 * and room-durable-object.test.ts (same PR). Tests-only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file
 * and the hibernation denary describes.
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
// joinedRaw: undefined → 0; joinedRaw: -1 stays -1 (truthy negative || 0)
// ---------------------------------------------------------------------------

describe('race denary joinedRaw undefined/-1 after #288 nonary', () => {
  for (let i = 0; i < 8; i++) {
    it(`joinedRaw undefined→0∥-1 stays -1 under parallel miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
          [metaKey(ROOM_C), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { joinedRaw: undefined, invitedRaw: 1 },
        [ROOM_B]: { joinedRaw: -1, invitedRaw: 0 },
        [ROOM_C]: { joined: 3, name: 'Named' },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      // undefined || 0 → 0; -1 is truthy so -1 || 0 → -1
      expect(a?.joinedCount).toBe(0);
      expect(a?.invitedCount).toBe(1);
      expect(a?.isDm).toBe(true);
      expect(b?.joinedCount).toBe(-1);
      expect(b?.isDm).toBe(true); // -1 <= 2 && !name
      expect(c?.name).toBe('Named');
      expect(c?.isDm).toBe(false);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// Fresh incomplete KV hit: { cachedAt } only — TTL age 0 so returned as-is
// ---------------------------------------------------------------------------

describe('race denary incomplete cachedAt-only KV hit after #288', () => {
  for (let i = 0; i < 8; i++) {
    it(`cachedAt-only hit∥D1 miss sibling∥hot flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        jsonOverlay: {
          [metaKey(ROOM_A)]: { cachedAt: NOW },
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
        [ROOM_B]: { name: 'FromD1', joined: 4 },
      });

      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);

      expect(a).toEqual({ cachedAt: NOW });
      expect(a && 'joinedCount' in a).toBe(false);
      expect(b?.name).toBe('FromD1');
      expect(c?.name).toBe('HotC');
      expect(db.batchCalls).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Same-room get put-hold ∥ getBatch: batch does not await put so returns
// while getRoomMetadata is still blocked on the held put
// ---------------------------------------------------------------------------

describe('race denary same-room get put-hold∥getBatch after #288', () => {
  for (let i = 0; i < 8; i++) {
    it(`getBatch resolves mid put-hold; get waits then both fill flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FreshA', joined: 5 },
      });

      let getSettled = false;
      const getP = getRoomMetadata(kv, db, ROOM_A).then((r) => {
        getSettled = true;
        return r;
      });
      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A]);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${metaKey(ROOM_A)}`))).toBe(
          true
        );
      });

      const batch = await batchP;
      expect(getSettled).toBe(false);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(batch.get(ROOM_A)?.name).toBe('FreshA');

      releasePut(metaKey(ROOM_A));
      const a = await getP;
      expect(a?.name).toBe('FreshA');
      expect(getSettled).toBe(true);
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('FreshA');
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// Meta getThrows then putThrows chained (senary only chained bump gen keys)
// ---------------------------------------------------------------------------

describe('race denary meta getThrows then putThrows after #288', () => {
  for (let i = 0; i < 8; i++) {
    it(`A getThrow→D1→putThrow still returns∥B put ok flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getThrows: [metaKey(ROOM_A)],
        putThrows: [metaKey(ROOM_A)],
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'AfromD1', joined: 2 },
        [ROOM_B]: { name: 'BfromD1', joined: 3 },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      expect(a?.name).toBe('AfromD1');
      expect(b?.name).toBe('BfromD1');
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(JSON.parse(ctl.data[metaKey(ROOM_B)]).name).toBe('BfromD1');
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBe(1);
      expect(db.batchCalls).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Delete-hold invalidate ∥ put-hold refill — explicit LWW orders
// ---------------------------------------------------------------------------

describe('race denary delete-hold invalidate∥put-hold refill after #288', () => {
  for (let i = 0; i < 8; i++) {
    it(`releasePut then delete → empty cache flood-${i}`, async () => {
      const { kv, ctl, releasePut, releaseDelete } = createRacingKv({
        putHold: [metaKey(ROOM_A)],
        deleteHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'RefillA', joined: 2 },
      });

      const getP = getRoomMetadata(kv, db, ROOM_A);
      const invP = invalidateRoomCache(kv, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${metaKey(ROOM_A)}`))).toBe(
          true
        );
        expect(ctl.events.some((e) => e.includes(`delete-wait:${metaKey(ROOM_A)}`))).toBe(
          true
        );
      });

      releasePut(metaKey(ROOM_A));
      releaseDelete(metaKey(ROOM_A));
      const a = await getP;
      await invP;
      expect(a?.name).toBe('RefillA');
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`releaseDelete then put → filled cache flood-${i}`, async () => {
      const { kv, ctl, releasePut, releaseDelete } = createRacingKv({
        putHold: [metaKey(ROOM_A)],
        deleteHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'RefillA', joined: 2 },
      });

      const getP = getRoomMetadata(kv, db, ROOM_A);
      const invP = invalidateRoomCache(kv, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${metaKey(ROOM_A)}`))).toBe(
          true
        );
        expect(ctl.events.some((e) => e.includes(`delete-wait:${metaKey(ROOM_A)}`))).toBe(
          true
        );
      });

      releaseDelete(metaKey(ROOM_A));
      releasePut(metaKey(ROOM_A));
      const a = await getP;
      await invP;
      expect(a?.name).toBe('RefillA');
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('RefillA');
    });
  }
});

// ---------------------------------------------------------------------------
// cachedAt: [] on a plain object → ToNumber([])=0 → age=NOW → miss
// ---------------------------------------------------------------------------

describe('race denary cachedAt [] array clock miss after #288', () => {
  for (let i = 0; i < 8; i++) {
    it(`cachedAt [] miss→D1∥hot sibling flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        jsonOverlay: {
          [metaKey(ROOM_A)]: {
            name: 'ArrClock',
            joinedCount: 9,
            invitedCount: 0,
            isDm: false,
            cachedAt: [],
          },
        },
        data: {
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'HotB' })),
        },
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'FromD1', joined: 2 },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // NOW - [] === NOW, not < TTL → miss → D1
      expect(a?.name).toBe('FromD1');
      expect(a?.joinedCount).toBe(2);
      expect(b?.name).toBe('HotB');
      expect(db.batchCalls).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_A)) ?? 0).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_B)) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// State content JSON text "null" (parse then .name throw) + invalid "{"
// ---------------------------------------------------------------------------

describe('race denary JSON null/invalid state content after #288', () => {
  for (let i = 0; i < 8; i++) {
    it(`name/avatar "null" throw∥topic "{" ignore under miss flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [metaKey(ROOM_A), 1],
          [metaKey(ROOM_B), 1],
        ],
      });
      const db = mockDb({
        [ROOM_A]: {
          rawNameContent: 'null',
          rawAvatarContent: 'null',
          joined: 2,
        },
        [ROOM_B]: {
          rawTopicContent: '{',
          rawAliasContent: '[]',
          joined: 1,
        },
      });

      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);

      // JSON.parse('null').name throws → name/avatar stay undefined
      expect(a?.name).toBeUndefined();
      expect(a?.avatar).toBeUndefined();
      expect(a?.isDm).toBe(true);
      expect(b?.topic).toBeUndefined();
      expect(b?.canonicalAlias).toBeUndefined(); // [].alias undefined, no throw
      expect(b?.isDm).toBe(true);
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
    });
  }
});

// ---------------------------------------------------------------------------
// Three-way put-hold get ∥ invalidate ∥ bump
// ---------------------------------------------------------------------------

describe('race denary three-way put-hold∥invalidate∥bump after #288', () => {
  for (let i = 0; i < 8; i++) {
    it(`bump completes; meta LWW empty-or-filled flood-${i}`, async () => {
      const { kv, ctl, releasePut, releaseDelete } = createRacingKv({
        putHold: [metaKey(ROOM_A)],
        deleteHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'TriA', joined: 2 },
      });

      const getP = getRoomMetadata(kv, db, ROOM_A);
      const invP = invalidateRoomCache(kv, ROOM_A);
      const bumpP = bumpRoomCacheGeneration(kv, ROOM_A);

      const gen = await bumpP;
      expect(gen).toBe(1);
      expect(await getRoomCacheGeneration(kv, ROOM_A)).toBe(1);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${metaKey(ROOM_A)}`))).toBe(
          true
        );
        expect(ctl.events.some((e) => e.includes(`delete-wait:${metaKey(ROOM_A)}`))).toBe(
          true
        );
      });

      releasePut(metaKey(ROOM_A));
      releaseDelete(metaKey(ROOM_A));
      const a = await getP;
      await invP;
      expect(a?.name).toBe('TriA');
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
      const filled = ctl.data[metaKey(ROOM_A)] !== undefined;
      expect(filled === false || JSON.parse(ctl.data[metaKey(ROOM_A)]).name === 'TriA').toBe(
        true
      );
    });
  }
});
