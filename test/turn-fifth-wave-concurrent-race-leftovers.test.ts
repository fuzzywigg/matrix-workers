/**
 * TOKENMAXX HEAVY tip-relaunch after #349/#350 (main ~59a0639) — residual
 * *turn* service concurrent-race / TOCTOU fifth-wave niches after #349
 * fourth-wave / tip past #333/#313/#299.
 *
 * Unsaturated by:
 *   #349 fourth-wave (iceServers []∥hot; null∥capped; string-urls;
 *        multi-cred pick-first; 401∥capped; partial-secrets∥capped;
 *        TTL 0/299/86401∥hot; rl null/string∥capped; putThrow(*);
 *        deleteHold∥capped∥hot; TypeError∥capped; 429 ""∥capped;
 *        NaN expiresAt∥capped; ttl-floor0∥miss; capped∥getThrow∥hot;
 *        short-key∥NOT_CONFIGURED∥INVALID; dual KEY miss; windowStart
 *        exact excluded; deleteThrow(*)∥capped; INVALID∥capped∥stun),
 *   #333 third-wave (RATE∥USER_RATE; expiresAt<now; cache overlay;
 *        putThrow∥capped; iceServers not-array/empty-urls; deleteThrow∥hot;
 *        stale∥capped; putBarrier; TTL triad; API_ERROR∥capped; four-way;
 *        getThrow(*); RATE∥INVALID∥hot; ttl-shrink∥capped; helpers∥RATE;
 *        omitted∥rl putThrow∥capped; cross KEY deleteThrow; retryAfter pin),
 *   #313 second-wave / #299 first-wave (see prior files).
 *
 * Gap table (why leftover after fourth-wave):
 *   API_ERROR empty body ∥ USER_RATE_LIMITED
 *     | second empty∥hot; third body∥capped
 *   fetch string reject ∥ USER_RATE_LIMITED
 *     | second string∥hot; fourth TypeError∥capped
 *   iceServers {} ∥ USER_RATE_LIMITED
 *     | third not-array∥valid; fourth []∥hot / null∥capped
 *   username-only ICE ∥ USER_RATE_LIMITED
 *     | second∥valid keyB only
 *   credential-only ICE ∥ hot
 *     | second both∥valid; never cred-only∥hot under PA
 *   TTL NaN miss ∥ 3600 hot
 *     | second NaN in -1/Inf triad only
 *   NEG_INFINITY → 300 ∥ USER_RATE_LIMITED
 *     | never under PA
 *   expiresAt===now deleteHold ∥ USER_RATE_LIMITED
 *     | first deleteHold alone; fourth deleteHold used NOW-5
 *   RATE_LIMITED+Retry-After ∥ INVALID ∥ USER_RATE_LIMITED
 *     | third RATE∥INVALID∥hot only
 *   seed=4 → 5th∥6th∥7th triple over-admit
 *     | first 5th∥6th pairwise only
 *   KEY_A hot ∥ KEY_B empty-token NOT_CONFIGURED
 *     | second/fourth partial∥configured or∥capped same key
 *   cache getThrow → miss refill ∥ USER_RATE_LIMITED
 *     | second getThrow∥hot300; never∥capped
 *   ttl-shrink mid get-hold ∥ cold miss sibling
 *     | first ttl clock alone; third ttl-shrink∥capped
 *   helpers∥USER_RATE_LIMITED∥NOT_CONFIGURED three-way
 *     | third helpers∥RATE; fourth short-key∥NOT_CONFIG∥INVALID
 *   malformed cache JSON parse-throw → miss ∥ hot
 *     | third null/{} overlay; never invalid JSON string under PA
 *   four-way API_ERROR ∥ capped ∥ healthy miss ∥ hot
 *     | third four-way put-hold∥capped∥healthy∥hot (no API fail)
 *   API 502 text() throw ∥ USER_RATE_LIMITED
 *     | second textThrow∥hot only
 *   exact expiresAt===now dual-delete ∥ USER_RATE_LIMITED sibling
 *     | second dual-delete alone; third <now dual-delete alone
 *   omitted-userId miss stampede ∥ capped (no hot)
 *     | second omitted∥capped shared hot path only
 *   putHold rl seed=4 ∥ sibling admit ∥ MAX hot three-way
 *     | first rl putHold∥sibling without hot
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
const CREDS_KEY = `turn_creds:${KEY_ID}:3600`;
const CREDS_KEY_TTL300 = `turn_creds:${KEY_ID}:300`;
const CREDS_KEY_MAX = `turn_creds:${KEY_ID}:86400`;
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
// API_ERROR empty body ∥ USER_RATE_LIMITED — second empty∥hot; third body∥capped
// ---------------------------------------------------------------------------

describe('race turn API_ERROR empty∥USER_RATE_LIMITED fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`300 empty 502∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [RL_ALICE, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          return new Response('', { status: 502 });
        })
      );

      const [miss, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({
          code: 'API_ERROR',
          statusCode: 502,
          message: 'TURN API returned 502',
        });
        expect(miss.reason).toBeInstanceOf(TurnError);
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// fetch string reject ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn fetch string reject∥USER_RATE_LIMITED fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`string reject Unknown error∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          throw 'socket-reset';
        })
      );

      const [miss, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({
          code: 'API_ERROR',
          message: 'Failed to connect to TURN API: Unknown error',
        });
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// iceServers {} ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn iceServers object∥USER_RATE_LIMITED fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`{} INVALID∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [RL_ALICE, 1],
        ],
      });
      const payload = { iceServers: {} };
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          return new Response(JSON.stringify(payload), { status: 200 });
        })
      );

      const [miss, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(String(miss.reason.message)).toBe(
          `TURN API response missing iceServers array. Got: ${JSON.stringify(payload)}`
        );
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// username-only ICE ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn username-only ICE∥USER_RATE_LIMITED fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`username-only INVALID∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          return new Response(
            JSON.stringify({
              iceServers: [{ urls: ['turn:x'], username: 'only-user' }],
            }),
            { status: 200 }
          );
        })
      );

      const [miss, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(String(miss.reason.message)).toContain('no server with credentials');
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// credential-only ICE ∥ hot
// ---------------------------------------------------------------------------

describe('race turn credential-only ICE∥hot fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`cred-only INVALID∥3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-cred' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [CREDS_KEY, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          return new Response(
            JSON.stringify({
              iceServers: [{ urls: ['turn:x'], credential: 'only-cred' }],
            }),
            { status: 200 }
          );
        })
      );

      const [miss, hot] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
      }
      expect(hot.status).toBe('fulfilled');
      if (hot.status === 'fulfilled') {
        expect(hot.value.username).toBe('hot-cred');
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// TTL NaN miss ∥ 3600 hot
// ---------------------------------------------------------------------------

describe('race turn TTL NaN miss∥hot fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`NaN quirky key miss∥3600 hot flood-${i}`, async () => {
      const nanKey = `turn_creds:${KEY_ID}:NaN`;
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-nan' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [nanKey, 1],
          [CREDS_KEY, 1],
        ],
      });
      const fetchMock = stubFetchOk(ctl, iceBody(`nan-${i}`, 'np'));

      const [nan, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), Number.NaN),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(Number.isNaN(nan.ttl)).toBe(true);
      expect(nan.username).toBe(`nan-${i}`);
      expect(hot.username).toBe('hot-nan');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.data[nanKey]).toBeDefined();
      expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ ttl: null }));
    });
  }
});

// ---------------------------------------------------------------------------
// NEG_INFINITY → 300 ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn NEG_INFINITY clamp∥USER_RATE_LIMITED fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`-Inf→300 miss∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [RL_ALICE, 1],
        ],
      });
      stubFetchOk(ctl, iceBody(`neginf-${i}`, 'ni'));

      const [neg, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), Number.NEGATIVE_INFINITY),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(neg.status).toBe('fulfilled');
      if (neg.status === 'fulfilled') {
        expect(neg.value.ttl).toBe(300);
        expect(neg.value.username).toBe(`neginf-${i}`);
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putTtl.get(CREDS_KEY_TTL300)).toBe(Math.floor(300 * 0.8));
    });
  }
});

// ---------------------------------------------------------------------------
// expiresAt===now deleteHold ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn exact expiresAt deleteHold∥capped fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`expiresAt===now delete-hold∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(
          cachedCreds({ username: 'exact-stale', expiresAt: NOW })
        ),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl, releaseDelete } = createRacingKv({
        data,
        deleteHold: [CREDS_KEY],
      });
      stubFetchOk(ctl, iceBody('post-exact', 'pe'));

      let missDone = false;
      const missP = getMatrixTurnCredentials(turnEnv(kv), 3600).then((r) => {
        missDone = true;
        return r;
      });

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`delete-wait:${CREDS_KEY}`))).toBe(true);
      });
      expect(missDone).toBe(false);

      const alice = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);
      expect(alice[0].status).toBe('rejected');
      if (alice[0].status === 'rejected') {
        expect(alice[0].reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(missDone).toBe(false);

      releaseDelete(CREDS_KEY);
      const miss = await missP;
      expect(miss.username).toBe('post-exact');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// RATE_LIMITED+Retry-After ∥ INVALID ∥ USER_RATE_LIMITED three-way
// ---------------------------------------------------------------------------

describe('race turn RATE∥INVALID∥USER_RATE three-way fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`429+RA∥bad JSON∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
          [RL_ALICE, 1],
        ],
      });
      let n = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          n += 1;
          if (n === 1) {
            return new Response('', { status: 429, headers: { 'Retry-After': '9' } });
          }
          return new Response('not-json{', { status: 200 });
        })
      );

      const [rate, inv, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(rate.status).toBe('rejected');
      if (rate.status === 'rejected') {
        expect(rate.reason).toMatchObject({
          code: 'RATE_LIMITED',
          statusCode: 429,
          message: expect.stringContaining('9'),
        });
      }
      expect(inv.status).toBe('rejected');
      if (inv.status === 'rejected') {
        expect(inv.reason).toMatchObject({
          code: 'INVALID_RESPONSE',
          message: 'Invalid JSON response from TURN API',
        });
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// seed=4 → 5th∥6th∥7th triple over-admit
// ---------------------------------------------------------------------------

describe('race turn seed4 5th∥6th∥7th over-admit fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`seed=4 → three concurrent all allow TOCTOU flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_BOB, 4);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [[RL_BOB, 3]],
      });
      stubFetchOk(ctl);

      const settled = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
      expect(ctl.fetchStarts).toBe(3);
      expect(ctl.putCount.get(RL_BOB)).toBe(3);
      const stored = JSON.parse(ctl.data[RL_BOB]) as { requests: number[] };
      // Lost-update: last writer = 4 seed + 1 push
      expect(stored.requests.length).toBe(5);
    });
  }
});

// ---------------------------------------------------------------------------
// KEY_A hot ∥ KEY_B empty-token NOT_CONFIGURED
// ---------------------------------------------------------------------------

describe('race turn KEY_A hot∥KEY_B empty-token fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`keyA hot hit∥keyB '' token NOT_CONFIGURED flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-a' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [[CREDS_KEY, 1]],
      });
      stubFetchOk(ctl);

      const [a, b] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(
          turnEnv(kv, { TURN_KEY_ID: KEY_ID_B, TURN_API_TOKEN: '' }),
          3600
        ),
      ]);

      expect(a.status).toBe('fulfilled');
      if (a.status === 'fulfilled') {
        expect(a.value.username).toBe('hot-a');
      }
      expect(b.status).toBe('rejected');
      if (b.status === 'rejected') {
        expect(b.reason).toMatchObject({
          code: 'NOT_CONFIGURED',
          message: 'TURN server not configured. Set TURN_KEY_ID and TURN_API_TOKEN.',
        });
      }
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// cache getThrow → miss refill ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn cache getThrow miss∥USER_RATE_LIMITED fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`3600 getThrow→refetch∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getThrows: [CREDS_KEY],
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
        ],
      });
      stubFetchOk(ctl, iceBody(`refetch-${i}`, 'rf'));

      const [miss, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(miss.status).toBe('fulfilled');
      if (miss.status === 'fulfilled') {
        expect(miss.value.username).toBe(`refetch-${i}`);
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// ttl-shrink mid get-hold ∥ cold miss sibling
// ---------------------------------------------------------------------------

describe('race turn ttl-shrink get-hold∥cold miss fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`get-hold shrink ttl∥300 cold miss flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ expiresAt: NOW + 800_000 })),
      };
      const { kv, ctl, releaseGet } = createRacingKv({
        data,
        getHold: [CREDS_KEY],
      });
      stubFetchOk(ctl, iceBody('cold', 'cp'));

      const hotP = getMatrixTurnCredentials(turnEnv(kv), 3600);
      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${CREDS_KEY}`))).toBe(true);
      });

      const coldP = getMatrixTurnCredentials(turnEnv(kv), 300);
      await vi.waitFor(() => {
        expect(ctl.fetchStarts).toBe(1);
      });

      vi.setSystemTime(NOW + 250_000);
      releaseGet(CREDS_KEY);

      const [hot, cold] = await Promise.all([hotP, coldP]);
      expect(hot.ttl).toBe(550);
      expect(hot.username).toBe('cached');
      expect(cold.username).toBe('cold');
      expect(cold.ttl).toBe(300);
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// helpers∥USER_RATE_LIMITED∥NOT_CONFIGURED three-way
// ---------------------------------------------------------------------------

describe('race turn helpers∥USER_RATE∥NOT_CONFIGURED fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`stun∥status∥alice capped∥empty NOT_CONFIGURED flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({ data });
      stubFetchOk(ctl);
      const env = turnEnv(kv);

      const [stun, status, configured, alice, empty] = await Promise.allSettled([
        Promise.resolve(getStunServers()),
        Promise.resolve(getTurnStatus(env)),
        Promise.resolve(isTurnConfigured(env)),
        getMatrixTurnCredentials(env, 3600, ALICE),
        getMatrixTurnCredentials({ CACHE: kv } as Env, 3600),
      ]);

      expect(stun.status).toBe('fulfilled');
      if (stun.status === 'fulfilled') {
        expect(stun.value.uris).toEqual(['stun:stun.cloudflare.com:3478']);
      }
      expect(status.status).toBe('fulfilled');
      if (status.status === 'fulfilled') {
        expect(status.value).toEqual({ configured: true, keyId: 'turnkey1...' });
      }
      expect(configured.status).toBe('fulfilled');
      if (configured.status === 'fulfilled') {
        expect(configured.value).toBe(true);
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(empty.status).toBe('rejected');
      if (empty.status === 'rejected') {
        expect(empty.reason).toMatchObject({ code: 'NOT_CONFIGURED' });
      }
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// malformed cache JSON parse-throw → miss ∥ hot
// ---------------------------------------------------------------------------

describe('race turn malformed cache JSON∥hot fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`invalid JSON string → miss refetch∥300 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: '{not-valid-json',
        [CREDS_KEY_TTL300]: JSON.stringify(
          cachedCreds({ username: 'hot300', ttl: 300, expiresAt: NOW + 200_000 })
        ),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      stubFetchOk(ctl, iceBody(`parsed-${i}`, 'pp'));

      const [miss, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(miss.username).toBe(`parsed-${i}`);
      expect(hot.username).toBe('hot300');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// four-way API_ERROR ∥ capped ∥ healthy miss ∥ hot
// ---------------------------------------------------------------------------

describe('race turn four-way API_ERROR∥capped∥miss∥hot fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`300 API_ERROR∥alice capped∥bob miss∥carol hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'carol-hot' })),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [RL_ALICE, 1],
          [RL_BOB, 1],
          [CREDS_KEY, 1],
        ],
      });
      let n = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          n += 1;
          if (n === 1) {
            // first fetch is ttl300 miss (alice doesn't fetch; bob may share 3600 hot)
            // Ordering: 300 miss fetches first typically; bob with userId hits rl then hot
            return new Response('nope', { status: 503 });
          }
          return new Response(JSON.stringify(iceBody('bob-ok', 'bo')), { status: 200 });
        })
      );

      const [miss300, alice, bob, carol] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
        getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL),
      ]);

      expect(miss300.status).toBe('rejected');
      if (miss300.status === 'rejected') {
        expect(miss300.reason).toMatchObject({ code: 'API_ERROR', statusCode: 503 });
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      // bob: rl allow + 3600 hot hit — no second fetch
      expect(bob.status).toBe('fulfilled');
      if (bob.status === 'fulfilled') {
        expect(bob.value.username).toBe('carol-hot');
      }
      expect(carol.status).toBe('fulfilled');
      if (carol.status === 'fulfilled') {
        expect(carol.value.username).toBe('carol-hot');
      }
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
      expect(ctl.putCount.get(RL_CAROL)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// API 502 text() throw ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn API textThrow∥USER_RATE_LIMITED fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`text() throw 500∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
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

      const [miss, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({
          code: 'API_ERROR',
          message: 'TURN API returned 500',
        });
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// exact expiresAt===now dual-delete ∥ USER_RATE_LIMITED sibling
// ---------------------------------------------------------------------------

describe('race turn exact dual-delete∥USER_RATE_LIMITED fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`dual delete+fetch∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'exact', expiresAt: NOW })),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 2],
          [RL_ALICE, 1],
        ],
        deleteBarrier: [[CREDS_KEY, 2]],
      });
      stubFetchOk(ctl, iceBody(`fresh-${i}`, 'fp'));

      const [a, b, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(a.status).toBe('fulfilled');
      if (a.status === 'fulfilled') {
        expect(a.value.username).toBe(`fresh-${i}`);
      }
      expect(b.status).toBe('fulfilled');
      if (b.status === 'fulfilled') {
        expect(b.value.username).toBe(`fresh-${i}`);
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(2);
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// omitted-userId miss stampede ∥ capped (no hot)
// ---------------------------------------------------------------------------

describe('race turn omitted-userId stampede∥capped fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`2 omitted miss stampede∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 2],
          [RL_ALICE, 1],
        ],
      });
      stubFetchOk(ctl, iceBody(`anon-${i}`, 'ap'));

      const [a, b, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(a.status).toBe('fulfilled');
      expect(b.status).toBe('fulfilled');
      if (a.status === 'fulfilled') {
        expect(a.value.username).toBe(`anon-${i}`);
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(2);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(2);
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// putHold rl seed=4 ∥ sibling admit ∥ MAX hot three-way
// ---------------------------------------------------------------------------

describe('race turn rl putHold∥sibling∥MAX hot fifth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`bob put-hold TOCTOU∥sibling∥86400 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY_MAX]: JSON.stringify(
          cachedCreds({
            username: 'max-hot',
            ttl: 86400,
            expiresAt: NOW + 60_000_000,
          })
        ),
      };
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

      // Pin clock again after waitFor polls (fake-timer drift)
      vi.setSystemTime(NOW);

      // MAX hot completes while rl put is held (no bob rl touch)
      const max = await getMatrixTurnCredentials(turnEnv(kv), 99_999);
      expect(max.username).toBe('max-hot');
      expect(max.ttl).toBe(60_000);
      expect(firstDone).toBe(false);

      // Sibling also admits (seed still 4) and joins put-hold
      const sibP = getMatrixTurnCredentials(turnEnv(kv), 3600, BOB);
      await vi.waitFor(() => {
        expect(ctl.putCount.get(RL_BOB)).toBe(2);
      });
      expect(firstDone).toBe(false);

      releasePut(RL_BOB);
      const [first, sib] = await Promise.all([firstP, sibP]);
      expect(first.username).toBe('u');
      expect(sib.username).toBe('u');
      expect(ctl.fetchStarts).toBe(2); // first + sibling both miss 3600
      expect(ctl.putCount.get(RL_BOB)).toBe(2);
    });
  }
});
