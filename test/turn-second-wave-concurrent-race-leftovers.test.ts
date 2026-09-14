/**
 * TOKENMAXX HEAVY leftovers after #299 — second-wave *turn* service
 * concurrent-race / TOCTOU niches not covered by turn-concurrent-race
 * leftovers (#299) or sequential turn-helpers.
 *
 * Unsaturated after #299:
 *   - API_ERROR / INVALID_RESPONSE / fetch-throw ∥ hot cache hit
 *   - API 429 missing Retry-After ∥ hot hit
 *   - rate-limit putThrow fail-open ∥ capped / healthy sibling
 *   - cache getThrow miss ∥ hot hit (cross-TTL)
 *   - TTL NaN / -1 / Infinity / MAX clamp key isolation under barriers
 *   - exact expiresAt dual-delete stampede
 *   - empty-string / partial secrets NOT_CONFIGURED ∥ configured
 *   - retryAfterMs floor near window end under parallel barriers
 *   - clock advance mid get-hold: now TOCTOU-pinned before await → still capped
 *   - omitted default ttl=3600 same-key race
 *   - username-only / credential-only ICE ∥ valid sibling
 *   - three-way: API fail ∥ USER_RATE_LIMITED ∥ hot hit
 *
 * Tests-only. example.com fixtures only. No product inventing.
 * Reversible by deleting this file.
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
const DAVE = '@dave:example.com';
const CREDS_KEY = `turn_creds:${KEY_ID}:3600`;
const CREDS_KEY_TTL300 = `turn_creds:${KEY_ID}:300`;
const CREDS_KEY_MAX = `turn_creds:${KEY_ID}:86400`;
const CREDS_KEY_B = `turn_creds:${KEY_ID_B}:3600`;
const RL_ALICE = `turn_ratelimit:${ALICE}`;
const RL_BOB = `turn_ratelimit:${BOB}`;
const RL_CAROL = `turn_ratelimit:${CAROL}`;
const RL_DAVE = `turn_ratelimit:${DAVE}`;

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
// API_ERROR (non-OK) ∥ hot cache hit — unsaturated after #299 (only 429∥hit)
// ---------------------------------------------------------------------------

describe('race turn API_ERROR∥hot hit second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`cold miss 503 body∥3600 hot hit flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot503' })),
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
          return new Response('upstream down', { status: 503 });
        })
      );

      const [hit, miss] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hit.status).toBe('fulfilled');
      if (hit.status === 'fulfilled') {
        expect(hit.value.username).toBe('hot503');
      }
      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({
          code: 'API_ERROR',
          statusCode: 503,
          message: 'TURN API returned 503: upstream down',
        });
      }
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY_TTL300) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Fetch throw (Error + non-Error) ∥ hot hit
// ---------------------------------------------------------------------------

describe('race turn fetch-throw∥hot hit second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`dns Error reject∥hot hit no fetch for hit flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-dns' })),
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
          throw new Error('dns fail');
        })
      );

      const [hit, miss] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 50),
      ]);

      expect(hit.status).toBe('fulfilled');
      if (hit.status === 'fulfilled') {
        expect(hit.value.username).toBe('hot-dns');
      }
      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({
          code: 'API_ERROR',
          message: 'Failed to connect to TURN API: dns fail',
        });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

describe('race turn fetch non-Error reject∥hot hit second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`string reject → Unknown error∥hot hit flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-str' })),
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
          throw 'boom';
        })
      );

      const [hit, miss] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hit.status).toBe('fulfilled');
      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({
          code: 'API_ERROR',
          message: 'Failed to connect to TURN API: Unknown error',
        });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// INVALID_RESPONSE variants ∥ hot hit
// ---------------------------------------------------------------------------

describe('race turn INVALID_RESPONSE∥hot hit second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`bad JSON∥empty iceServers∥no creds∥hot hit flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-inv' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 3],
        ],
      });
      let n = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          n += 1;
          if (n === 1) return new Response('not-json{', { status: 200 });
          if (n === 2) return new Response(JSON.stringify({ iceServers: [] }), { status: 200 });
          return new Response(
            JSON.stringify({ iceServers: [{ urls: ['stun:only'] }] }),
            { status: 200 }
          );
        })
      );

      const [hit, badJson, empty, noCred] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hit.status).toBe('fulfilled');
      if (hit.status === 'fulfilled') {
        expect(hit.value.username).toBe('hot-inv');
      }
      expect(badJson.status).toBe('rejected');
      if (badJson.status === 'rejected') {
        expect(badJson.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect((badJson.reason as TurnError).message).toBe(
          'Invalid JSON response from TURN API'
        );
      }
      expect(empty.status).toBe('rejected');
      if (empty.status === 'rejected') {
        expect(empty.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect((empty.reason as TurnError).message).toContain('missing iceServers array');
      }
      expect(noCred.status).toBe('rejected');
      if (noCred.status === 'rejected') {
        expect(noCred.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect((noCred.reason as TurnError).message).toContain(
          'no server with credentials'
        );
      }
      expect(ctl.fetchStarts).toBe(3);
    });
  }
});

// ---------------------------------------------------------------------------
// API 429 without Retry-After ∥ hot hit
// ---------------------------------------------------------------------------

describe('race turn 429 missing Retry-After∥hot hit second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`429 no header → unknown seconds∥hot hit flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-unk' })),
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
          return new Response('', { status: 429 });
        })
      );

      const [hit, miss] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hit.status).toBe('fulfilled');
      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({
          code: 'RATE_LIMITED',
          statusCode: 429,
          message: 'TURN API rate limited. Retry after unknown seconds.',
        });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Rate-limit putThrow fail-open ∥ capped / healthy siblings
// ---------------------------------------------------------------------------

describe('race turn rate-limit putThrow fail-open∥siblings second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`alice putThrow fail-open∥bob capped∥carol healthy flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_BOB, 5);
      const { kv, ctl } = createRacingKv({
        data,
        putThrows: [RL_ALICE],
        getBarrier: [
          [RL_ALICE, 1],
          [RL_BOB, 1],
          [RL_CAROL, 1],
        ],
      });
      stubFetchOk(ctl);

      const [alice, bob, carol] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
        getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL),
      ]);

      // putThrow → catch fail-open → allowed (no persisted alice rl)
      expect(alice.status).toBe('fulfilled');
      expect(bob.status).toBe('rejected');
      if (bob.status === 'rejected') {
        expect(bob.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(carol.status).toBe('fulfilled');
      expect(ctl.putCount.get(RL_ALICE)).toBe(1); // attempted
      expect(ctl.data[RL_ALICE]).toBeUndefined();
      expect(ctl.putCount.get(RL_CAROL)).toBe(1);
      expect(ctl.putCount.get(RL_BOB) ?? 0).toBe(0);
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Cache getThrow miss ∥ hot hit (cross-TTL)
// ---------------------------------------------------------------------------

describe('race turn cache getThrow miss∥hot hit second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`3600 getThrow→miss refetch∥300 hot hit flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY_TTL300]: JSON.stringify(
          cachedCreds({ username: 'hot300', ttl: 300, expiresAt: NOW + 200_000 })
        ),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getThrows: [CREDS_KEY],
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('refetch', 'rf'));

      const [miss, hit] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(miss.username).toBe('refetch');
      expect(hit.username).toBe('hot300');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY_TTL300) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// TTL NaN / -1 / Infinity clamp under parallel barriers
// ---------------------------------------------------------------------------

describe('race turn TTL NaN/-1/Infinity clamp second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`-1→300∥+Inf→86400∥NaN quirky key under barriers flood-${i}`, async () => {
      const nanKey = `turn_creds:${KEY_ID}:NaN`;
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [CREDS_KEY_MAX, 1],
          [nanKey, 1],
        ],
      });
      const fetchMock = stubFetchOk(ctl);

      const [neg, inf, nan] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), -1),
        getMatrixTurnCredentials(turnEnv(kv), Number.POSITIVE_INFINITY),
        getMatrixTurnCredentials(turnEnv(kv), Number.NaN),
      ]);

      expect(neg.ttl).toBe(300);
      expect(inf.ttl).toBe(86400);
      // NaN propagates through Math.max/min → body ttl null; cache key uses NaN
      expect(Number.isNaN(nan.ttl)).toBe(true);
      expect(ctl.fetchStarts).toBe(3);
      expect(ctl.data[CREDS_KEY_TTL300]).toBeDefined();
      expect(ctl.data[CREDS_KEY_MAX]).toBeDefined();
      expect(ctl.data[nanKey]).toBeDefined();
      expect(ctl.putTtl.get(CREDS_KEY_TTL300)).toBe(Math.floor(300 * 0.8));
      expect(ctl.putTtl.get(CREDS_KEY_MAX)).toBe(Math.floor(86400 * 0.8));
      const bodies = fetchMock.mock.calls.map((c) => c[1].body as string);
      expect(bodies).toHaveLength(3);
      expect(bodies).toContain(JSON.stringify({ ttl: null }));
      expect(bodies).toContain(JSON.stringify({ ttl: 300 }));
      expect(bodies).toContain(JSON.stringify({ ttl: 86400 }));
    });
  }
});

// ---------------------------------------------------------------------------
// Exact expiresAt dual-delete stampede
// ---------------------------------------------------------------------------

describe('race turn exact expiresAt dual-delete stampede second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`two callers both see expiresAt===now → dual delete+fetch flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'exact', expiresAt: NOW })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [[CREDS_KEY, 2]],
        deleteBarrier: [[CREDS_KEY, 2]],
      });
      stubFetchOk(ctl, iceBody(`fresh-${i}`, 'fp'));

      const [a, b] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(a.username).toBe(`fresh-${i}`);
      expect(b.username).toBe(`fresh-${i}`);
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(2);
      expect(ctl.fetchStarts).toBe(2);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Empty-string / partial secrets NOT_CONFIGURED ∥ configured
// ---------------------------------------------------------------------------

describe('race turn empty/partial secrets∥configured second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`'' key∥'' token∥key-only∥token-only∥configured flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      stubFetchOk(ctl);

      const settled = await Promise.allSettled([
        getMatrixTurnCredentials(
          turnEnv(kv, { TURN_KEY_ID: '', TURN_API_TOKEN: 'turn-token' }),
          3600
        ),
        getMatrixTurnCredentials(
          turnEnv(kv, { TURN_KEY_ID: KEY_ID, TURN_API_TOKEN: '' }),
          3600
        ),
        getMatrixTurnCredentials({ CACHE: kv, TURN_KEY_ID: KEY_ID } as Env, 3600),
        getMatrixTurnCredentials({ CACHE: kv, TURN_API_TOKEN: 'turn-token' } as Env, 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      for (let j = 0; j < 4; j++) {
        expect(settled[j].status).toBe('rejected');
        if (settled[j].status === 'rejected') {
          expect(settled[j].reason).toMatchObject({
            code: 'NOT_CONFIGURED',
            message:
              'TURN server not configured. Set TURN_KEY_ID and TURN_API_TOKEN.',
          });
        }
      }
      expect(settled[4].status).toBe('fulfilled');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// retryAfterMs floor near window end under parallel barriers
// ---------------------------------------------------------------------------

describe('race turn retryAfterMs floor near window end second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`seed=5 with oldest≈now-59.5s → floor≥1000 under barrier flood-${i}`, async () => {
      const data: Record<string, string> = {
        [RL_ALICE]: JSON.stringify({
          requests: [
            NOW - 59_500,
            NOW - 50_000,
            NOW - 40_000,
            NOW - 30_000,
            NOW - 20_000,
          ],
        }),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [[RL_ALICE, 2]],
      });
      stubFetchOk(ctl);

      const settled = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(settled.every((s) => s.status === 'rejected')).toBe(true);
      for (const s of settled) {
        if (s.status === 'rejected') {
          const te = s.reason as TurnError;
          expect(te.code).toBe('USER_RATE_LIMITED');
          expect(te.retryAfterMs!).toBeGreaterThanOrEqual(1000);
          // raw would be ~500ms; floor clamps to 1000
          expect(te.retryAfterMs).toBe(1000);
          expect(te.message).toBe('Rate limited. Try again in 1000ms.');
        }
      }
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Window advance during get-hold: now pinned BEFORE await → still capped
// (documents TOCTOU: Date.now() runs before cache.get barrier)
// ---------------------------------------------------------------------------

describe('race turn window advance mid get-hold still capped second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`seed=5 held; advance 61s; still USER_RATE_LIMITED (now TOCTOU) flood-${i}`, async () => {
      const data: Record<string, string> = {};
      // Stamps near window edge: would expire if now were re-read after advance
      seedRateLimit(data, RL_DAVE, 5, NOW - 59_000);
      const { kv, ctl, releaseGet } = createRacingKv({
        data,
        getHold: [RL_DAVE],
      });
      stubFetchOk(ctl);

      const p = getMatrixTurnCredentials(turnEnv(kv), 3600, DAVE);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${RL_DAVE}`))).toBe(true);
      });

      // Clock advances during KV get-hold, but checkUserRateLimit already
      // captured `now` before await → still sees all 5 in-window.
      vi.setSystemTime(NOW + 61_000);
      releaseGet(RL_DAVE);
      await expect(p).rejects.toMatchObject({
        code: 'USER_RATE_LIMITED',
        statusCode: 429,
      });
      expect(ctl.fetchStarts).toBe(0);
      expect(ctl.putCount.get(RL_DAVE) ?? 0).toBe(0);

      // Fresh call after advance re-reads Date.now() → stamps outside window → allow
      await expect(
        getMatrixTurnCredentials(turnEnv(kv), 3600, DAVE)
      ).resolves.toMatchObject({ username: 'u' });
      expect(ctl.fetchStarts).toBe(1);
      const stored = JSON.parse(ctl.data[RL_DAVE]) as { requests: number[] };
      expect(stored.requests).toEqual([NOW + 61_000]);
    });
  }
});

// ---------------------------------------------------------------------------
// Omitted default ttl=3600 same-key race with explicit 3600
// ---------------------------------------------------------------------------

describe('race turn default ttl omitted∥explicit 3600 second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`omitted default∥explicit 3600 share CREDS_KEY stampede flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[CREDS_KEY, 2]],
      });
      stubFetchOk(ctl, iceBody(`def-${i}`, 'dp'));

      const [a, b] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv)), // default 3600
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(a.username).toBe(`def-${i}`);
      expect(b.username).toBe(`def-${i}`);
      expect(a.ttl).toBe(3600);
      expect(b.ttl).toBe(3600);
      expect(ctl.fetchStarts).toBe(2);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Username-only / credential-only ICE ∥ valid sibling (cross key)
// ---------------------------------------------------------------------------

describe('race turn username/credential-only ICE∥valid second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`user-only∥cred-only∥valid keyB flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [CREDS_KEY, 2],
          [CREDS_KEY_B, 1],
        ],
      });
      let n = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          ctl.fetchStarts += 1;
          if (String(url).includes(KEY_ID_B)) {
            return new Response(JSON.stringify(iceBody(`ok-b-${i}`, 'ok')), {
              status: 200,
            });
          }
          n += 1;
          if (n === 1) {
            return new Response(
              JSON.stringify({
                iceServers: [{ urls: ['turn:x'], username: 'only-user' }],
              }),
              { status: 200 }
            );
          }
          return new Response(
            JSON.stringify({
              iceServers: [{ urls: ['turn:x'], credential: 'only-cred' }],
            }),
            { status: 200 }
          );
        })
      );

      const [userOnly, credOnly, valid] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv, { TURN_KEY_ID: KEY_ID_B }), 3600),
      ]);

      expect(userOnly.status).toBe('rejected');
      if (userOnly.status === 'rejected') {
        expect(userOnly.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
      }
      expect(credOnly.status).toBe('rejected');
      if (credOnly.status === 'rejected') {
        expect(credOnly.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
      }
      expect(valid.status).toBe('fulfilled');
      if (valid.status === 'fulfilled') {
        expect(valid.value.username).toBe(`ok-b-${i}`);
      }
      expect(ctl.fetchStarts).toBe(3);
      expect(ctl.data[CREDS_KEY_B]).toBeDefined();
      expect(ctl.data[CREDS_KEY]).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// Three-way: API fail ∥ USER_RATE_LIMITED ∥ hot hit
// ---------------------------------------------------------------------------

describe('race turn three-way API fail∥capped∥hot second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`300 API_ERROR∥alice capped∥bob 3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'bob-hot' })),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
          [RL_ALICE, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          return new Response('nope', { status: 502 });
        })
      );

      const [miss, alice, bob] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({ code: 'API_ERROR', statusCode: 502 });
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(bob.status).toBe('fulfilled');
      if (bob.status === 'fulfilled') {
        expect(bob.value.username).toBe('bob-hot');
      }
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// API_ERROR empty body / text() throw ∥ hot hit
// ---------------------------------------------------------------------------

describe('race turn API_ERROR empty/textThrow∥hot hit second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`empty body∥text() throw∥hot hit flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-body' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 2],
        ],
      });
      let n = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          n += 1;
          if (n === 1) {
            return new Response('', { status: 500 });
          }
          return {
            ok: false,
            status: 500,
            headers: new Headers(),
            text: async () => {
              throw new Error('body read fail');
            },
          } as unknown as Response;
        })
      );

      const [hit, empty, textThrow] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hit.status).toBe('fulfilled');
      expect(empty.status).toBe('rejected');
      if (empty.status === 'rejected') {
        expect(empty.reason).toMatchObject({
          code: 'API_ERROR',
          message: 'TURN API returned 500',
        });
      }
      expect(textThrow.status).toBe('rejected');
      if (textThrow.status === 'rejected') {
        expect(textThrow.reason).toMatchObject({
          code: 'API_ERROR',
          message: 'TURN API returned 500',
        });
      }
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// MAX_TTL hot hit ∥ MIN miss under barriers
// ---------------------------------------------------------------------------

describe('race turn MAX hot∥MIN miss second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`86400 hot∥300 cold miss parallel flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY_MAX]: JSON.stringify(
          cachedCreds({
            username: 'max-hot',
            ttl: 86400,
            expiresAt: NOW + 60_000_000,
          })
        ),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_MAX, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('min-cold', 'mc'));

      const [max, min] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 99_999), // clamps → 86400
        getMatrixTurnCredentials(turnEnv(kv), 1), // clamps → 300
      ]);

      expect(max.username).toBe('max-hot');
      expect(max.ttl).toBe(60_000);
      expect(min.username).toBe('min-cold');
      expect(min.ttl).toBe(300);
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY_TTL300)).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY_MAX) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Config helpers: empty/partial/short key under concurrent stress
// ---------------------------------------------------------------------------

describe('race turn config helpers edge flood second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`stun∥status edges∥configured edges parallel flood-${i}`, async () => {
      const empty = {} as Env;
      const short = { TURN_KEY_ID: 'abcd', TURN_API_TOKEN: 't' } as Env;
      const long = {
        TURN_KEY_ID: 'abcdefghijklmnop',
        TURN_API_TOKEN: 't',
      } as Env;
      const keyOnly = { TURN_KEY_ID: KEY_ID } as Env;
      const tokenOnly = { TURN_API_TOKEN: 't' } as Env;

      const [stun, stEmpty, stShort, stLong, cEmpty, cKey, cTok, cOk, err] =
        await Promise.all([
          Promise.resolve(getStunServers()),
          Promise.resolve(getTurnStatus(empty)),
          Promise.resolve(getTurnStatus(short)),
          Promise.resolve(getTurnStatus(long)),
          Promise.resolve(isTurnConfigured(empty)),
          Promise.resolve(isTurnConfigured(keyOnly)),
          Promise.resolve(isTurnConfigured(tokenOnly)),
          Promise.resolve(isTurnConfigured(long)),
          Promise.resolve(new TurnError('x', 'API_ERROR', 502)),
        ]);

      expect(stun.uris).toEqual(['stun:stun.cloudflare.com:3478']);
      expect(stEmpty).toEqual({ configured: false, keyId: undefined });
      expect(stShort).toEqual({ configured: true, keyId: 'abcd...' });
      expect(stLong).toEqual({ configured: true, keyId: 'abcdefgh...' });
      expect(cEmpty).toBe(false);
      expect(cKey).toBe(false);
      expect(cTok).toBe(false);
      expect(cOk).toBe(true);
      expect(err).toMatchObject({ code: 'API_ERROR', statusCode: 502 });
    });
  }
});

// ---------------------------------------------------------------------------
// Rate-limit getThrow fail-open ∥ capped sibling (seed=5)
// ---------------------------------------------------------------------------

describe('race turn rl getThrow fail-open∥capped sibling second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`alice getThrow fail-open∥bob seed=5 reject flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_BOB, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getThrows: [RL_ALICE],
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

      expect(alice.status).toBe('fulfilled');
      expect(bob.status).toBe('rejected');
      if (bob.status === 'rejected') {
        expect(bob.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Expired get-hold: clock already past; sibling hot different key
// ---------------------------------------------------------------------------

describe('race turn expired get-hold∥hot sibling second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`expire get-hold then advance; sibling 300 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(
          cachedCreds({ username: 'about-to-expire', expiresAt: NOW + 5_000 })
        ),
        [CREDS_KEY_TTL300]: JSON.stringify(
          cachedCreds({ username: 'hot300', ttl: 300, expiresAt: NOW + 200_000 })
        ),
      };
      const { kv, ctl, releaseGet } = createRacingKv({
        data,
        getHold: [CREDS_KEY],
      });
      stubFetchOk(ctl, iceBody('post-exp', 'pe'));

      let expireDone = false;
      const expireP = getMatrixTurnCredentials(turnEnv(kv), 3600).then((r) => {
        expireDone = true;
        return r;
      });

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${CREDS_KEY}`))).toBe(true);
      });

      const hotP = getMatrixTurnCredentials(turnEnv(kv), 300);
      vi.setSystemTime(NOW + 10_000); // past expiresAt
      releaseGet(CREDS_KEY);

      const [expired, hot] = await Promise.all([expireP, hotP]);
      expect(expireDone).toBe(true);
      expect(expired.username).toBe('post-exp');
      expect(hot.username).toBe('hot300');
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross KEY_ID: A miss API fail ∥ B hot hit
// ---------------------------------------------------------------------------

describe('race turn cross KEY_ID API fail∥hot hit second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`keyA miss 401∥keyB hot hit flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY_B]: JSON.stringify(cachedCreds({ username: 'hot-b' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_B, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          return new Response('unauthorized', { status: 401 });
        })
      );

      const [a, b] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv, { TURN_KEY_ID: KEY_ID_B }), 3600),
      ]);

      expect(a.status).toBe('rejected');
      if (a.status === 'rejected') {
        expect(a.reason).toMatchObject({
          code: 'API_ERROR',
          statusCode: 401,
          message: 'TURN API returned 401: unauthorized',
        });
      }
      expect(b.status).toBe('fulfilled');
      if (b.status === 'fulfilled') {
        expect(b.value.username).toBe('hot-b');
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// userId omitted ∥ rate-limited user same cache key (no rl put for omitted)
// ---------------------------------------------------------------------------

describe('race turn omitted userId∥capped user second-wave after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`no-userId miss∥alice capped share hot path flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'shared-hot' })),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
        ],
      });
      stubFetchOk(ctl);

      const [anon, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600), // no userId
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(anon.status).toBe('fulfilled');
      if (anon.status === 'fulfilled') {
        expect(anon.value.username).toBe('shared-hot');
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(0);
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
    });
  }
});
