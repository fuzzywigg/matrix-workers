/**
 * TOKENMAXX HEAVY leftovers after #240 — second-wave room-cache *concurrent
 * race / TOCTOU* niches not covered by #232 / #240 residual.
 *
 * Residual focus (unsaturated after #240):
 *   - Infinity / -Infinity / null / boolean cachedAt TTL under Promise.all
 *   - per-field malformed JSON swallow (name broken∥avatar ok) concurrent
 *   - empty-string / null name content → isDm pin vs named sibling
 *   - delete-hold invalidate mid get-barrier → refill TOCTOU
 *   - single get awaits put (put-hold) unlike fire-and-forget batch
 *   - triple same-key invalidate; whitespace / tab generation parse
 *   - empty batch∥single miss; extra unknown KV fields preserved on hit
 *   - bump put-throw then retry; all-fields-malformed still returns counts
 *
 * Hibernation concurrent leftovers live in call-room-hibernation.test.ts
 * and room-durable-object.test.ts (same PR). Tests-only. example.com
 * fixtures only. No product inventing. Reversible by deleting this file
 * and the hibernation concurrent describes added in this PR.
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
  joined: number;
  invited: number;
  /** Raw content strings override JSON.stringify for field parse edges. */
  rawName?: string;
  rawAvatar?: string;
  rawTopic?: string;
  rawAlias?: string;
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
  jsonThrows: Set<string>;
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
    /** Pre-parsed JSON get overlay (lets Infinity/-Infinity survive; JSON.stringify cannot). */
    jsonOverlay?: Record<string, unknown>;
    getThrows?: string[];
    putThrows?: string[];
    deleteThrows?: string[];
    jsonThrows?: string[];
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
    jsonThrows: new Set(opts.jsonThrows ?? []),
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
      if (type === 'json' && ctl.jsonThrows.has(key)) {
        throw new SyntaxError(`kv-json-throw:${key}`);
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

function mockDb(rooms: Record<string, RoomSpec>): D1Database & {
  batchCalls: number;
  roomsSeen: string[];
} {
  const state = { batchCalls: 0, roomsSeen: [] as string[] };
  const db = {
    get batchCalls() {
      return state.batchCalls;
    },
    get roomsSeen() {
      return state.roomsSeen;
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
      const spec = rooms[roomId] ?? { joined: 0, invited: 0 };
      const nameResults =
        spec.rawName !== undefined
          ? [{ content: spec.rawName }]
          : spec.name
            ? [{ content: JSON.stringify({ name: spec.name }) }]
            : [];
      const avatarResults =
        spec.rawAvatar !== undefined
          ? [{ content: spec.rawAvatar }]
          : spec.avatar
            ? [{ content: JSON.stringify({ url: spec.avatar }) }]
            : [];
      const topicResults =
        spec.rawTopic !== undefined
          ? [{ content: spec.rawTopic }]
          : spec.topic
            ? [{ content: JSON.stringify({ topic: spec.topic }) }]
            : [];
      const aliasResults =
        spec.rawAlias !== undefined
          ? [{ content: spec.rawAlias }]
          : spec.alias
            ? [{ content: JSON.stringify({ alias: spec.alias }) }]
            : [];
      return [
        { results: nameResults },
        { results: avatarResults },
        { results: topicResults },
        { results: aliasResults },
        { results: [{ count: spec.joined }] },
        { results: [{ count: spec.invited }] },
      ];
    }),
  };
  return db as unknown as D1Database & { batchCalls: number; roomsSeen: string[] };
}

