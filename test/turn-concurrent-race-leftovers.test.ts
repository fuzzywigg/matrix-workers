/**
 * TOKENMAXX HEAVY leftovers after #296 room-cache denary + #298 crypto/db
 * (+ tip #297 admin/federation quaternary) — unsaturated *turn* service
 * concurrent-race / TOCTOU niches.
 *
 * Sequential edges already dense in turn-helpers.test.ts; voip leftovers
 * mock getMatrixTurnCredentials and never race turn_creds / turn_ratelimit
 * KV. This file is tests-only. example.com fixtures only. No product
 * inventing. Reversible by deleting this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMatrixTurnCredentials,
  getStunServers,
  getTurnStatus,
  isTurnConfigured,
  TurnError,
} from '../src/services/turn';
import type { Env } from '../src/types';

const NOW = 1_730_000_000_000;
const KEY_ID = 'turnkey12abcdefgh';
const KEY_ID_B = 'turnkey99zyxwvuts';
const ALICE = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const CREDS_KEY = `turn_creds:${KEY_ID}:3600`;
const CREDS_KEY_TTL300 = `turn_creds:${KEY_ID}:300`;
const CREDS_KEY_B = `turn_creds:${KEY_ID_B}:3600`;
const RL_ALICE = `turn_ratelimit:${ALICE}`;
const RL_BOB = `turn_ratelimit:${BOB}`;
const RL_CAROL = `turn_ratelimit:${CAROL}`;

type Barrier = { remaining: number; waiters: Array<() => void>; hold?: boolean };

type KvCtl = {
  data: Record<string, string>;
  events: string[];
  getCount: Map<string, number>;
  putCount: Map<string, number>;
  deleteCount: Map<string, number>;
  fetchStarts: number;
  getThrows: Set<string>;
  putThrows: Set<string>;
  deleteThrows: Set<string>;
  getBarrier: Map<string, Barrier>;
  putBarrier: Map<string, Barrier>;
  deleteBarrier: Map<string, Barrier>;
  putTtl: Map<string, number | undefined>;
};

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
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
    fetchStarts: 0,
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
      bump(ctl.getCount, key);
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
      bump(ctl.putCount, key);
      ctl.events.push(`put:${key}`);
      ctl.putTtl.set(key, options?.expirationTtl);
      await waitBarrier(ctl.putBarrier, key, ctl.events, 'put');
      if (ctl.putThrows.has(key) || ctl.putThrows.has('*')) {
        throw new Error(`kv-put-throw:${key}`);
      }
      ctl.data[key] = value;
    },
    delete: async (key: string) => {
      bump(ctl.deleteCount, key);
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

function turnEnv(kv: KVNamespace, partial: Partial<Env> = {}): Env {
  return {
    TURN_KEY_ID: KEY_ID,
    TURN_API_TOKEN: 'turn-token',
    CACHE: kv,
    ...partial,
  } as Env;
}

function iceBody(username = 'u', credential = 'p', urls: string[] = ['turn:turn.example.com:3478']) {
  return {
    iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls, username, credential },
    ],
  };
}

function stubFetchOk(ctl?: KvCtl, body: unknown = iceBody()) {
  const fetchMock = vi.fn(async () => {
    if (ctl) ctl.fetchStarts += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function seedRateLimit(data: Record<string, string>, userKey: string, count: number, base = NOW) {
  const requests = Array.from({ length: count }, (_, i) => base + i);
  data[userKey] = JSON.stringify({ requests });
}

function cachedCreds(overrides: Record<string, unknown> = {}) {
  return {
    username: 'cached',
    password: 'pw',
    uris: ['turn:cached.example.com'],
    ttl: 3600,
    expiresAt: NOW + 800_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Cache-miss stampede: N concurrent getMatrixTurnCredentials → N fetches
// ---------------------------------------------------------------------------

describe('race turn cache-miss stampede after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`N parallel misses each fetch+put before any put lands flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[CREDS_KEY, 4]],
      });
      const fetchMock = stubFetchOk(ctl, iceBody(`stampede-${i}`, `pw-${i}`));

      const results = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(results.every((r) => r.username === `stampede-${i}`)).toBe(true);
      expect(ctl.fetchStarts).toBe(4);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(4);
      expect(ctl.putTtl.get(CREDS_KEY)).toBe(Math.floor(3600 * 0.8));
    });
  }
});

// ---------------------------------------------------------------------------
// Rate-limit RMW TOCTOU: concurrent callers both see length < MAX
// ---------------------------------------------------------------------------

describe('race turn rate-limit RMW TOCTOU after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`4 concurrent first-hits all allow and overgrow requests[] flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[RL_ALICE, 4]],
      });
      stubFetchOk(ctl);

      const settled = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
      expect(ctl.putCount.get(RL_ALICE)).toBe(4);
      // Lost-update: last put wins with a single timestamp → length 1 (classic RMW)
      const stored = JSON.parse(ctl.data[RL_ALICE]) as { requests: number[] };
      expect(stored.requests.length).toBe(1);
      expect(stored.requests[0]).toBe(NOW);
      expect(ctl.putTtl.get(RL_ALICE)).toBe(70);
    });
  }
});

// ---------------------------------------------------------------------------
// Boundary: concurrent 5th∥6th when 4 already recorded
// ---------------------------------------------------------------------------

describe('race turn rate-limit 5th∥6th boundary after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`both 5th and 6th pass before either put when seed=4 flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 4);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [[RL_ALICE, 2]],
      });
      stubFetchOk(ctl);

      const settled = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      // Both saw length 4 < 5 → both allowed (TOCTOU over-admit)
      expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
      expect(ctl.fetchStarts).toBe(2);
      const stored = JSON.parse(ctl.data[RL_ALICE]) as { requests: number[] };
      // Last writer: 4 seed + 1 push = 5 (sibling push lost)
      expect(stored.requests.length).toBe(5);
    });
  }
});

// ---------------------------------------------------------------------------
// Credential put-hold ∥ second get: miss vs hit once put releases
// ---------------------------------------------------------------------------

describe('race turn creds put-hold∥sibling get after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`sibling still misses while put held; hits after release flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [CREDS_KEY],
      });
      stubFetchOk(ctl, iceBody('held-user', 'held-pw'));

      let firstSettled = false;
      const firstP = getMatrixTurnCredentials(turnEnv(kv), 3600).then((r) => {
        firstSettled = true;
        return r;
      });

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${CREDS_KEY}`))).toBe(true);
      });
      expect(firstSettled).toBe(false);
      expect(ctl.data[CREDS_KEY]).toBeUndefined();

      // Mid put-hold: second call still cache-misses and starts another fetch
      const secondP = getMatrixTurnCredentials(turnEnv(kv), 3600);
      await vi.waitFor(() => {
        expect(ctl.fetchStarts).toBe(2);
      });

      releasePut(CREDS_KEY);
      const [first, second] = await Promise.all([firstP, secondP]);
      expect(first.username).toBe('held-user');
      expect(second.username).toBe('held-user');
      expect(firstSettled).toBe(true);
      expect(ctl.putCount.get(CREDS_KEY)).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(ctl.data[CREDS_KEY]).username).toBe('held-user');
    });
  }
});

// ---------------------------------------------------------------------------
// Expired entry delete-hold ∥ concurrent read
// ---------------------------------------------------------------------------

describe('race turn expired delete-hold∥sibling after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`delete-hold blocks expiry cleanup while sibling refetches flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(
          cachedCreds({ username: 'stale', expiresAt: NOW }) // exact expiry → delete
        ),
      };
      const { kv, ctl, releaseDelete } = createRacingKv({
        data,
        deleteHold: [CREDS_KEY],
      });
      stubFetchOk(ctl, iceBody('fresh', 'fresh-pw'));

      let expireSettled = false;
      const expireP = getMatrixTurnCredentials(turnEnv(kv), 3600).then((r) => {
        expireSettled = true;
        return r;
      });

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`delete-wait:${CREDS_KEY}`))).toBe(true);
      });
      expect(expireSettled).toBe(false);
      // Stale still present until delete releases
      expect(JSON.parse(ctl.data[CREDS_KEY]).username).toBe('stale');

      releaseDelete(CREDS_KEY);
      const result = await expireP;
      expect(result.username).toBe('fresh');
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
      expect(ctl.fetchStarts).toBe(1);
      expect(JSON.parse(ctl.data[CREDS_KEY]).username).toBe('fresh');
    });
  }
});

// ---------------------------------------------------------------------------
// Rate-limit put lost-update under putBarrier
// ---------------------------------------------------------------------------

describe('race turn rate-limit put lost-update after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`putBarrier serializes two rate-limit puts; last write wins flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[RL_BOB, 2]],
        putBarrier: [[RL_BOB, 2]],
      });
      stubFetchOk(ctl);

      await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(ctl.putCount.get(RL_BOB)).toBe(2);
      const stored = JSON.parse(ctl.data[RL_BOB]) as { requests: number[] };
      expect(stored.requests).toEqual([NOW]);
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-user isolation under concurrent barriers
// ---------------------------------------------------------------------------

describe('race turn cross-user rate-limit isolation after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`alice capped∥bob still allowed under parallel barriers flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [RL_ALICE, 1],
          [RL_BOB, 1],
        ],
      });
      stubFetchOk(ctl);

      const [alice, bob] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({
          code: 'USER_RATE_LIMITED',
          statusCode: 429,
          retryAfterMs: expect.any(Number),
        });
        expect((alice.reason as TurnError).retryAfterMs!).toBeGreaterThanOrEqual(1000);
      }
      expect(bob.status).toBe('fulfilled');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Distinct TTL cache-key isolation (clamped 300 vs 3600)
// ---------------------------------------------------------------------------

describe('race turn TTL cache-key isolation after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`ttl=1→300∥ttl=3600 miss under parallel get barriers flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [CREDS_KEY, 1],
        ],
      });
      const fetchMock = stubFetchOk(ctl);

      const [low, high] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 1),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(low.ttl).toBe(300);
      expect(high.ttl).toBe(3600);
      expect(ctl.fetchStarts).toBe(2);
      expect(ctl.data[CREDS_KEY_TTL300]).toBeDefined();
      expect(ctl.data[CREDS_KEY]).toBeDefined();
      expect(ctl.putTtl.get(CREDS_KEY_TTL300)).toBe(Math.floor(300 * 0.8));
      expect(ctl.putTtl.get(CREDS_KEY)).toBe(Math.floor(3600 * 0.8));
      const bodies = fetchMock.mock.calls.map((c) => c[1].body).sort();
      expect(bodies).toEqual([
        JSON.stringify({ ttl: 300 }),
        JSON.stringify({ ttl: 3600 }),
      ]);
    });
  }
});

// ---------------------------------------------------------------------------
// Distinct TURN_KEY_ID cache-key isolation
// ---------------------------------------------------------------------------

describe('race turn KEY_ID cache-key isolation after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`keyA∥keyB miss under parallel barriers flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_B, 1],
        ],
      });
      let n = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          ctl.fetchStarts += 1;
          n += 1;
          const user = url.includes(KEY_ID_B) ? `b-${i}` : `a-${i}`;
          return new Response(JSON.stringify(iceBody(user, 'pw')), { status: 200 });
        })
      );

      const [a, b] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv, { TURN_KEY_ID: KEY_ID_B }), 3600),
      ]);

      expect(a.username).toBe(`a-${i}`);
      expect(b.username).toBe(`b-${i}`);
      expect(ctl.fetchStarts).toBe(2);
      expect(ctl.data[CREDS_KEY]).toBeDefined();
      expect(ctl.data[CREDS_KEY_B]).toBeDefined();
      expect(n).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Concurrent fail-open: rate-limit get throw on A ∥ healthy B
// ---------------------------------------------------------------------------

describe('race turn rate-limit fail-open∥healthy sibling after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`alice getThrow fail-open∥bob healthy under barriers flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getThrows: [RL_ALICE],
        getBarrier: [
          [RL_ALICE, 1],
          [RL_BOB, 1],
        ],
      });
      stubFetchOk(ctl);

      const [alice, bob] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(alice.username).toBe('u');
      expect(bob.username).toBe('u');
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0); // fail-open skipped put
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Concurrent cache put throw (warn) ∥ sibling success
// ---------------------------------------------------------------------------

describe('race turn cache putThrow∥sibling success after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`putThrow warns but returns∥sibling caches ok flood-${i}`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      // Two envs share kv; putThrows only for CREDS_KEY on first path via same key —
      // use putBarrier+putThrows that fires once then clears by using putThrows set.
      const { kv, ctl } = createRacingKv({
        putThrows: [CREDS_KEY],
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      stubFetchOk(ctl);

      const [a, b] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 1), // clamps → CREDS_KEY_TTL300
      ]);

      expect(a.username).toBe('u');
      expect(b.username).toBe('u');
      expect(b.ttl).toBe(300);
      expect(warn).toHaveBeenCalledWith('Failed to cache TURN credentials');
      expect(ctl.data[CREDS_KEY]).toBeUndefined();
      expect(ctl.data[CREDS_KEY_TTL300]).toBeDefined();
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Mid-flight clock: two cache hits see different remaining ttl
// ---------------------------------------------------------------------------

describe('race turn mid-flight remaining ttl clock after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`get-hold first hit; clock advance; second hit smaller ttl flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ expiresAt: NOW + 800_000 })),
      };
      const { kv, ctl, releaseGet } = createRacingKv({
        data,
        getHold: [CREDS_KEY],
      });
      stubFetchOk(ctl);

      const firstP = getMatrixTurnCredentials(turnEnv(kv), 3600);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${CREDS_KEY}`))).toBe(true);
      });

      // Date.now() runs AFTER barrier wait → remaining ttl uses advanced clock
      vi.setSystemTime(NOW + 250_000);
      releaseGet(CREDS_KEY);
      const first = await firstP;
      expect(first.ttl).toBe(550);

      const second = await getMatrixTurnCredentials(turnEnv(kv), 3600);
      expect(second.ttl).toBe(550);
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// After 5 sequential allows, concurrent 6th∥7th both USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn post-cap 6th∥7th both limited after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`seed=5 → parallel 6th∥7th both reject with retryAfterMs≥1000 flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_CAROL, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [[RL_CAROL, 2]],
      });
      stubFetchOk(ctl);

      const settled = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL),
        getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL),
      ]);

      expect(settled.every((s) => s.status === 'rejected')).toBe(true);
      for (const s of settled) {
        if (s.status === 'rejected') {
          expect(s.reason).toMatchObject({
            code: 'USER_RATE_LIMITED',
            statusCode: 429,
          });
          expect((s.reason as TurnError).retryAfterMs!).toBeGreaterThanOrEqual(1000);
        }
      }
      expect(ctl.fetchStarts).toBe(0);
      expect(ctl.putCount.get(RL_CAROL) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// In-flight fetch: put not visible yet → second miss starts duplicate fetch
// (covered partly by put-hold; explicit getBarrier stampede variant)
// ---------------------------------------------------------------------------

describe('race turn in-flight fetch duplicate miss after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`getBarrier=2 both miss then both fetch before either put flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[CREDS_KEY, 2]],
        putBarrier: [[CREDS_KEY, 2]],
      });
      stubFetchOk(ctl, iceBody(`dup-${i}`, 'dup-pw'));

      const [a, b] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(a.username).toBe(`dup-${i}`);
      expect(b.username).toBe(`dup-${i}`);
      expect(ctl.fetchStarts).toBe(2);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Stale timestamps outside window filtered under concurrent get + clock
// ---------------------------------------------------------------------------

describe('race turn stale window filter release after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`hold then advance; only in-window stamps count; allow flood-${i}`, async () => {
      const data: Record<string, string> = {
        [RL_ALICE]: JSON.stringify({
          requests: [NOW - 120_000, NOW - 90_000, NOW - 61_000, NOW - 30_000, NOW - 10_000],
        }),
      };
      const { kv, ctl, releaseGet } = createRacingKv({
        data,
        getHold: [RL_ALICE],
      });
      stubFetchOk(ctl);

      const p = getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${RL_ALICE}`))).toBe(true);
      });

      vi.setSystemTime(NOW + 1); // windowStart = NOW+1-60000; keeps -30k and -10k
      releaseGet(RL_ALICE);
      await expect(p).resolves.toMatchObject({ username: 'u' });
      const stored = JSON.parse(ctl.data[RL_ALICE]) as { requests: number[] };
      expect(stored.requests.length).toBe(3); // 2 kept + 1 new (NOW+1)
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Rate-limit put-hold ∥ sibling request (sibling sees pre-put state)
// ---------------------------------------------------------------------------

describe('race turn rate-limit put-hold∥sibling after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`sibling admits while first put held (TOCTOU) flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_BOB, 4);
      const { kv, ctl, releasePut } = createRacingKv({
        data,
        putHold: [RL_BOB],
      });
      stubFetchOk(ctl);

      let firstDone = false;
      const firstP = getMatrixTurnCredentials(turnEnv(kv), 3600, BOB).then((r) => {
        firstDone = true;
        return r;
      });

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${RL_BOB}`))).toBe(true);
      });
      expect(firstDone).toBe(false);

      // Sibling still sees seed=4 (put not committed) → also allowed
      const secondP = getMatrixTurnCredentials(turnEnv(kv), 3600, BOB);
      await vi.waitFor(() => {
        expect(ctl.putCount.get(RL_BOB)).toBe(2);
      });

      releasePut(RL_BOB);
      const [first, second] = await Promise.all([firstP, secondP]);
      expect(first.username).toBe('u');
      expect(second.username).toBe('u');
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// deleteThrows on expired ∥ healthy miss sibling (different key)
// ---------------------------------------------------------------------------

describe('race turn expired deleteThrow∥ttl sibling after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`deleteThrow on expired still refetches∥ttl300 miss ok flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ expiresAt: NOW - 1 })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        deleteThrows: [CREDS_KEY],
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('ok', 'ok'));

      // deleteThrow is caught by getCachedCredentials catch → treated as miss → fetch
      const [a, b] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 50),
      ]);

      expect(a.username).toBe('ok');
      expect(b.username).toBe('ok');
      expect(b.ttl).toBe(300);
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Config helpers under concurrent stress (stateless; still TOKENMAXX flood)
// ---------------------------------------------------------------------------

describe('race turn config helpers concurrent after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`stun∥status∥configured parallel flood-${i}`, async () => {
      const env = turnEnv(createRacingKv().kv);
      const [stun, status, configured, err] = await Promise.all([
        Promise.resolve(getStunServers()),
        Promise.resolve(getTurnStatus(env)),
        Promise.resolve(isTurnConfigured(env)),
        Promise.resolve(new TurnError('x', 'USER_RATE_LIMITED', 429, 1000)),
      ]);
      expect(stun.uris).toEqual(['stun:stun.cloudflare.com:3478']);
      expect(status).toEqual({ configured: true, keyId: 'turnkey1...' });
      expect(configured).toBe(true);
      expect(err).toMatchObject({ code: 'USER_RATE_LIMITED', retryAfterMs: 1000 });
    });
  }
});

// ---------------------------------------------------------------------------
// Hot cache hit ∥ miss sibling (different TTL key) under barriers
// ---------------------------------------------------------------------------

describe('race turn hot hit∥cold miss sibling after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`3600 hot hit∥300 cold miss parallel flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('cold', 'cold-pw'));

      const [hot, cold] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hot.username).toBe('hot');
      expect(hot.ttl).toBe(800);
      expect(cold.username).toBe('cold');
      expect(cold.ttl).toBe(300);
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY) ?? 0).toBe(0);
      expect(ctl.putCount.get(CREDS_KEY_TTL300)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// NOT_CONFIGURED ∥ configured sibling (separate envs, shared kv)
// ---------------------------------------------------------------------------

describe('race turn NOT_CONFIGURED∥configured sibling after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`missing secrets reject∥configured fetch ok flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      stubFetchOk(ctl);

      const [bad, good] = await Promise.allSettled([
        getMatrixTurnCredentials({ CACHE: kv } as Env, 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(bad.status).toBe('rejected');
      if (bad.status === 'rejected') {
        expect(bad.reason).toMatchObject({ code: 'NOT_CONFIGURED' });
      }
      expect(good.status).toBe('fulfilled');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// API 429 RATE_LIMITED ∥ cache hit sibling (no fetch for hit)
// ---------------------------------------------------------------------------

describe('race turn API 429∥cache hit sibling after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`cold miss 429∥hot hit no fetch flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot429' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          return new Response('', { status: 429, headers: { 'Retry-After': '12' } });
        })
      );

      const [hit, miss] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hit.status).toBe('fulfilled');
      if (hit.status === 'fulfilled') {
        expect(hit.value.username).toBe('hot429');
      }
      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({
          code: 'RATE_LIMITED',
          statusCode: 429,
          message: expect.stringContaining('12'),
        });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Rate-limit get jsonOverlay malformed / empty requests under race
// ---------------------------------------------------------------------------

describe('race turn rate-limit malformed overlay after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`null requests∥missing requests∥[] under parallel flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        jsonOverlay: {
          [RL_ALICE]: { requests: null },
          [RL_BOB]: {},
          [RL_CAROL]: { requests: [] },
        },
        getBarrier: [
          [RL_ALICE, 1],
          [RL_BOB, 1],
          [RL_CAROL, 1],
        ],
      });
      stubFetchOk(ctl);

      const settled = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
        getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL),
      ]);

      expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
      expect(ctl.fetchStarts).toBe(3);
      expect(ctl.putCount.get(RL_ALICE)).toBe(1);
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
      expect(ctl.putCount.get(RL_CAROL)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Three-way: ttl put-hold ∥ rate-limit alice ∥ hot bob
// ---------------------------------------------------------------------------

describe('race turn three-way ttl put-hold∥rl∥hot after tip', () => {
  for (let i = 0; i < 8; i++) {
    it(`300 put-hold∥alice rl∥bob 3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'bob-hot' })),
      };
      const { kv, ctl, releasePut } = createRacingKv({
        data,
        putHold: [CREDS_KEY_TTL300],
      });
      stubFetchOk(ctl, iceBody('miss-user', 'miss-pw'));

      let missDone = false;
      const missP = getMatrixTurnCredentials(turnEnv(kv), 300).then((r) => {
        missDone = true;
        return r;
      });

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${CREDS_KEY_TTL300}`))).toBe(true);
      });
      expect(missDone).toBe(false);

      const [alice, bob] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);
      // alice: rate-limit put + cache hit on 3600 hot
      expect(alice.username).toBe('bob-hot');
      expect(bob.username).toBe('bob-hot');
      expect(missDone).toBe(false);

      releasePut(CREDS_KEY_TTL300);
      const miss = await missP;
      expect(miss.username).toBe('miss-user');
      expect(miss.ttl).toBe(300);
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(RL_ALICE)).toBe(1);
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
    });
  }
});
