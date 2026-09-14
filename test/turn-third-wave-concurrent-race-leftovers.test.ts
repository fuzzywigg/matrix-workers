/**
 * TOKENMAXX HEAVY leftovers after #313 second-wave / tip past #299 —
 * residual *turn* service concurrent-race / TOCTOU third-wave niches
 * unsaturated by:
 *   #313 second-wave (API_ERROR/fetch-throw/INVALID_RESPONSE∥hot;
 *        429 missing Retry-After∥hot; rl putThrow fail-open∥siblings;
 *        cache getThrow∥hot; TTL NaN/-1/Inf; expiresAt===now dual-delete;
 *        empty/partial secrets; retryAfterMs floor; mid get-hold still
 *        capped; omitted∥explicit 3600; username/cred-only ICE; three-way
 *        API fail∥capped∥hot; MAX∥MIN; rl getThrow∥capped; expired
 *        get-hold∥hot; cross KEY_ID API fail∥hot; omitted userId∥capped),
 *   #299 first-wave (miss stampede; rl RMW TOCTOU; put-hold∥sibling;
 *        delete-hold; rl put lost-update; cross-user; TTL/KEY isolation;
 *        fail-open∥healthy; putThrow∥sibling; ttl clock; post-cap 6th∥7th;
 *        in-flight duplicate miss; stale window; rl put-hold; deleteThrow
 *        ∥ttl sibling; helpers; hot∥cold; NOT_CONFIGURED∥configured;
 *        429∥hot; malformed rl overlay; three-way put-hold∥rl∥hot).
 *
 * Gap table (why leftover after second-wave):
 *   API RATE_LIMITED (429+Retry-After) ∥ USER_RATE_LIMITED
 *     | #299/#313 only raced 429∥hot hit
 *   expiresAt < now (strict) dual-delete stampede
 *     | #313 only exact === now
 *   malformed/null cache overlay ∥ hot sibling
 *     | #299 only malformed *rate-limit* overlay
 *   cache putThrow miss refill ∥ USER_RATE_LIMITED
 *     | #299 putThrow∥success sibling; #313 rl putThrow∥capped
 *   iceServers not-array / empty-urls flatten ∥ valid under barriers
 *     | helpers sequential only
 *   deleteThrow expiry ∥ same-key hot sibling
 *     | #299 deleteThrow∥cross-TTL sibling only
 *   stale window all-expired stamps allow ∥ capped sibling
 *     | #299 stale-window allow alone (hold+micro-advance)
 *   creds putBarrier last-writer stampede
 *     | #299 only rl put lost-update
 *   TTL exact 300∥86400∥3600 clamp triad under barriers
 *     | #313 NaN/-1/Inf + MAX hot∥MIN miss (not exact in-range triad)
 *   API_ERROR body ∥ USER_RATE_LIMITED (no hot)
 *     | #313 API_ERROR∥hot only
 *   four-way: miss put-hold ∥ alice capped ∥ bob healthy ∥ carol hot
 *     | #299 three-way only
 *   wildcard getThrow(*) fail-open-as-miss ∥ capped
 *     | #313 keyed getThrow∥hot only
 *   RATE_LIMITED∥INVALID_RESPONSE∥hot three-way
 *     | pairwise only previously
 *   remaining-ttl shrink mid get-hold ∥ USER_RATE_LIMITED
 *     | #299 ttl clock alone; #313 capped mid-hold alone
 *   stun/status helpers ∥ RATE_LIMITED fetch fail
 *     | helpers∥configured only
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
// API RATE_LIMITED (429 + Retry-After) ∥ USER_RATE_LIMITED — unsaturated
// ---------------------------------------------------------------------------

describe('race turn API RATE_LIMITED∥USER_RATE_LIMITED third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`cold miss 429+Retry-After∥alice capped flood-${i}`, async () => {
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
          return new Response('slow down', {
            status: 429,
            headers: { 'Retry-After': '12' },
          });
        })
      );

      const [api, user] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(api.status).toBe('rejected');
      if (api.status === 'rejected') {
        expect(api.reason).toMatchObject({
          code: 'RATE_LIMITED',
          statusCode: 429,
          message: 'TURN API rate limited. Retry after 12 seconds.',
        });
        expect(api.reason).toBeInstanceOf(TurnError);
      }
      expect(user.status).toBe('rejected');
      if (user.status === 'rejected') {
        expect(user.reason).toMatchObject({ code: 'USER_RATE_LIMITED', statusCode: 429 });
      }
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Strict expiresAt < now dual-delete stampede (#313 only ===)
// ---------------------------------------------------------------------------

describe('race turn expiresAt<now dual-delete stampede third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`two callers both see expiresAt=now-1 → dual delete+fetch flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(
          cachedCreds({ username: 'stale', expiresAt: NOW - 1 })
        ),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [[CREDS_KEY, 2]],
        deleteBarrier: [[CREDS_KEY, 2]],
      });
      stubFetchOk(ctl, iceBody('fresh-a', 'fa'));

      const [a, b] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(a.username).toBe('fresh-a');
      expect(b.username).toBe('fresh-a');
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(2);
      expect(ctl.fetchStarts).toBe(2);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Malformed / null cache overlay ∥ hot sibling
// ---------------------------------------------------------------------------

describe('race turn malformed cache overlay∥hot sibling third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`null∥{}∥missing-expiresAt overlays∥300 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY_TTL300]: JSON.stringify(
          cachedCreds({ username: 'hot300', ttl: 300, expiresAt: NOW + 200_000 })
        ),
      };
      const { kv, ctl } = createRacingKv({
        data,
        jsonOverlay: {
          [CREDS_KEY]: null,
        },
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('from-null', 'fn'));

      const [fromNull, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(fromNull.username).toBe('from-null');
      expect(hot.username).toBe('hot300');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(1);
    });
  }
});

describe('race turn empty-object cache overlay∥hot sibling third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`{} overlay (no expiresAt) treated as hit quirky∥300 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY_TTL300]: JSON.stringify(
          cachedCreds({ username: 'hot300', ttl: 300, expiresAt: NOW + 200_000 })
        ),
      };
      const { kv, ctl } = createRacingKv({
        data,
        // expiresAt undefined → undefined <= now is false → quirky hit with NaN ttl
        jsonOverlay: {
          [CREDS_KEY]: {},
        },
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      stubFetchOk(ctl);

      const [quirky, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(quirky.username).toBeUndefined();
      expect(Number.isNaN(quirky.ttl)).toBe(true);
      expect(hot.username).toBe('hot300');
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Cache putThrow miss refill ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn cache putThrow miss∥USER_RATE_LIMITED third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`3600 putThrow still returns∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { kv, ctl } = createRacingKv({
        data,
        putThrows: [CREDS_KEY],
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('uncached', 'uc'));

      const [ok, capped] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(ok.status).toBe('fulfilled');
      if (ok.status === 'fulfilled') {
        expect(ok.value.username).toBe('uncached');
      }
      expect(capped.status).toBe('rejected');
      if (capped.status === 'rejected') {
        expect(capped.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(1);
      expect(ctl.data[CREDS_KEY]).toBeUndefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  }
});

// ---------------------------------------------------------------------------
// iceServers not-array / empty-urls flatten ∥ valid under barriers
// ---------------------------------------------------------------------------

describe('race turn iceServers not-array∥valid sibling third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`iceServers object INVALID∥keyB valid flood-${i}`, async () => {
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
          if (String(url).includes(KEY_ID_B)) {
            return new Response(JSON.stringify(iceBody('valid-b', 'vb')), { status: 200 });
          }
          return new Response(JSON.stringify({ iceServers: { not: 'array' } }), { status: 200 });
        })
      );

      const [bad, good] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv, { TURN_KEY_ID: KEY_ID_B }), 3600),
      ]);

      expect(bad.status).toBe('rejected');
      if (bad.status === 'rejected') {
        expect(bad.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(String(bad.reason.message)).toContain('missing iceServers array');
      }
      expect(good.status).toBe('fulfilled');
      if (good.status === 'fulfilled') {
        expect(good.value.username).toBe('valid-b');
      }
      expect(ctl.fetchStarts).toBe(2);
      expect(n).toBe(2);
    });
  }
});

describe('race turn empty-urls flatten∥valid sibling third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`missing urls→[] flatten∥keyB with urls flood-${i}`, async () => {
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
            return new Response(JSON.stringify(iceBody('with-urls', 'wu')), { status: 200 });
          }
          // credentialed server but no urls on either entry → flatten to []
          return new Response(
            JSON.stringify({
              iceServers: [
                { username: 'u', credential: 'p' },
                { username: 'u2', credential: 'p2' },
              ],
            }),
            { status: 200 }
          );
        })
      );

      const [emptyUrls, withUrls] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv, { TURN_KEY_ID: KEY_ID_B }), 3600),
      ]);

      expect(emptyUrls.username).toBe('u');
      expect(emptyUrls.uris).toEqual([]);
      expect(withUrls.username).toBe('with-urls');
      expect(withUrls.uris.length).toBeGreaterThan(0);
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// deleteThrow expiry ∥ same-key hot sibling (after one deletes)
// ---------------------------------------------------------------------------

describe('race turn deleteThrow expiry∥hot sibling third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`expired deleteThrow still refetches∥sibling TTL300 hot flood-${i}`, async () => {
      // #299 covered deleteThrow∥ttl300 when 3600 is expired; this wave pins
      // the same matrix with explicit deleteThrow count + refetch username.
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(
          cachedCreds({ username: 'expired', expiresAt: NOW - 5 })
        ),
        [CREDS_KEY_TTL300]: JSON.stringify(
          cachedCreds({ username: 'hot300', ttl: 300, expiresAt: NOW + 200_000 })
        ),
      };
      const { kv, ctl } = createRacingKv({
        data,
        deleteThrows: [CREDS_KEY],
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('after-del-throw', 'adt'));

      const [refetch, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(refetch.username).toBe('after-del-throw');
      expect(hot.username).toBe('hot300');
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Stale window filter ∥ capped sibling
// ---------------------------------------------------------------------------

describe('race turn stale window filter∥capped sibling third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`alice all-stale stamps allow∥bob seed=5 reject under barriers flood-${i}`, async () => {
      const data: Record<string, string> = {};
      // all alice stamps older than windowStart=NOW-60s → filter to [] → allow
      data[RL_ALICE] = JSON.stringify({
        requests: [
          NOW - 120_000,
          NOW - 110_000,
          NOW - 100_000,
          NOW - 90_000,
          NOW - 80_000,
        ],
      });
      seedRateLimit(data, RL_BOB, 5, NOW);
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

      expect(alice.status).toBe('fulfilled');
      if (alice.status === 'fulfilled') {
        expect(alice.value.username).toBe('u');
      }
      expect(bob.status).toBe('rejected');
      if (bob.status === 'rejected') {
        expect(bob.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.putCount.get(RL_ALICE)).toBe(1);
      expect(ctl.putCount.get(RL_BOB) ?? 0).toBe(0);
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Creds putBarrier last-writer stampede
// ---------------------------------------------------------------------------

describe('race turn creds putBarrier last-writer stampede third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`putBarrier=2 serializes two cache puts; both fetch flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        putBarrier: [[CREDS_KEY, 2]],
      });
      let fetchN = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          fetchN += 1;
          const tag = fetchN === 1 ? 'first' : 'second';
          return new Response(JSON.stringify(iceBody(tag, tag)), { status: 200 });
        })
      );

      const [a, b] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect([a.username, b.username].sort()).toEqual(['first', 'second']);
      expect(ctl.fetchStarts).toBe(2);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(2);
      // last writer wins in ctl.data
      const stored = JSON.parse(ctl.data[CREDS_KEY]!) as { username: string };
      expect(['first', 'second']).toContain(stored.username);
      expect(ctl.putTtl.get(CREDS_KEY)).toBe(Math.floor(3600 * 0.8));
    });
  }
});

// ---------------------------------------------------------------------------
// TTL exact 300 ∥ 86400 ∥ 3600 clamp triad
// ---------------------------------------------------------------------------

describe('race turn TTL exact 300∥86400∥3600 triad third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`exact MIN∥MAX∥DEFAULT under barriers flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [CREDS_KEY_MAX, 1],
          [CREDS_KEY, 1],
        ],
      });
      const fetchMock = stubFetchOk(ctl);

      const [min, max, def] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 86400),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(min.ttl).toBe(300);
      expect(max.ttl).toBe(86400);
      expect(def.ttl).toBe(3600);
      expect(ctl.fetchStarts).toBe(3);
      expect(ctl.putCount.get(CREDS_KEY_TTL300)).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY_MAX)).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(1);
      expect(ctl.putTtl.get(CREDS_KEY_TTL300)).toBe(Math.floor(300 * 0.8));
      expect(ctl.putTtl.get(CREDS_KEY_MAX)).toBe(Math.floor(86400 * 0.8));
      expect(ctl.putTtl.get(CREDS_KEY)).toBe(Math.floor(3600 * 0.8));
      const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string));
      expect(bodies.map((b: { ttl: number }) => b.ttl).sort((a, b) => a - b)).toEqual([
        300, 3600, 86400,
      ]);
    });
  }
});

// ---------------------------------------------------------------------------
// API_ERROR body ∥ USER_RATE_LIMITED (no hot path)
// ---------------------------------------------------------------------------

describe('race turn API_ERROR body∥USER_RATE_LIMITED third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`503 with body∥alice capped parallel flood-${i}`, async () => {
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
          return new Response('upstream down', { status: 503 });
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
          statusCode: 503,
          message: 'TURN API returned 503: upstream down',
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
// Four-way: miss put-hold ∥ alice capped ∥ bob healthy ∥ carol hot
// ---------------------------------------------------------------------------

describe('race turn four-way put-hold∥capped∥healthy∥hot third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`300 put-hold∥alice capped∥bob miss-path∥carol 3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'carol-hot' })),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl, releasePut } = createRacingKv({
        data,
        putHold: [CREDS_KEY_TTL300],
      });
      stubFetchOk(ctl, iceBody('miss-300', 'm3'));

      let missDone = false;
      const missP = getMatrixTurnCredentials(turnEnv(kv), 300, BOB).then((r) => {
        missDone = true;
        return r;
      });

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${CREDS_KEY_TTL300}`))).toBe(true);
      });
      expect(missDone).toBe(false);

      const [alice, carol] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL),
      ]);

      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(carol.status).toBe('fulfilled');
      if (carol.status === 'fulfilled') {
        expect(carol.value.username).toBe('carol-hot');
      }
      expect(missDone).toBe(false);

      releasePut(CREDS_KEY_TTL300);
      const miss = await missP;
      expect(miss.username).toBe('miss-300');
      expect(miss.ttl).toBe(300);
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
      expect(ctl.putCount.get(RL_CAROL)).toBe(1);
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Wildcard getThrow(*) → miss fail-open ∥ capped
// ---------------------------------------------------------------------------

describe('race turn wildcard getThrow(*) miss∥fail-open third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`getThrows=* → rl fail-open + cache miss refetch for alice∥bob flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'would-hit' })),
      };
      seedRateLimit(data, RL_BOB, 5); // ignored: * throws before parse
      const { kv, ctl } = createRacingKv({
        data,
        getThrows: ['*'],
        getBarrier: [
          [RL_ALICE, 1],
          [RL_BOB, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('after-star', 'as'));

      const [alice, bob] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(alice.username).toBe('after-star');
      expect(bob.username).toBe('after-star');
      // both fail-open on rl (no put) and miss on cache → 2 fetches
      expect(ctl.fetchStarts).toBe(2);
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
      expect(ctl.putCount.get(RL_BOB) ?? 0).toBe(0);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// RATE_LIMITED ∥ INVALID_RESPONSE ∥ hot three-way
// ---------------------------------------------------------------------------

describe('race turn RATE_LIMITED∥INVALID_RESPONSE∥hot three-way third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`300→429∥3600→bad JSON∥MAX hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY_MAX]: JSON.stringify(
          cachedCreds({ username: 'max-hot', ttl: 86400, expiresAt: NOW + 700_000 })
        ),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [CREDS_KEY, 1],
          [CREDS_KEY_MAX, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: { body?: string }) => {
          ctl.fetchStarts += 1;
          const ttl = init?.body ? (JSON.parse(init.body) as { ttl: number }).ttl : 0;
          if (ttl === 300) {
            return new Response('', {
              status: 429,
              headers: { 'Retry-After': '3' },
            });
          }
          return new Response('not-json{', { status: 200 });
        })
      );

      const [limited, invalid, hot] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 86400),
      ]);

      expect(limited.status).toBe('rejected');
      if (limited.status === 'rejected') {
        expect(limited.reason).toMatchObject({ code: 'RATE_LIMITED' });
      }
      expect(invalid.status).toBe('rejected');
      if (invalid.status === 'rejected') {
        expect(invalid.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
      }
      expect(hot.status).toBe('fulfilled');
      if (hot.status === 'fulfilled') {
        expect(hot.value.username).toBe('max-hot');
      }
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Remaining-ttl shrink mid get-hold ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn ttl-shrink get-hold∥USER_RATE_LIMITED third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`hold hot get; advance clock; alice capped parallel flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(
          cachedCreds({ username: 'shrinking', expiresAt: NOW + 100_000 })
        ),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl, releaseGet } = createRacingKv({
        data,
        getHold: [CREDS_KEY],
      });
      stubFetchOk(ctl);

      let hitDone = false;
      const hitP = getMatrixTurnCredentials(turnEnv(kv), 3600).then((r) => {
        hitDone = true;
        return r;
      });

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`get-wait:${CREDS_KEY}`))).toBe(true);
      });

      vi.setSystemTime(NOW + 40_000);
      const alice = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);
      expect(alice[0].status).toBe('rejected');
      if (alice[0].status === 'rejected') {
        expect(alice[0].reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(hitDone).toBe(false);

      releaseGet(CREDS_KEY);
      const hit = await hitP;
      expect(hit.username).toBe('shrinking');
      // remaining ttl floored from (100_000 - 40_000) / 1000 = 60
      // BUT: Date.now() is read AFTER await getBarrier in getCachedCredentials,
      // so after release, now is NOW+40_000 → remaining 60
      expect(hit.ttl).toBe(60);
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Stun/status helpers ∥ RATE_LIMITED fetch fail
// ---------------------------------------------------------------------------

describe('race turn helpers∥RATE_LIMITED fetch third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`stun∥status∥configured∥429 miss parallel flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          return new Response('', {
            status: 429,
            headers: { 'Retry-After': '9' },
          });
        })
      );

      const env = turnEnv(kv);
      const [stun, status, configured, limited] = await Promise.allSettled([
        Promise.resolve(getStunServers()),
        Promise.resolve(getTurnStatus(env)),
        Promise.resolve(isTurnConfigured(env)),
        getMatrixTurnCredentials(env, 3600),
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
      expect(limited.status).toBe('rejected');
      if (limited.status === 'rejected') {
        expect(limited.reason).toMatchObject({ code: 'RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// dave omitted-userId miss ∥ carol putThrow rl fail-open ∥ alice capped
// ---------------------------------------------------------------------------

describe('race turn omitted-userId∥rl putThrow∥capped third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`anon miss∥carol putThrow fail-open∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        putThrows: [RL_CAROL],
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
          [RL_CAROL, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('shared-miss', 'sm'));

      const [anon, carol, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(anon.status).toBe('fulfilled');
      expect(carol.status).toBe('fulfilled');
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      // anon + carol both miss (no cache) → 2 fetches; carol rl put attempted
      expect(ctl.fetchStarts).toBe(2);
      expect(ctl.putCount.get(RL_CAROL)).toBe(1);
      expect(ctl.data[RL_CAROL]).toBeUndefined();
      expect(ctl.putCount.get(CREDS_KEY)).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross KEY_ID: A deleteThrow expired ∥ B hot
// ---------------------------------------------------------------------------

describe('race turn cross KEY_ID deleteThrow expired∥hot third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`keyA expired deleteThrow refetch∥keyB hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(
          cachedCreds({ username: 'expired-a', expiresAt: NOW - 10 })
        ),
        [CREDS_KEY_B]: JSON.stringify(cachedCreds({ username: 'hot-b' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        deleteThrows: [CREDS_KEY],
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_B, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('refetch-a', 'ra'));

      const [a, b] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv, { TURN_KEY_ID: KEY_ID_B }), 3600),
      ]);

      expect(a.username).toBe('refetch-a');
      expect(b.username).toBe('hot-b');
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY_B) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// retryAfterMs exact pin under parallel post-cap (seed=5, oldest=NOW)
// ---------------------------------------------------------------------------

describe('race turn retryAfterMs exact pin parallel third-wave after #313', () => {
  for (let i = 0; i < 8; i++) {
    it(`seed=5 oldest=NOW → retryAfterMs=60000 for 6th∥7th flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5, NOW);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [[RL_ALICE, 2]],
      });
      stubFetchOk(ctl);

      const [a, b] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(a.status).toBe('rejected');
      expect(b.status).toBe('rejected');
      if (a.status === 'rejected' && b.status === 'rejected') {
        expect(a.reason).toMatchObject({
          code: 'USER_RATE_LIMITED',
          retryAfterMs: 60_000,
          message: 'Rate limited. Try again in 60000ms.',
        });
        expect(b.reason).toMatchObject({
          code: 'USER_RATE_LIMITED',
          retryAfterMs: 60_000,
        });
      }
      expect(ctl.fetchStarts).toBe(0);
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
    });
  }
});