function freshMeta(overrides: Partial<RoomMetadata> & Record<string, unknown> = {}): RoomMetadata {
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

describe('race second-wave cachedAt extremes after #240', () => {
  for (let i = 0; i < 8; i++) {
    it(`Infinity hit (age -∞)∥-Infinity miss∥hot sibling flood-${i}`, async () => {
      // JSON.stringify coerces Infinity→null; inject live ±Infinity via overlay.
      const { kv } = createRacingKv({
        data: {
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'HotC' })),
        },
        jsonOverlay: {
          [metaKey(ROOM_A)]: freshMeta({ name: 'Inf', cachedAt: Number.POSITIVE_INFINITY }),
          [metaKey(ROOM_B)]: freshMeta({ name: 'NegInf', cachedAt: Number.NEGATIVE_INFINITY }),
        },
      });
      const db = mockDb({
        [ROOM_B]: { name: 'B2', joined: 2, invited: 0 },
      });
      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);
      // NOW - Infinity === -Infinity, and -Infinity < TTL → hit (document).
      // NOW - (-Infinity) === Infinity ≥ TTL → miss.
      expect(a).toMatchObject({ name: 'Inf' });
      expect(b).toMatchObject({ name: 'B2' });
      expect(c).toMatchObject({ name: 'HotC' });
      expect(db.roomsSeen).toEqual([ROOM_B]);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`JSON.stringify Infinity→null stored miss∥hot sibling flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          // Documents real KV path: Infinity cannot round-trip through JSON.
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Inf', cachedAt: Number.POSITIVE_INFINITY })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'Hot' })),
        },
      });
      const db = mockDb({ [ROOM_A]: { name: 'Filled', joined: 1, invited: 0 } });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(JSON.parse(JSON.stringify({ cachedAt: Number.POSITIVE_INFINITY })).cachedAt).toBeNull();
      expect(a).toMatchObject({ name: 'Filled' });
      expect(b).toMatchObject({ name: 'Hot' });
      expect(db.roomsSeen).toEqual([ROOM_A]);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`null/boolean cachedAt miss∥sibling hit flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify({
            name: 'NullClock',
            joinedCount: 1,
            invitedCount: 0,
            isDm: true,
            cachedAt: null,
          }),
          [metaKey(ROOM_B)]: JSON.stringify({
            name: 'BoolClock',
            joinedCount: 1,
            invitedCount: 0,
            isDm: true,
            cachedAt: true,
          }),
          [metaKey(ROOM_C)]: JSON.stringify(freshMeta({ name: 'Hot' })),
        },
      });
      const db = mockDb({
        [ROOM_A]: { name: 'Afill', joined: 2, invited: 0 },
        [ROOM_B]: { name: 'Bfill', joined: 3, invited: 0 },
      });
      const [a, b, c] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
      ]);
      expect(a).toMatchObject({ name: 'Afill' });
      expect(b).toMatchObject({ name: 'Bfill' });
      expect(c).toMatchObject({ name: 'Hot' });
      expect(db.batchCalls).toBe(2);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`extra unknown KV fields preserved on concurrent hit flood-${i}`, async () => {
      const { kv } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(
            freshMeta({ name: 'Extra', extraFlag: true, nested: { x: 1 } } as RoomMetadata & {
              extraFlag: boolean;
              nested: { x: number };
            })
          ),
        },
      });
      const db = mockDb({});
      const [hit] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_A),
      ]);
      expect(hit).toMatchObject({ name: 'Extra', extraFlag: true, nested: { x: 1 } });
      expect(db.batchCalls).toBe(0);
    });
  }
});

describe('race second-wave malformed field JSON concurrent after #240', () => {
  for (let i = 0; i < 8; i++) {
    it(`broken name swallow∥valid avatar sibling flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: {
          joined: 1,
          invited: 0,
          rawName: '{not-json',
          avatar: 'mxc://example.com/a',
        },
        [ROOM_B]: {
          name: 'Ok',
          joined: 2,
          invited: 0,
          rawAvatar: '{bad',
          topic: 'T',
        },
      });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(a).toMatchObject({
        name: undefined,
        avatar: 'mxc://example.com/a',
        isDm: true,
      });
      expect(b).toMatchObject({
        name: 'Ok',
        avatar: undefined,
        topic: 'T',
        isDm: false,
      });
      expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).avatar).toBe('mxc://example.com/a');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`all four fields malformed still returns counts flood-${i}`, async () => {
      const { kv } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: {
          joined: 4,
          invited: 7,
          rawName: 'x',
          rawAvatar: 'y',
          rawTopic: 'z',
          rawAlias: '{',
        },
        [ROOM_B]: { name: 'Fine', joined: 1, invited: 0 },
      });
      const [a, b] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
      ]);
      expect(a).toMatchObject({
        name: undefined,
        avatar: undefined,
        topic: undefined,
        canonicalAlias: undefined,
        joinedCount: 4,
        invitedCount: 7,
        isDm: false,
      });
      expect(b).toMatchObject({ name: 'Fine' });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`empty-string/null name content isDm pin∥named flood-${i}`, async () => {
      const { kv } = createRacingKv();
      const db = mockDb({
        [ROOM_A]: { joined: 2, invited: 0, rawName: JSON.stringify({ name: '' }) },
        [ROOM_B]: { joined: 2, invited: 0, rawName: JSON.stringify({ name: null }) },
        [ROOM_C]: { joined: 2, invited: 0, name: 'Named' },
        [ROOM_D]: { joined: 3, invited: 0, rawName: JSON.stringify({ name: '' }) },
      });
      const [a, b, c, d] = await Promise.all([
        getRoomMetadata(kv, db, ROOM_A),
        getRoomMetadata(kv, db, ROOM_B),
        getRoomMetadata(kv, db, ROOM_C),
        getRoomMetadata(kv, db, ROOM_D),
      ]);
      // !'' and !null are both true → isDm when joined <= 2
      expect(a).toMatchObject({ name: '', isDm: true });
      expect(b).toMatchObject({ name: null, isDm: true });
      expect(c).toMatchObject({ name: 'Named', isDm: false });
      expect(d).toMatchObject({ name: '', isDm: false });
    });
  }
});

describe('race second-wave delete-hold invalidate TOCTOU after #240', () => {
  for (let i = 0; i < 10; i++) {
    it(`delete-hold invalidate while get parked then refill flood-${i}`, async () => {
      const { kv, ctl, releaseGet, releaseDelete } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Old' })) },
        getHold: [metaKey(ROOM_A)],
        deleteHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'New', joined: 5, invited: 0 } });

      const getP = getRoomMetadata(kv, db, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.startsWith('get-wait:'))).toBe(true);
      });

      const invP = invalidateRoomCache(kv, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.startsWith('delete-wait:'))).toBe(true);
      });
      // Entry still present while delete is held.
      expect(ctl.data[metaKey(ROOM_A)]).toBeDefined();

      releaseDelete(metaKey(ROOM_A));
      await invP;
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();

      releaseGet(metaKey(ROOM_A));
      const meta = await getP;
      expect(meta).toMatchObject({ name: 'New', joinedCount: 5 });
      expect(db.batchCalls).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`triple same-key invalidate deleteCount 3 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'X' })) },
      });
      await Promise.all([
        invalidateRoomCache(kv, ROOM_A),
        invalidateRoomCache(kv, ROOM_A),
        invalidateBatchRoomCache(kv, [ROOM_A]),
      ]);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.deleteCount.get(metaKey(ROOM_A))).toBe(3);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`delete-hold A∥hot get B isolation flood-${i}`, async () => {
      const { kv, ctl, releaseDelete } = createRacingKv({
        data: {
          [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Drop' })),
          [metaKey(ROOM_B)]: JSON.stringify(freshMeta({ name: 'Stay' })),
        },
        deleteHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({});
      const invP = invalidateRoomCache(kv, ROOM_A);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.startsWith('delete-wait:'))).toBe(true);
      });
      const hit = await getRoomMetadata(kv, db, ROOM_B);
      expect(hit).toMatchObject({ name: 'Stay' });
      expect(db.batchCalls).toBe(0);
      releaseDelete(metaKey(ROOM_A));
      await invP;
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      expect(ctl.data[metaKey(ROOM_B)]).toBeDefined();
    });
  }
});

