/**
 * TOKENMAXX HEAVY tip-relaunch after #342 (main ~9065fa5) — residual
 * *turn* service concurrent-race / TOCTOU fourth-wave niches after #333
 * third-wave / tip past #313/#299. Closed #323/#343 were tip-stale; this
 * file relays the same unsaturated niches onto fresh tip:
 *
 * Unsaturated by:
 *   #333 third-wave (RATE_LIMITED∥USER_RATE_LIMITED; expiresAt<now;
 *        null/{} cache overlay∥hot; putThrow miss∥capped; iceServers
 *        not-array/empty-urls; deleteThrow∥hot; stale∥capped; creds
 *        putBarrier stampede; TTL 300∥86400∥3600 triad; API_ERROR∥capped;
 *        four-way; getThrow(*); RATE_LIMITED∥INVALID∥hot; ttl-shrink∥capped;
 *        helpers∥RATE_LIMITED; omitted∥rl putThrow∥capped; cross KEY_ID
 *        deleteThrow∥hot; retryAfterMs exact pin),
 *   #313 second-wave (API_ERROR/fetch-throw/INVALID_RESPONSE∥hot;
 *        429 missing Retry-After∥hot; rl putThrow fail-open∥siblings;
 *        cache getThrow∥hot; TTL NaN/-1/Inf; expiresAt===now dual-delete;
 *        empty/partial secrets∥configured; retryAfterMs floor; mid get-hold
 *        still capped; omitted∥explicit 3600; username/cred-only ICE;
 *        three-way API fail∥capped∥hot; MAX∥MIN; rl getThrow∥capped;
 *        expired get-hold∥hot; cross KEY_ID API fail∥hot;
 *        omitted userId∥capped),
 *   #299 first-wave (miss stampede; rl RMW; put-hold; delete-hold;
 *        lost-update; cross-user; TTL/KEY isolation; fail-open; putThrow;
 *        ttl clock; post-cap; in-flight duplicate; stale window; rl put-hold;
 *        deleteThrow∥ttl; helpers; hot∥cold; NOT_CONFIGURED∥configured;
 *        429∥hot; malformed rl; three-way put-hold∥rl∥hot).
 *
 * Gap table (why leftover after third-wave):
 *   iceServers [] empty ∥ hot
 *     | third only not-array object / empty-urls flatten
 *   iceServers null/missing ∥ USER_RATE_LIMITED
 *     | third only∥valid sibling
 *   urls as string (non-array) kept as single uri ∥ valid
 *     | helpers sequential flatten only
 *   multi-credentialed pick-first ∥ hot
 *     | never under Promise.all
 *   API 401∥USER_RATE_LIMITED
 *     | third only 503∥capped
 *   key-only / token-only NOT_CONFIGURED ∥ USER_RATE_LIMITED
 *     | second only∥configured
 *   TTL 0/299/86401 clamp keys ∥ 3600 hot
 *     | third exact in-range triad only
 *   rl requests:null / requests:string fail-open ∥ capped
 *     | #299 malformed overlay; never string-throw fail-open under PA
 *   putThrow(*) wildcard ∥ capped
 *     | third getThrow(*) only
 *   deleteHold expired ∥ USER_RATE_LIMITED ∥ hot three-way
 *     | pairwise only previously
 *   fetch TypeError ∥ USER_RATE_LIMITED
 *     | second fetch-throw∥hot only
 *   429 Retry-After:"" → unknown ∥ USER_RATE_LIMITED
 *     | second missing header∥hot; third with value∥capped
 *   NaN expiresAt quirky hit ∥ USER_RATE_LIMITED
 *     | third {} overlay∥hot only
 *   remaining ttl floor (expiresAt=now+999→0) ∥ cold miss
 *     | #299 shrink alone; never floor-0∥miss under PA
 *   alice capped ∥ bob rl getThrow fail-open ∥ carol hot
 *     | second getThrow∥capped pairwise; third * only
 *   short KEY_ID status ∥ empty NOT_CONFIGURED ∥ INVALID_RESPONSE
 *     | helpers∥RATE_LIMITED only in third
 *   dual KEY_ID cold miss stampede isolation
 *     | never dual-key miss under barriers
 *   rl windowStart exact excluded (strict >) ∥ capped sibling
 *     | never boundary under PA
 *   deleteThrow(*) expired refill ∥ capped
 *     | third keyed deleteThrow∥hot only
 *   INVALID_RESPONSE bad JSON ∥ USER_RATE_LIMITED ∥ stun
 *     | second INVALID∥hot; third RATE∥INVALID∥hot
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
const KEY_ID_SHORT = 'shortkey';
const ALICE = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const CREDS_KEY = `turn_creds:${KEY_ID}:3600`;
const CREDS_KEY_TTL300 = `turn_creds:${KEY_ID}:300`;
const CREDS_KEY_MAX = `turn_creds:${KEY_ID}:86400`;
const CREDS_KEY_B = `turn_creds:${KEY_ID_B}:3600`;
const CREDS_KEY_SHORT = `turn_creds:${KEY_ID_SHORT}:3600`;
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
// iceServers [] empty ∥ hot — third only not-array / empty-urls
// ---------------------------------------------------------------------------

describe('race turn iceServers empty-array∥hot fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`[] INVALID∥3600 hot sibling flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot3600' })),
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
          return new Response(JSON.stringify({ iceServers: [] }), { status: 200 });
        })
      );

      const [empty, hot] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(empty.status).toBe('rejected');
      if (empty.status === 'rejected') {
        expect(empty.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(String(empty.reason.message)).toContain('missing iceServers array');
        expect(empty.reason).toBeInstanceOf(TurnError);
      }
      expect(hot.status).toBe('fulfilled');
      if (hot.status === 'fulfilled') {
        expect(hot.value.username).toBe('hot3600');
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// iceServers null / missing ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn iceServers null∥USER_RATE_LIMITED fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`null iceServers∥alice capped flood-${i}`, async () => {
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
          return new Response(JSON.stringify({ iceServers: null }), { status: 200 });
        })
      );

      const [bad, capped] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(bad.status).toBe('rejected');
      if (bad.status === 'rejected') {
        expect(bad.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(String(bad.reason.message)).toContain('"iceServers":null');
      }
      expect(capped.status).toBe('rejected');
      if (capped.status === 'rejected') {
        expect(capped.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// urls as string (non-array) kept as single uri ∥ valid sibling
// ---------------------------------------------------------------------------

describe('race turn string-urls flatten∥valid sibling fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`urls string kept∥keyB array urls flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_B, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          ctl.fetchStarts += 1;
          if (String(url).includes(KEY_ID_B)) {
            return new Response(JSON.stringify(iceBody('array-b', 'ab')), { status: 200 });
          }
          return new Response(
            JSON.stringify({
              iceServers: [
                {
                  urls: 'turn:string.example.com:3478',
                  username: 'str-u',
                  credential: 'str-p',
                },
              ],
            }),
            { status: 200 }
          );
        })
      );

      const [strUrls, good] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv, { TURN_KEY_ID: KEY_ID_B }), 3600),
      ]);

      expect(strUrls.username).toBe('str-u');
      expect(strUrls.uris).toEqual(['turn:string.example.com:3478']);
      expect(good.username).toBe('array-b');
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// multi-credentialed pick-first ∥ hot
// ---------------------------------------------------------------------------

describe('race turn multi-credentialed pick-first∥hot fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`first cred wins∥MAX hot flood-${i}`, async () => {
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
      stubFetchOk(ctl, {
        iceServers: [
          { urls: ['stun:stun.example.com:3478'] },
          { urls: ['turn:first.example.com:3478'], username: 'first', credential: 'c1' },
          { urls: ['turn:second.example.com:3478'], username: 'second', credential: 'c2' },
        ],
      });

      const [picked, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 86400),
      ]);

      expect(picked.username).toBe('first');
      expect(picked.password).toBe('c1');
      expect(picked.uris).toEqual([
        'stun:stun.example.com:3478',
        'turn:first.example.com:3478',
        'turn:second.example.com:3478',
      ]);
      expect(hot.username).toBe('max-hot');
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// API 401 ∥ USER_RATE_LIMITED — third only 503∥capped
// ---------------------------------------------------------------------------

describe('race turn API 401∥USER_RATE_LIMITED fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`401 body∥alice capped flood-${i}`, async () => {
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
          return new Response('bad token', { status: 401 });
        })
      );

      const [api, user] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(api.status).toBe('rejected');
      if (api.status === 'rejected') {
        expect(api.reason).toMatchObject({
          code: 'API_ERROR',
          statusCode: 401,
          message: 'TURN API returned 401: bad token',
        });
      }
      expect(user.status).toBe('rejected');
      if (user.status === 'rejected') {
        expect(user.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// key-only / token-only NOT_CONFIGURED ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn partial-secrets∥USER_RATE_LIMITED fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`key-only∥token-only∥alice capped three-way flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [[RL_ALICE, 1]],
      });
      stubFetchOk(ctl);

      const [keyOnly, tokenOnly, capped] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv, { TURN_API_TOKEN: undefined }), 3600),
        getMatrixTurnCredentials(turnEnv(kv, { TURN_KEY_ID: undefined }), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(keyOnly.status).toBe('rejected');
      if (keyOnly.status === 'rejected') {
        expect(keyOnly.reason).toMatchObject({
          code: 'NOT_CONFIGURED',
          message: 'TURN server not configured. Set TURN_KEY_ID and TURN_API_TOKEN.',
        });
      }
      expect(tokenOnly.status).toBe('rejected');
      if (tokenOnly.status === 'rejected') {
        expect(tokenOnly.reason).toMatchObject({ code: 'NOT_CONFIGURED' });
      }
      expect(capped.status).toBe('rejected');
      if (capped.status === 'rejected') {
        expect(capped.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// TTL 0/299/86401 clamp keys ∥ 3600 hot
// ---------------------------------------------------------------------------

describe('race turn TTL clamp 0/299/86401∥hot fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`0→300∥299→300∥86401→MAX∥3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-default' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_TTL300, 2],
          [CREDS_KEY_MAX, 1],
          [CREDS_KEY, 1],
        ],
        putBarrier: [
          [CREDS_KEY_TTL300, 2],
          [CREDS_KEY_MAX, 1],
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

      const [z, low, hi, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 0),
        getMatrixTurnCredentials(turnEnv(kv), 299),
        getMatrixTurnCredentials(turnEnv(kv), 86401),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(z.username).toBe('u300');
      expect(z.ttl).toBe(300);
      expect(low.username).toBe('u300');
      expect(hi.username).toBe('u86400');
      expect(hi.ttl).toBe(86400);
      expect(hot.username).toBe('hot-default');
      expect(ctl.fetchStarts).toBe(3);
      expect(bodies.sort((a, b) => a - b)).toEqual([300, 300, 86400]);
      expect(ctl.putTtl.get(CREDS_KEY_TTL300)).toBe(240); // 300 * 0.8
      expect(ctl.putTtl.get(CREDS_KEY_MAX)).toBe(69120); // 86400 * 0.8
    });
  }
});

// ---------------------------------------------------------------------------
// rl requests:null / requests:string fail-open ∥ capped
// ---------------------------------------------------------------------------

describe('race turn rl requests null/string∥capped fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`bob requests:null allow∥carol string fail-open∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {
        [RL_BOB]: JSON.stringify({ requests: null }),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        jsonOverlay: {
          [RL_CAROL]: { requests: 'not-an-array' },
        },
        getBarrier: [
          [RL_ALICE, 1],
          [RL_BOB, 1],
          [RL_CAROL, 1],
          [CREDS_KEY, 2],
        ],
      });
      stubFetchOk(ctl, iceBody('opened', 'op'));

      const [alice, bob, carol] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
        getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL),
      ]);

      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(bob.status).toBe('fulfilled');
      if (bob.status === 'fulfilled') {
        expect(bob.value.username).toBe('opened');
      }
      expect(carol.status).toBe('fulfilled');
      if (carol.status === 'fulfilled') {
        expect(carol.value.username).toBe('opened');
      }
      // bob puts rl; carol fail-open (filter throw) → no rl put
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
      expect(ctl.putCount.get(RL_CAROL) ?? 0).toBe(0);
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// putThrow(*) wildcard ∥ capped — third getThrow(*) only
// ---------------------------------------------------------------------------

describe('race turn putThrow(*) fail-open∥capped fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`putThrows=* → bob still returns∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { kv, ctl } = createRacingKv({
        data,
        putThrows: ['*'],
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
          [RL_BOB, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('star-put', 'sp'));

      const [bob, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(bob.status).toBe('fulfilled');
      if (bob.status === 'fulfilled') {
        expect(bob.value.username).toBe('star-put');
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      // bob: rl putThrow fail-open (allowed) + creds putThrow (warn) → still returns
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
      expect(ctl.data[RL_BOB]).toBeUndefined();
      expect(ctl.data[CREDS_KEY]).toBeUndefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  }
});

// ---------------------------------------------------------------------------
// deleteHold expired ∥ USER_RATE_LIMITED ∥ hot three-way
// ---------------------------------------------------------------------------

describe('race turn deleteHold expired∥capped∥hot fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`expired delete-hold∥alice capped∥carol 300 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(
          cachedCreds({ username: 'stale', expiresAt: NOW - 5 })
        ),
        [CREDS_KEY_TTL300]: JSON.stringify(
          cachedCreds({ username: 'hot300', ttl: 300, expiresAt: NOW + 200_000 })
        ),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl, releaseDelete } = createRacingKv({
        data,
        deleteHold: [CREDS_KEY],
      });
      stubFetchOk(ctl, iceBody('after-del', 'ad'));

      let missDone = false;
      const missP = getMatrixTurnCredentials(turnEnv(kv), 3600).then((r) => {
        missDone = true;
        return r;
      });

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`delete-wait:${CREDS_KEY}`))).toBe(true);
      });
      expect(missDone).toBe(false);

      const [alice, carol] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 300, CAROL),
      ]);

      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(carol.status).toBe('fulfilled');
      if (carol.status === 'fulfilled') {
        expect(carol.value.username).toBe('hot300');
      }
      expect(missDone).toBe(false);

      releaseDelete(CREDS_KEY);
      const miss = await missP;
      expect(miss.username).toBe('after-del');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// fetch TypeError ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn fetch TypeError∥USER_RATE_LIMITED fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`TypeError connect∥alice capped flood-${i}`, async () => {
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
          throw new TypeError('Failed to fetch');
        })
      );

      const [api, user] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(api.status).toBe('rejected');
      if (api.status === 'rejected') {
        expect(api.reason).toMatchObject({
          code: 'API_ERROR',
          message: 'Failed to connect to TURN API: Failed to fetch',
        });
      }
      expect(user.status).toBe('rejected');
      if (user.status === 'rejected') {
        expect(user.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// 429 Retry-After:"" → unknown ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn 429 empty Retry-After∥USER_RATE_LIMITED fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`Retry-After empty→unknown∥alice capped flood-${i}`, async () => {
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
          return new Response('slow', {
            status: 429,
            headers: { 'Retry-After': '' },
          });
        })
      );

      const [api, user] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(api.status).toBe('rejected');
      if (api.status === 'rejected') {
        // empty string is falsy → "unknown"
        expect(api.reason).toMatchObject({
          code: 'RATE_LIMITED',
          message: 'TURN API rate limited. Retry after unknown seconds.',
        });
      }
      expect(user.status).toBe('rejected');
      if (user.status === 'rejected') {
        expect(user.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// NaN expiresAt quirky hit ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn NaN expiresAt quirky-hit∥capped fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`NaN expiresAt hit∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        jsonOverlay: {
          [CREDS_KEY]: {
            username: 'nan-hit',
            password: 'np',
            uris: ['turn:nan.example.com'],
            ttl: 3600,
            expiresAt: Number.NaN,
          },
        },
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
        ],
      });
      stubFetchOk(ctl);

      const [quirky, capped] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(quirky.status).toBe('fulfilled');
      if (quirky.status === 'fulfilled') {
        expect(quirky.value.username).toBe('nan-hit');
        expect(Number.isNaN(quirky.value.ttl)).toBe(true);
      }
      expect(capped.status).toBe('rejected');
      if (capped.status === 'rejected') {
        expect(capped.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// remaining ttl floor (expiresAt=now+999 → 0) ∥ cold miss
// ---------------------------------------------------------------------------

describe('race turn remaining-ttl floor0∥cold miss fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`expiresAt=now+999 → ttl=0∥300 cold miss flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(
          cachedCreds({ username: 'almost-gone', expiresAt: NOW + 999 })
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

      const [floor0, cold] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(floor0.username).toBe('almost-gone');
      expect(floor0.ttl).toBe(0);
      expect(cold.username).toBe('cold300');
      expect(cold.ttl).toBe(300);
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.deleteCount.get(CREDS_KEY) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// alice capped ∥ bob rl getThrow fail-open ∥ carol hot
// ---------------------------------------------------------------------------

describe('race turn capped∥rl getThrow∥hot three-way fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`alice capped∥bob getThrow fail-open∥carol hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'carol-hot' })),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getThrows: [RL_BOB],
        getBarrier: [
          [RL_ALICE, 1],
          [RL_BOB, 1],
          [RL_CAROL, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('bob-miss', 'bm'));

      const [alice, bob, carol] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
        getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL),
      ]);

      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(bob.status).toBe('fulfilled');
      if (bob.status === 'fulfilled') {
        // fail-open on rl → skips put; still hits cache
        expect(bob.value.username).toBe('carol-hot');
      }
      expect(carol.status).toBe('fulfilled');
      if (carol.status === 'fulfilled') {
        expect(carol.value.username).toBe('carol-hot');
      }
      expect(ctl.fetchStarts).toBe(0);
      expect(ctl.putCount.get(RL_BOB) ?? 0).toBe(0);
      expect(ctl.putCount.get(RL_CAROL)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// short KEY_ID status ∥ empty NOT_CONFIGURED ∥ INVALID_RESPONSE
// ---------------------------------------------------------------------------

describe('race turn short-key status∥NOT_CONFIGURED∥INVALID fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`short status∥empty secrets∥bad JSON three-way flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[CREDS_KEY_SHORT, 1]],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          return new Response('not-json{', { status: 200 });
        })
      );

      const shortEnv = turnEnv(kv, { TURN_KEY_ID: KEY_ID_SHORT });
      const emptyEnv = turnEnv(kv, { TURN_KEY_ID: '', TURN_API_TOKEN: '' });

      const [status, configured, empty, invalid] = await Promise.allSettled([
        Promise.resolve(getTurnStatus(shortEnv)),
        Promise.resolve(isTurnConfigured(shortEnv)),
        getMatrixTurnCredentials(emptyEnv, 3600),
        getMatrixTurnCredentials(shortEnv, 3600),
      ]);

      expect(status.status).toBe('fulfilled');
      if (status.status === 'fulfilled') {
        expect(status.value).toEqual({ configured: true, keyId: 'shortkey...' });
      }
      expect(configured.status).toBe('fulfilled');
      if (configured.status === 'fulfilled') {
        expect(configured.value).toBe(true);
      }
      expect(empty.status).toBe('rejected');
      if (empty.status === 'rejected') {
        expect(empty.reason).toMatchObject({ code: 'NOT_CONFIGURED' });
      }
      expect(invalid.status).toBe('rejected');
      if (invalid.status === 'rejected') {
        expect(invalid.reason).toMatchObject({
          code: 'INVALID_RESPONSE',
          message: 'Invalid JSON response from TURN API',
        });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// dual KEY_ID cold miss stampede isolation
// ---------------------------------------------------------------------------

describe('race turn dual KEY_ID cold miss stampede fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`keyA∥keyB dual miss barriers isolate flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [CREDS_KEY, 2],
          [CREDS_KEY_B, 2],
        ],
        putBarrier: [
          [CREDS_KEY, 2],
          [CREDS_KEY_B, 2],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          ctl.fetchStarts += 1;
          if (String(url).includes(KEY_ID_B)) {
            return new Response(JSON.stringify(iceBody('b-user', 'bp')), { status: 200 });
          }
          return new Response(JSON.stringify(iceBody('a-user', 'ap')), { status: 200 });
        })
      );

      const [a1, a2, b1, b2] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv, { TURN_KEY_ID: KEY_ID_B }), 3600),
        getMatrixTurnCredentials(turnEnv(kv, { TURN_KEY_ID: KEY_ID_B }), 3600),
      ]);

      expect(a1.username).toBe('a-user');
      expect(a2.username).toBe('a-user');
      expect(b1.username).toBe('b-user');
      expect(b2.username).toBe('b-user');
      expect(ctl.fetchStarts).toBe(4);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(2);
      expect(ctl.putCount.get(CREDS_KEY_B)).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// rl windowStart exact excluded (strict >) ∥ capped sibling
// ---------------------------------------------------------------------------

describe('race turn rl windowStart exact excluded∥capped fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`stamp===windowStart dropped→allow∥alice capped flood-${i}`, async () => {
      const windowStart = NOW - 60_000;
      const data: Record<string, string> = {
        // 4 stamps strictly inside + 1 exactly at windowStart (excluded by t > windowStart)
        [RL_BOB]: JSON.stringify({
          requests: [windowStart, windowStart + 1, windowStart + 2, windowStart + 3, windowStart + 4],
        }),
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
      stubFetchOk(ctl, iceBody('boundary', 'bd'));

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
        expect(bob.value.username).toBe('boundary');
      }
      // bob had 4 in-window + new = 5; allowed
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
      const bobRl = JSON.parse(ctl.data[RL_BOB]!) as { requests: number[] };
      expect(bobRl.requests).toHaveLength(5);
      expect(bobRl.requests.includes(windowStart)).toBe(false);
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// deleteThrow(*) expired refill ∥ capped
// ---------------------------------------------------------------------------

describe('race turn deleteThrow(*) expired∥capped fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`deleteThrows=* expired refetch∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(
          cachedCreds({ username: 'expired', expiresAt: NOW - 50 })
        ),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        deleteThrows: ['*'],
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('refetch-star', 'rs'));

      const [ok, capped] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(ok.status).toBe('fulfilled');
      if (ok.status === 'fulfilled') {
        expect(ok.value.username).toBe('refetch-star');
      }
      expect(capped.status).toBe('rejected');
      if (capped.status === 'rejected') {
        expect(capped.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// INVALID_RESPONSE bad JSON ∥ USER_RATE_LIMITED ∥ stun helper
// ---------------------------------------------------------------------------

describe('race turn INVALID_RESPONSE∥capped∥stun fourth-wave after #333', () => {
  for (let i = 0; i < 8; i++) {
    it(`bad JSON∥alice capped∥stun parallel flood-${i}`, async () => {
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
          return new Response('{broken', { status: 200 });
        })
      );

      const [invalid, capped, stun] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        Promise.resolve(getStunServers()),
      ]);

      expect(invalid.status).toBe('rejected');
      if (invalid.status === 'rejected') {
        expect(invalid.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
      }
      expect(capped.status).toBe('rejected');
      if (capped.status === 'rejected') {
        expect(capped.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(stun.status).toBe('fulfilled');
      if (stun.status === 'fulfilled') {
        expect(stun.value).toEqual({
          username: '',
          password: '',
          uris: ['stun:stun.cloudflare.com:3478'],
          ttl: 86400,
        });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});
