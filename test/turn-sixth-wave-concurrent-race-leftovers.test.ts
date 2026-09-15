/**
 * TOKENMAXX HEAVY tip-relaunch after #380 (main ~320fea0) — residual
 * *turn* service concurrent-race / TOCTOU sixth-wave niches after merged
 * #349 fourth-wave. Closed #374 reused fifth niches (misnamed); this file
 * is **disjoint** from open fifth-wave drafts (#389/#392 / closed #382
 * gap table) and from #349/#333/#313/#299.
 *
 * Unsaturated by:
 *   #349 fourth-wave (iceServers []/null; string-urls; multi-cred
 *        pick-first; 401∥capped; partial-secrets∥capped; TTL 0/299/86401;
 *        rl null/string; putThrow(*); deleteHold∥capped∥hot; TypeError∥capped;
 *        429 empty Retry-After∥capped; NaN expiresAt; ttl floor0; three-way
 *        capped∥getThrow∥hot; short-key status; dual KEY_ID miss;
 *        windowStart exact; deleteThrow(*); INVALID∥capped∥stun),
 *   fifth-wave drafts (whitespace secrets; Retry-After 0/abc; expiresAt
 *        null/missing/0; empty-string creds; multi-user stampede; dual
 *        putHold; TTL 301/86399; AbortError; urls undefined; rl number;
 *        four-way NOT_CONFIGURED; deleteHold+putHold; whitespace KEY_ID;
 *        cross putThrow; urls:[]; seed0 eight-way; helpers matrix),
 *   #333/#313/#299 (see prior leftovers headers).
 *
 * Gap table (why leftover / disjoint from fifth):
 *   Infinity expiresAt quirky hit ∥ USER_RATE_LIMITED
 *     | fourth NaN; fifth null/missing/0 — never +Infinity
 *   -Infinity expiresAt expire-delete ∥ hot
 *     | never -Infinity under PA
 *   expiresAt string "nan" quirky hit (NaN<=now false) ∥ capped
 *     | fourth numeric NaN overlay only
 *   rl requests:[] empty allow ∥ capped
 *     | fourth null/string; fifth number — never []
 *   rl future-only stamps still count toward cap ∥ hot
 *     | windowStart filter keeps t>windowStart including future
 *   TTL +Infinity → MAX key ∥ 3600 hot
 *     | second Inf sequential; never under PA with hot sibling
 *   TTL -Infinity → MIN 300 key ∥ hot
 *     | never -Inf clamp under PA
 *   API 500 text() throw → bare status message ∥ capped
 *     | never body-read throw under PA
 *   429 Retry-After:"60" exact message ∥ USER_RATE_LIMITED
 *     | fourth empty; fifth 0/abc — never "60"
 *   iceServers string (non-array) INVALID ∥ hot
 *     | third object not-array; fourth []/null
 *   credentialed urls:null → stun-only ∥ capped
 *     | fifth urls undefined; fourth string-urls
 *   duplicate ice URL entries kept flattened ∥ hot
 *     | never dupe flatten under PA
 *   username-only∥credential-only both fail find ∥ full-creds OK
 *     | second missing-field sequential; never dual partial∥OK under PA
 *   getHold CREDS mid-put lost-update ∥ capped
 *     | first put-hold; never getHold∥put mid∥capped triad
 *   cross KEY_ID getThrow(*) dual-miss→fetch ∥ stun∥status
 *     | third getThrow(*); fourth dual miss — never *∥cross∥stun under PA
 *   putTtl 3600→2880 pin ∥ USER_RATE_LIMITED
 *     | fourth clamp putTtl; never default 2880∥capped under PA
 *   retryAfterMs floor when oldest≈window edge (→1000) ∥ hot
 *     | third exact pin; never near-elapsed∥hot under PA
 *   four-way RATE_LIMITED∥INVALID∥capped∥stun
 *     | fifth NOT_CONFIGURED∥API_ERROR∥capped∥hot
 *   cached empty-password hit still served ∥ cold miss sibling
 *     | never empty password cache hit under PA
 *   urls:number non-array flatMap scalar ∥ capped
 *     | fourth string-urls; never numeric urls under PA
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
// Infinity expiresAt quirky hit ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn Infinity expiresAt hit∥capped sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`+Infinity expiresAt hit∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        jsonOverlay: {
          [CREDS_KEY]: cachedCreds({ username: 'inf-hit', expiresAt: Number.POSITIVE_INFINITY }),
        },
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
        ],
      });
      stubFetchOk(ctl);

      const [hit, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(hit.status).toBe('fulfilled');
      if (hit.status === 'fulfilled') {
        expect(hit.value.username).toBe('inf-hit');
        expect(hit.value.ttl).toBe(Number.POSITIVE_INFINITY);
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(0);
      expect(ctl.deleteCount.get(CREDS_KEY) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// -Infinity expiresAt expire-delete ∥ hot
// ---------------------------------------------------------------------------

describe('race turn -Infinity expiresAt expire∥hot sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`-Infinity expiresAt delete∥300 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY_TTL300]: JSON.stringify(
          cachedCreds({ username: 'hot300', ttl: 300, expiresAt: NOW + 200_000 })
        ),
      };
      const { kv, ctl } = createRacingKv({
        data,
        jsonOverlay: {
          [CREDS_KEY]: cachedCreds({ username: 'neg-inf', expiresAt: Number.NEGATIVE_INFINITY }),
        },
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('after-neg', 'an'));

      const [refill, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(refill.username).toBe('after-neg');
      expect(hot.username).toBe('hot300');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// expiresAt string "nan" quirky hit (NaN<=now false) ∥ capped
// ---------------------------------------------------------------------------

describe('race turn string-nan expiresAt quirky-hit∥capped sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`expiresAt:"nan" hit∥bob capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_BOB, 5);
      const { kv, ctl } = createRacingKv({
        data,
        jsonOverlay: {
          [CREDS_KEY]: cachedCreds({ username: 'str-nan', expiresAt: 'nan' }),
        },
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_BOB, 1],
        ],
      });
      stubFetchOk(ctl);

      const [hit, bob] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(hit.status).toBe('fulfilled');
      if (hit.status === 'fulfilled') {
        expect(hit.value.username).toBe('str-nan');
        expect(Number.isNaN(hit.value.ttl)).toBe(true);
      }
      expect(bob.status).toBe('rejected');
      if (bob.status === 'rejected') {
        expect(bob.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// rl requests:[] empty allow ∥ capped
// ---------------------------------------------------------------------------

describe('race turn rl requests empty-array∥capped sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`bob [] allow∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {
        [RL_BOB]: JSON.stringify({ requests: [] }),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [RL_ALICE, 1],
          [RL_BOB, 1],
          [CREDS_KEY, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('empty-rl', 'er'));

      const [alice, bob] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(bob.status).toBe('fulfilled');
      if (bob.status === 'fulfilled') {
        expect(bob.value.username).toBe('empty-rl');
      }
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
      const bobRl = JSON.parse(ctl.data[RL_BOB]!) as { requests: number[] };
      expect(bobRl.requests).toHaveLength(1);
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// rl future-only stamps still count toward cap ∥ hot
// ---------------------------------------------------------------------------

describe('race turn rl future-stamps count∥hot sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`alice future×5 capped∥carol hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-future' })),
        [RL_ALICE]: JSON.stringify({
          requests: [NOW + 1, NOW + 2, NOW + 3, NOW + 4, NOW + 5],
        }),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [RL_ALICE, 1],
          [CREDS_KEY, 1],
        ],
      });
      stubFetchOk(ctl);

      const [alice, hot] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
        expect(alice.reason.retryAfterMs).toBeGreaterThanOrEqual(1000);
      }
      expect(hot.status).toBe('fulfilled');
      if (hot.status === 'fulfilled') {
        expect(hot.value.username).toBe('hot-future');
      }
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// TTL +Infinity → MAX key ∥ 3600 hot
// ---------------------------------------------------------------------------

describe('race turn TTL +Infinity→MAX∥hot sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`+Inf→86400 miss∥3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-def' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_MAX, 1],
          [CREDS_KEY, 1],
        ],
      });
      const bodies: number[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: { body?: string }) => {
          ctl.fetchStarts += 1;
          const ttl = init?.body ? (JSON.parse(init.body) as { ttl: number }).ttl : -1;
          bodies.push(ttl);
          return new Response(JSON.stringify(iceBody(`u${ttl}`, `p${ttl}`)), { status: 200 });
        })
      );

      const [inf, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), Number.POSITIVE_INFINITY),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(inf.username).toBe('u86400');
      expect(inf.ttl).toBe(86400);
      expect(hot.username).toBe('hot-def');
      expect(ctl.fetchStarts).toBe(1);
      expect(bodies).toEqual([86400]);
      expect(ctl.putTtl.get(CREDS_KEY_MAX)).toBe(69120);
    });
  }
});

// ---------------------------------------------------------------------------
// TTL -Infinity → MIN 300 key ∥ hot
// ---------------------------------------------------------------------------

describe('race turn TTL -Infinity→MIN∥hot sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`-Inf→300 miss∥3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-neg' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [CREDS_KEY, 1],
        ],
      });
      const bodies: number[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: { body?: string }) => {
          ctl.fetchStarts += 1;
          const ttl = init?.body ? (JSON.parse(init.body) as { ttl: number }).ttl : -1;
          bodies.push(ttl);
          return new Response(JSON.stringify(iceBody(`u${ttl}`, `p${ttl}`)), { status: 200 });
        })
      );

      const [neg, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), Number.NEGATIVE_INFINITY),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(neg.username).toBe('u300');
      expect(neg.ttl).toBe(300);
      expect(hot.username).toBe('hot-neg');
      expect(ctl.fetchStarts).toBe(1);
      expect(bodies).toEqual([300]);
      expect(ctl.putTtl.get(CREDS_KEY_TTL300)).toBe(240);
    });
  }
});

// ---------------------------------------------------------------------------
// API 500 text() throw → bare status message ∥ capped
// ---------------------------------------------------------------------------

describe('race turn API 500 text-throw∥capped sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`500 text() throws → bare msg∥alice capped flood-${i}`, async () => {
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
            statusText: 'Internal Server Error',
            headers: new Headers(),
            text: async () => {
              throw new Error('body-read-fail');
            },
            json: async () => {
              throw new Error('no-json');
            },
          } as unknown as Response;
        })
      );

      const [api, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(api.status).toBe('rejected');
      if (api.status === 'rejected') {
        expect(api.reason).toMatchObject({
          code: 'API_ERROR',
          statusCode: 500,
          message: 'TURN API returned 500',
        });
        expect(String(api.reason.message)).not.toContain('body-read-fail');
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
// 429 Retry-After:"60" exact message ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn 429 Retry-After 60∥capped sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`Retry-After:60 exact∥bob capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_BOB, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_BOB, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          return new Response('slow down', {
            status: 429,
            headers: { 'Retry-After': '60' },
          });
        })
      );

      const [rate, bob] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(rate.status).toBe('rejected');
      if (rate.status === 'rejected') {
        expect(rate.reason).toMatchObject({
          code: 'RATE_LIMITED',
          statusCode: 429,
          message: 'TURN API rate limited. Retry after 60 seconds.',
        });
      }
      expect(bob.status).toBe('rejected');
      if (bob.status === 'rejected') {
        expect(bob.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// iceServers string (non-array) INVALID ∥ hot
// ---------------------------------------------------------------------------

describe('race turn iceServers string INVALID∥hot sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`iceServers:"nope" INVALID∥3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-str' })),
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
          return new Response(JSON.stringify({ iceServers: 'nope' }), { status: 200 });
        })
      );

      const [bad, hot] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(bad.status).toBe('rejected');
      if (bad.status === 'rejected') {
        expect(bad.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(String(bad.reason.message)).toContain('missing iceServers array');
        expect(String(bad.reason.message)).toContain('"iceServers":"nope"');
      }
      expect(hot.status).toBe('fulfilled');
      if (hot.status === 'fulfilled') {
        expect(hot.value.username).toBe('hot-str');
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// credentialed urls:null → stun-only ∥ capped
// ---------------------------------------------------------------------------

describe('race turn credentialed urls null∥capped sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`urls:null → uris=[stun]∥alice capped flood-${i}`, async () => {
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
              iceServers: [
                { urls: ['stun:stun.cloudflare.com:3478'] },
                { urls: null, username: 'null-u', credential: 'null-p' },
              ],
            }),
            { status: 200 }
          );
        })
      );

      const [ok, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(ok.status).toBe('fulfilled');
      if (ok.status === 'fulfilled') {
        expect(ok.value.username).toBe('null-u');
        expect(ok.value.password).toBe('null-p');
        expect(ok.value.uris).toEqual(['stun:stun.cloudflare.com:3478']);
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
// duplicate ice URL entries kept flattened ∥ hot
// ---------------------------------------------------------------------------

describe('race turn duplicate ice URLs kept∥hot sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`dupe urls preserved∥MAX hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY_MAX]: JSON.stringify(
          cachedCreds({ username: 'max-hot', ttl: 86400, expiresAt: NOW + 700_000 })
        ),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_MAX, 1],
        ],
      });
      const dupeUrl = 'turn:dupe.example.com:3478';
      stubFetchOk(ctl, {
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:3478'] },
          { urls: [dupeUrl, dupeUrl], username: 'dupe-u', credential: 'dupe-p' },
        ],
      });

      const [duped, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 86400),
      ]);

      expect(duped.username).toBe('dupe-u');
      expect(duped.uris).toEqual([
        'stun:stun.cloudflare.com:3478',
        'stun:stun.cloudflare.com:3478',
        dupeUrl,
        dupeUrl,
      ]);
      expect(hot.username).toBe('max-hot');
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// username-only∥credential-only both fail find ∥ full-creds OK
// ---------------------------------------------------------------------------

describe('race turn partial ICE find-fail∥full OK sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`user-only∥cred-only INVALID∥keyB full OK flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [CREDS_KEY, 2],
          [CREDS_KEY_B, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          ctl.fetchStarts += 1;
          if (String(url).includes(KEY_ID_B)) {
            return new Response(JSON.stringify(iceBody('full-b', 'fb')), { status: 200 });
          }
          // Alternate: first call user-only, second cred-only — but both go to KEY_ID.
          // Use call count to vary body.
          if (ctl.fetchStarts === 1) {
            return new Response(
              JSON.stringify({
                iceServers: [{ urls: ['turn:u-only.example.com'], username: 'only-u' }],
              }),
              { status: 200 }
            );
          }
          return new Response(
            JSON.stringify({
              iceServers: [{ urls: ['turn:c-only.example.com'], credential: 'only-c' }],
            }),
            { status: 200 }
          );
        })
      );

      const [userOnly, credOnly, full] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv, { TURN_KEY_ID: KEY_ID_B }), 3600),
      ]);

      expect(userOnly.status).toBe('rejected');
      if (userOnly.status === 'rejected') {
        expect(userOnly.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(String(userOnly.reason.message)).toContain('no server with credentials');
      }
      expect(credOnly.status).toBe('rejected');
      if (credOnly.status === 'rejected') {
        expect(credOnly.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
      }
      expect(full.status).toBe('fulfilled');
      if (full.status === 'fulfilled') {
        expect(full.value.username).toBe('full-b');
      }
      expect(ctl.fetchStarts).toBe(3);
    });
  }
});

// ---------------------------------------------------------------------------
// getHold CREDS mid-put lost-update ∥ capped
// ---------------------------------------------------------------------------

describe('race turn getHold mid-put lost-update∥capped sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`getHold stale view∥put fills∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl, releaseGet } = createRacingKv({
        data,
        getHold: [CREDS_KEY],
      });
      stubFetchOk(ctl, iceBody('filled', 'fl'));

      let heldDone = false;
      const heldP = getMatrixTurnCredentials(turnEnv(kv), 3600).then((r) => {
        heldDone = true;
        return r;
      });
      const aliceP = getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.startsWith(`get-wait:${CREDS_KEY}:`))).toBe(true);
      });
      expect(heldDone).toBe(false);

      // Populate cache while held get is in-flight (lost-update / TOCTOU).
      ctl.data[CREDS_KEY] = JSON.stringify(cachedCreds({ username: 'raced-in' }));
      releaseGet(CREDS_KEY);

      const [held, alice] = await Promise.allSettled([heldP, aliceP]);

      expect(held.status).toBe('fulfilled');
      if (held.status === 'fulfilled') {
        // Held get sees raced-in cache → no fetch; or if released before seed, fetch.
        // With seed before release, hit path wins.
        expect(held.value.username).toBe('raced-in');
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// cross KEY_ID getThrow(*) miss→fetch ∥ KEY_B hot ∥ stun
// ---------------------------------------------------------------------------

describe('race turn cross KEY getThrow(*) dual-miss∥stun sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`getThrow=* KEY_A∥KEY_B both miss→fetch∥stun∥status flood-${i}`, async () => {
      // Seed on B is unreachable: getThrow(*) fails open to miss before read.
      const data: Record<string, string> = {
        [CREDS_KEY_B]: JSON.stringify(cachedCreds({ username: 'unreachable-b' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getThrows: ['*'],
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_B, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('star-get', 'sg'));
      const envA = turnEnv(kv);
      const envB = turnEnv(kv, { TURN_KEY_ID: KEY_ID_B });

      const [a, b, stun, status, configured, err] = await Promise.allSettled([
        getMatrixTurnCredentials(envA, 3600),
        getMatrixTurnCredentials(envB, 3600),
        Promise.resolve(getStunServers()),
        Promise.resolve(getTurnStatus(envA)),
        Promise.resolve(isTurnConfigured(envB)),
        Promise.resolve(new TurnError('x', 'INVALID_RESPONSE')),
      ]);

      expect(a.status).toBe('fulfilled');
      if (a.status === 'fulfilled') {
        expect(a.value.username).toBe('star-get');
      }
      expect(b.status).toBe('fulfilled');
      if (b.status === 'fulfilled') {
        expect(b.value.username).toBe('star-get');
      }
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
      expect(err.status).toBe('fulfilled');
      if (err.status === 'fulfilled') {
        expect(err.value).toMatchObject({ code: 'INVALID_RESPONSE', name: 'TurnError' });
      }
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// putTtl 3600→2880 pin ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn putTtl 2880 pin∥capped sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`cache put expirationTtl=2880∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('ttl-pin', 'tp'));

      const [ok, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(ok.status).toBe('fulfilled');
      if (ok.status === 'fulfilled') {
        expect(ok.value.username).toBe('ttl-pin');
        expect(ok.value.ttl).toBe(3600);
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.putTtl.get(CREDS_KEY)).toBe(2880); // 3600 * 0.8
      expect(ctl.fetchStarts).toBe(1);
      const cached = JSON.parse(ctl.data[CREDS_KEY]!) as { expiresAt: number };
      expect(cached.expiresAt).toBe(NOW + 3600 * 1000 * 0.8);
    });
  }
});

// ---------------------------------------------------------------------------
// retryAfterMs floor when oldest≈window edge (→1000) ∥ hot
// ---------------------------------------------------------------------------

describe('race turn retryAfterMs near-elapsed floor∥hot sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`oldest=now-59999 → retryAfterMs=1000∥hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-edge' })),
        [RL_ALICE]: JSON.stringify({
          // 5 stamps; oldest nearly out of 60s window → retryAfterMs ≈ 1 → floor 1000
          requests: [NOW - 59_999, NOW - 10, NOW - 9, NOW - 8, NOW - 7],
        }),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [RL_ALICE, 1],
          [CREDS_KEY, 1],
        ],
      });
      stubFetchOk(ctl);

      const [alice, hot] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({
          code: 'USER_RATE_LIMITED',
          statusCode: 429,
          retryAfterMs: 1000,
        });
        expect(String(alice.reason.message)).toContain('1000ms');
      }
      expect(hot.status).toBe('fulfilled');
      if (hot.status === 'fulfilled') {
        expect(hot.value.username).toBe('hot-edge');
      }
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// four-way RATE_LIMITED∥INVALID∥capped∥stun
// ---------------------------------------------------------------------------

describe('race turn four-way RATE∥INVALID∥capped∥stun sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`429∥bad-json∥alice capped∥stun flood-${i}`, async () => {
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
            return new Response('nope', {
              status: 429,
              headers: { 'Retry-After': '9' },
            });
          }
          return new Response('not-json{', { status: 200 });
        })
      );

      const [rate, bad, alice, stun] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        Promise.resolve(getStunServers()),
      ]);

      expect(rate.status).toBe('rejected');
      if (rate.status === 'rejected') {
        expect(rate.reason).toMatchObject({
          code: 'RATE_LIMITED',
          message: 'TURN API rate limited. Retry after 9 seconds.',
        });
      }
      expect(bad.status).toBe('rejected');
      if (bad.status === 'rejected') {
        expect(bad.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(String(bad.reason.message)).toContain('Invalid JSON');
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(stun.status).toBe('fulfilled');
      if (stun.status === 'fulfilled') {
        expect(stun.value.ttl).toBe(86400);
      }
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// cached empty-password hit still served ∥ cold miss sibling
// ---------------------------------------------------------------------------

describe('race turn empty-password cache hit∥miss sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`password:'' cache hit∥300 cold miss flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(
          cachedCreds({ username: 'empty-pw', password: '' })
        ),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('cold300', 'c3'));

      const [hit, miss] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hit.username).toBe('empty-pw');
      expect(hit.password).toBe('');
      expect(miss.username).toBe('cold300');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY_TTL300)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// urls:number non-array flatMap scalar ∥ capped
// ---------------------------------------------------------------------------

describe('race turn numeric urls flatMap scalar∥capped sixth-wave after #349', () => {
  for (let i = 0; i < 8; i++) {
    it(`urls:3478 scalar in uris∥carol capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_CAROL, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_CAROL, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          return new Response(
            JSON.stringify({
              iceServers: [
                { urls: ['stun:stun.cloudflare.com:3478'] },
                { urls: 3478, username: 'num-u', credential: 'num-p' },
              ],
            }),
            { status: 200 }
          );
        })
      );

      const [ok, carol] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL),
      ]);

      expect(ok.status).toBe('fulfilled');
      if (ok.status === 'fulfilled') {
        expect(ok.value.username).toBe('num-u');
        // flatMap: non-array return is kept as a single element
        expect(ok.value.uris).toEqual(['stun:stun.cloudflare.com:3478', 3478]);
      }
      expect(carol.status).toBe('rejected');
      if (carol.status === 'rejected') {
        expect(carol.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});