describe('race second-wave single put-hold vs batch fire-and-forget after #240', () => {
  for (let i = 0; i < 10; i++) {
    it(`single get put-hold does not resolve until put releases flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'AwaitPut', joined: 1, invited: 0 } });

      let resolved = false;
      const getP = getRoomMetadata(kv, db, ROOM_A).then((m) => {
        resolved = true;
        return m;
      });
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.startsWith('put-wait:'))).toBe(true);
      });
      expect(resolved).toBe(false);
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();

      releasePut(metaKey(ROOM_A));
      const meta = await getP;
      expect(meta).toMatchObject({ name: 'AwaitPut' });
      expect(ctl.putTtl.get(metaKey(ROOM_A))).toBe(TTL_SECONDS);
      expect(resolved).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`empty batch∥single miss isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      const db = mockDb({ [ROOM_A]: { name: 'Only', joined: 1, invited: 0 } });
      const [empty, single] = await Promise.all([
        getBatchRoomMetadata(kv, db, []),
        getRoomMetadata(kv, db, ROOM_A),
      ]);
      expect(empty.size).toBe(0);
      expect(single).toMatchObject({ name: 'Only' });
      expect(db.batchCalls).toBe(1);
      expect(ctl.putCount.get(metaKey(ROOM_A))).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`batch put-hold∥single sibling room isolation flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [metaKey(ROOM_A)],
      });
      const db = mockDb({
        [ROOM_A]: { name: 'BatchA', joined: 1, invited: 0 },
        [ROOM_B]: { name: 'SingleB', joined: 2, invited: 0 },
      });
      const batchP = getBatchRoomMetadata(kv, db, [ROOM_A]);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.startsWith('put-wait:'))).toBe(true);
      });
      const single = await getRoomMetadata(kv, db, ROOM_B);
      expect(single).toMatchObject({ name: 'SingleB' });
      const batch = await batchP;
      expect(batch.get(ROOM_A)).toMatchObject({ name: 'BatchA' });
      expect(ctl.data[metaKey(ROOM_A)]).toBeUndefined();
      releasePut(metaKey(ROOM_A));
      await vi.waitFor(() => {
        expect(JSON.parse(ctl.data[metaKey(ROOM_A)]).name).toBe('BatchA');
      });
    });
  }
});

describe('race second-wave generation whitespace + put-throw retry after #240', () => {
  for (let i = 0; i < 8; i++) {
    it(`tab/whitespace/CRLF generation get∥bump flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        data: {
          [genKey(ROOM_A)]: '\t9',
          [genKey(ROOM_B)]: '  3\n',
          [genKey(ROOM_C)]: '\r\n2',
          [genKey(ROOM_D)]: ' \t ',
        },
      });
      const [ga, gb, gc, gd] = await Promise.all([
        getRoomCacheGeneration(kv, ROOM_A),
        getRoomCacheGeneration(kv, ROOM_B),
        getRoomCacheGeneration(kv, ROOM_C),
        getRoomCacheGeneration(kv, ROOM_D),
      ]);
      // parseInt trims leading ws; trailing junk after digits is ignored;
      // whitespace-only is NaN → 0.
      expect([ga, gb, gc, gd]).toEqual([9, 3, 2, 0]);
      const [ba, bb, bc, bd] = await Promise.all([
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
        bumpRoomCacheGeneration(kv, ROOM_C),
        bumpRoomCacheGeneration(kv, ROOM_D),
      ]);
      expect([ba, bb, bc, bd]).toEqual([10, 4, 3, 1]);
      expect(ctl.data[genKey(ROOM_D)]).toBe('1');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`bump put-throw rejects then retry succeeds∥sibling flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        putThrows: [genKey(ROOM_A)],
        data: { [genKey(ROOM_B)]: '5' },
      });
      const [rejected, ok] = await Promise.allSettled([
        bumpRoomCacheGeneration(kv, ROOM_A),
        bumpRoomCacheGeneration(kv, ROOM_B),
      ]);
      expect(rejected.status).toBe('rejected');
      expect(ok).toEqual({ status: 'fulfilled', value: 6 });
      expect(ctl.data[genKey(ROOM_A)]).toBeUndefined();

      ctl.putThrows.delete(genKey(ROOM_A));
      expect(await bumpRoomCacheGeneration(kv, ROOM_A)).toBe(1);
      expect(ctl.data[genKey(ROOM_A)]).toBe('1');
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`gen get-throw∥meta miss refill isolation flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getThrows: [genKey(ROOM_A)],
      });
      const db = mockDb({ [ROOM_A]: { name: 'Meta', joined: 1, invited: 0 } });
      const [gen, meta] = await Promise.all([
        getRoomCacheGeneration(kv, ROOM_A),
        getRoomMetadata(kv, db, ROOM_A),
      ]);
      expect(gen).toBe(0);
      expect(meta).toMatchObject({ name: 'Meta' });
      expect(ctl.data[metaKey(ROOM_A)]).toBeDefined();
      expect(ctl.data[genKey(ROOM_A)]).toBeUndefined();
    });
  }
});

describe('race second-wave SQL bind + batch mix leftovers after #240', () => {
  it('malformed-field rooms bind distinct room_ids under parallel miss', async () => {
    const { kv } = createRacingKv();
    const db = mockDb({
      [ROOM_A]: { joined: 1, invited: 0, rawName: '{' },
      [ROOM_B]: { joined: 1, invited: 0, rawTopic: '}' },
    });
    await Promise.all([getRoomMetadata(kv, db, ROOM_A), getRoomMetadata(kv, db, ROOM_B)]);
    expect(new Set(db.roomsSeen)).toEqual(new Set([ROOM_A, ROOM_B]));
  });

  it('hot A + duplicate A in batch hits once without D1', async () => {
    const { kv } = createRacingKv({
      data: { [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'HotDup' })) },
    });
    const db = mockDb({});
    const map = await getBatchRoomMetadata(kv, db, [ROOM_A, ROOM_A, ROOM_A]);
    expect(map.get(ROOM_A)).toMatchObject({ name: 'HotDup' });
    expect(db.batchCalls).toBe(0);
  });

  it('almost-stale TTL-1 hit∥null-clock miss under barrier', async () => {
    const { kv } = createRacingKv({
      data: {
        [metaKey(ROOM_A)]: JSON.stringify(freshMeta({ name: 'Almost', cachedAt: NOW - TTL_MS + 1 })),
        [metaKey(ROOM_B)]: JSON.stringify({
          name: 'NoClock',
          joinedCount: 1,
          invitedCount: 0,
          isDm: true,
        }),
      },
      getBarrier: [
        [metaKey(ROOM_A), 1],
        [metaKey(ROOM_B), 1],
      ],
    });
    const db = mockDb({ [ROOM_B]: { name: 'Filled', joined: 2, invited: 0 } });
    const [a, b] = await Promise.all([
      getRoomMetadata(kv, db, ROOM_A),
      getRoomMetadata(kv, db, ROOM_B),
    ]);
    expect(a).toMatchObject({ name: 'Almost' });
    expect(b).toMatchObject({ name: 'Filled' });
    expect(db.roomsSeen).toEqual([ROOM_B]);
  });
});
