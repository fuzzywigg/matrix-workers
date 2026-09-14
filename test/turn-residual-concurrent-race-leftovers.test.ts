/**
 * TOKENMAXX HEAVY leftovers after #299 turn concurrent-race / tip past
 * #303 — *residual* turn concurrent-race niches sequential helpers
 * already pin but #299 never mixed under Promise.all / KV barriers:
 *   cache getThrow→miss ∥ hot hit,
 *   rate-limit putThrow fail-open ∥ capped reject,
 *   API_ERROR / INVALID_RESPONSE / fetch reject ∥ hot hit,
 *   empty-string / partial secrets NOT_CONFIGURED ∥ configured,
 *   TTL clamp 299/86401/NaN/Infinity/-1 matrix under barriers,
 *   dual-expired same-key delete∥refetch,
 *   remaining-ttl floor (expiresAt=now+999) ∥ cold miss,
 *   userId omitted (no rl) ∥ userId present,
 *   429 missing Retry-After / non-OK text() throw ∥ hit,
 *   username-only / credential-only INVALID ∥ hit,
 *   window-advance mid get-hold still rejects (now pre-captured TOCTOU),
 *   retryAfterMs floor≥1000 near window end under PA reject,
 *   CREDS putBarrier lost-update / MAX∥MIN TTL stampede,
 *   four-way NOT_CONFIGURED∥API_ERROR∥hot∥status helpers.
 *
 * Gap table (why leftover after #299):
 *   cache getThrow→miss ∥ hot | #299 putThrow + rl getThrow only
 *   rl putThrow fail-open ∥ capped | helpers sequential only
 *   API_ERROR / INVALID / fetch reject ∥ hot | only 429∥hit raced
 *   empty-string / partial secrets | #299 undefined-only NOT_CONFIGURED
 *   TTL clamp / NaN / Infinity matrix | helpers sequential only
 *   dual-expired same-key / ttl-floor 999ms | delete-hold single path
 *   userId omitted ∥ present | never dual-barried
 *   429 no Retry-After / text() throw | helpers sequential only
 *   username/credential-only INVALID | helpers sequential only
 *   window-advance mid get-hold still reject | now captured before KV get
 *   retryAfter floor PA | sequential only
 *
 * Tests-only. example.com fixtures only. Reversible by deleting this
 * file. No invent-product / secrets / DNS. Distinct from #299 megaflood.
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
const KEY_ID_SHORT = 'ab';
const KEY_ID_LONG = 'turnkey99zyxwvutsrqponmlk';
const ALICE = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const CREDS_KEY = `turn_creds:${KEY_ID}:3600`;
const CREDS_KEY_TTL300 = `turn_creds:${KEY_ID}:300`;
const CREDS_KEY_TTL86400 = `turn_creds:${KEY_ID}:86400`;
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
// Cache getThrow → miss ∥ hot sibling hit (#299 never raced creds getThrow)
// ---------------------------------------------------------------------------

describe('residual race turn cache getThrow→miss∥hot after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`creds getThrow refetches∥3600 hot hit flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-get' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getThrows: [CREDS_KEY_TTL300],
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('miss-after-throw', 'pw'));

      const [hot, cold] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hot.username).toBe('hot-get');
      expect(cold.username).toBe('miss-after-throw');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY_TTL300)).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Rate-limit putThrow fail-open ∥ capped sibling reject
// ---------------------------------------------------------------------------

describe('residual race turn rl putThrow fail-open∥capped after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`alice putThrow still allows∥bob seed=5 rejects flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_BOB, 5);
      const { kv, ctl } = createRacingKv({
        data,
        putThrows: [RL_ALICE],
        getBarrier: [
          [RL_ALICE, 1],
          [RL_BOB, 1],
        ],
      });
      // Hot cache so bob reject path never fetches; alice still needs fetch
      data[CREDS_KEY] = JSON.stringify(cachedCreds({ username: 'shared-hot' }));
      stubFetchOk(ctl);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const settled = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);
      warn.mockRestore();

      expect(settled[0]?.status).toBe('fulfilled');
      expect(settled[1]?.status).toBe('rejected');
      if (settled[1]?.status === 'rejected') {
        expect(settled[1].reason).toMatchObject({ code: 'USER_RATE_LIMITED', statusCode: 429 });
      }
      // putThrow means alice never persisted rl stamp — fail-open still returned creds
      expect(ctl.putCount.get(RL_ALICE)).toBe(1);
      expect(ctl.data[RL_ALICE]).toBeUndefined();
      expect(ctl.putCount.get(RL_BOB) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// API_ERROR ∥ hot hit
// ---------------------------------------------------------------------------

describe('residual race turn API_ERROR∥hot hit after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`cold 500 body∥hot no-fetch flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot500' })),
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
          return new Response('upstream boom', { status: 500 });
        })
      );

      const [hit, miss] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hit.status).toBe('fulfilled');
      if (hit.status === 'fulfilled') expect(hit.value.username).toBe('hot500');
      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({
          code: 'API_ERROR',
          statusCode: 500,
          message: expect.stringContaining('upstream boom'),
        });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// INVALID_RESPONSE (missing iceServers) ∥ hot hit
// ---------------------------------------------------------------------------

describe('residual race turn INVALID_RESPONSE∥hot after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`cold missing iceServers∥hot hit flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-inv' })),
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
          return new Response(JSON.stringify({ not: 'ice' }), { status: 200 });
        })
      );

      const [hit, miss] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hit.status).toBe('fulfilled');
      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(String(miss.reason.message)).toContain('Got:');
        expect(String(miss.reason.message)).toContain('"not":"ice"');
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Fetch network Error / non-Error reject ∥ hot hit
// ---------------------------------------------------------------------------

describe('residual race turn fetch reject∥hot after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`Error reject∥hot + non-Error reject∥status flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-net' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      let calls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          calls += 1;
          if (calls === 1) throw new Error('dns-fail');
          throw 'plain-string-reject';
        })
      );

      const [hit, errReject] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);
      expect(hit.status).toBe('fulfilled');
      expect(errReject.status).toBe('rejected');
      if (errReject.status === 'rejected') {
        expect(errReject.reason).toMatchObject({
          code: 'API_ERROR',
          message: 'Failed to connect to TURN API: dns-fail',
        });
      }

      // Second wave: non-Error reject while helpers/status race
      const { kv: kv2, ctl: ctl2 } = createRacingKv({
        data: { [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot2' })) },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl2.fetchStarts += 1;
          throw 42;
        })
      );
      const [nonErr, stun, status] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv2), 300),
        Promise.resolve(getStunServers()),
        Promise.resolve(getTurnStatus(turnEnv(kv2))),
      ]);
      expect(nonErr.status).toBe('rejected');
      if (nonErr.status === 'rejected') {
        expect(nonErr.reason).toMatchObject({
          code: 'API_ERROR',
          message: 'Failed to connect to TURN API: Unknown error',
        });
      }
      expect(stun.status).toBe('fulfilled');
      expect(status.status).toBe('fulfilled');
      expect(ctl2.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Empty-string / partial secrets NOT_CONFIGURED ∥ configured sibling
// ---------------------------------------------------------------------------

describe('residual race turn empty/partial secrets∥configured after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`'' secrets + missing token∥configured fetch ok flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv();
      stubFetchOk(ctl);

      const [emptyBoth, missingToken, good] = await Promise.allSettled([
        getMatrixTurnCredentials(
          { CACHE: kv, TURN_KEY_ID: '', TURN_API_TOKEN: '' } as Env,
          3600,
          ALICE
        ),
        getMatrixTurnCredentials(
          { CACHE: kv, TURN_KEY_ID: KEY_ID, TURN_API_TOKEN: '' } as Env,
          3600,
          BOB
        ),
        getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL),
      ]);

      expect(emptyBoth.status).toBe('rejected');
      expect(missingToken.status).toBe('rejected');
      if (emptyBoth.status === 'rejected') {
        expect(emptyBoth.reason).toMatchObject({
          code: 'NOT_CONFIGURED',
          message: 'TURN server not configured. Set TURN_KEY_ID and TURN_API_TOKEN.',
        });
      }
      if (missingToken.status === 'rejected') {
        expect(missingToken.reason).toMatchObject({ code: 'NOT_CONFIGURED' });
      }
      expect(good.status).toBe('fulfilled');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
      expect(ctl.putCount.get(RL_BOB) ?? 0).toBe(0);
      expect(ctl.putCount.get(RL_CAROL)).toBe(1);
      expect(ctl.putTtl.get(RL_CAROL)).toBe(70);
    });
  }
});

// ---------------------------------------------------------------------------
// TTL clamp matrix under parallel barriers (299→300, 86401→86400, NaN/-1/Inf)
// ---------------------------------------------------------------------------

describe('residual race turn TTL clamp matrix under barriers after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`299∥86401∥-1 clamp keys isolate flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [
          [CREDS_KEY_TTL300, 2],
          [CREDS_KEY_TTL86400, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('clamp', 'clamp-pw'));

      const [lo, hi, neg] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 299),
        getMatrixTurnCredentials(turnEnv(kv), 86401),
        getMatrixTurnCredentials(turnEnv(kv), -1),
      ]);

      expect(lo.ttl).toBe(300);
      expect(hi.ttl).toBe(86400);
      expect(neg.ttl).toBe(300);
      expect(ctl.putCount.get(CREDS_KEY_TTL300)).toBe(2); // 299 + -1
      expect(ctl.putCount.get(CREDS_KEY_TTL86400)).toBe(1);
      expect(ctl.putTtl.get(CREDS_KEY_TTL300)).toBe(Math.floor(300 * 0.8));
      expect(ctl.putTtl.get(CREDS_KEY_TTL86400)).toBe(Math.floor(86400 * 0.8));
    });
  }
});

describe('residual race turn TTL NaN∥Infinity quirks after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`NaN key quirk∥Infinity→86400 under PA flood-${i}`, async () => {
      const CREDS_NAN = `turn_creds:${KEY_ID}:NaN`;
      const { kv, ctl } = createRacingKv();
      stubFetchOk(ctl, iceBody('quirk', 'q'));

      const [nanR, infR] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), Number.NaN),
        getMatrixTurnCredentials(turnEnv(kv), Number.POSITIVE_INFINITY),
      ]);

      // Infinity → Math.min(86400, Inf) = 86400; NaN → cache key …:NaN
      expect(infR.status).toBe('fulfilled');
      if (infR.status === 'fulfilled') expect(infR.value.ttl).toBe(86400);
      expect(nanR.status).toBe('fulfilled');
      expect(ctl.putCount.get(CREDS_NAN)).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY_TTL86400)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Dual-expired same-key: both see expired, both delete+refetch
// ---------------------------------------------------------------------------

describe('residual race turn dual-expired same-key after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`getBarrier=2 both expire delete+refetch flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'stale-dual', expiresAt: NOW })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [[CREDS_KEY, 2]],
        deleteBarrier: [[CREDS_KEY, 2]],
      });
      stubFetchOk(ctl, iceBody('fresh-dual', 'fpw'));

      const [a, b] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(a.username).toBe('fresh-dual');
      expect(b.username).toBe('fresh-dual');
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(2);
      expect(ctl.fetchStarts).toBe(2);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Remaining ttl floor: expiresAt = now+999 → ttl 0 ∥ cold miss
// ---------------------------------------------------------------------------

describe('residual race turn remaining-ttl floor 999ms∥cold after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`hot ttl floors to 0∥300 cold miss flood-${i}`, async () => {
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
      stubFetchOk(ctl, iceBody('cold999', 'c'));

      const [hot, cold] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hot.username).toBe('almost-gone');
      expect(hot.ttl).toBe(0); // Math.floor(999/1000)
      expect(cold.username).toBe('cold999');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.deleteCount.get(CREDS_KEY) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// userId omitted (no rl key) ∥ userId present
// ---------------------------------------------------------------------------

describe('residual race turn userId omitted∥present after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`no-userId skips rl∥alice stamps expirationTtl 70 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[CREDS_KEY, 2]],
      });
      stubFetchOk(ctl, iceBody('shared', 'pw'));

      const [anon, alice] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(anon.username).toBe('shared');
      expect(alice.username).toBe('shared');
      expect(ctl.putCount.get(RL_ALICE)).toBe(1);
      expect(ctl.putTtl.get(RL_ALICE)).toBe(70);
      expect(
        [...ctl.putCount.keys()].filter((k) => k.startsWith('turn_ratelimit:')).length
      ).toBe(1);
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// 429 missing Retry-After ∥ hot hit
// ---------------------------------------------------------------------------

describe('residual race turn 429 no Retry-After∥hot after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`cold 429 unknown seconds∥hot hit flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-ra' })),
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
          message: 'TURN API rate limited. Retry after unknown seconds.',
        });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Non-OK empty body + text() throw ∥ hot hit
// ---------------------------------------------------------------------------

describe('residual race turn non-OK text() throw∥hot after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`502 text() throws∥hot; empty body omits suffix flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-txt' })),
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
          return {
            ok: false,
            status: 502,
            headers: new Headers(),
            text: async () => {
              throw new Error('body-read-fail');
            },
          } as unknown as Response;
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
          statusCode: 502,
          message: 'TURN API returned 502',
        });
      }

      // empty body sibling wave
      const { kv: kv2, ctl: ctl2 } = createRacingKv({
        data: { [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-empty' })) },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl2.fetchStarts += 1;
          return new Response('', { status: 503 });
        })
      );
      const emptyMiss = await getMatrixTurnCredentials(turnEnv(kv2), 300).then(
        () => null,
        (e: TurnError) => e
      );
      expect(emptyMiss).toMatchObject({
        code: 'API_ERROR',
        statusCode: 503,
        message: 'TURN API returned 503',
      });
    });
  }
});

// ---------------------------------------------------------------------------
// username-only / credential-only INVALID ∥ hot hit
// ---------------------------------------------------------------------------

describe('residual race turn username/credential-only INVALID∥hot after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`username-only∥credential-only both INVALID under PA with hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-part' })),
      };
      const { kv, ctl } = createRacingKv({ data });
      let n = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          n += 1;
          if (n === 1) {
            return new Response(
              JSON.stringify({
                iceServers: [{ urls: ['turn:t.example.com'], username: 'only-user' }],
              }),
              { status: 200 }
            );
          }
          return new Response(
            JSON.stringify({
              iceServers: [{ urls: ['turn:t.example.com'], credential: 'only-cred' }],
            }),
            { status: 200 }
          );
        })
      );

      const [hot, userOnly, credOnly] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hot.status).toBe('fulfilled');
      expect(userOnly.status).toBe('rejected');
      expect(credOnly.status).toBe('rejected');
      if (userOnly.status === 'rejected') {
        expect(userOnly.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(String(userOnly.reason.message)).toContain('no server with credentials');
      }
      if (credOnly.status === 'rejected') {
        expect(credOnly.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
      }
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Window-advance: seed=5 held, advance past window → dual admit
// ---------------------------------------------------------------------------

describe('residual race turn window-advance mid get-hold TOCTOU after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`seed=5 get-hold; clock+61s; dual still reject (now pre-captured) flood-${i}`, async () => {
      // Implementation captures `now` BEFORE await cache.get — advancing the
      // clock while get is held cannot shrink the in-window set. #299 only
      // advanced +1ms on a partially-stale seed (no-op for filtering).
      const data: Record<string, string> = {
        [RL_ALICE]: JSON.stringify({
          requests: [NOW - 50_000, NOW - 40_000, NOW - 30_000, NOW - 20_000, NOW - 10_000],
        }),
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'blocked' })),
      };
      const { kv, ctl, releaseGet } = createRacingKv({
        data,
        getHold: [RL_ALICE],
      });
      stubFetchOk(ctl);

      const p1 = getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE);
      const p2 = getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE);

      await vi.waitFor(() => {
        expect(ctl.events.filter((e) => e.includes(`get-wait:${RL_ALICE}`)).length).toBe(2);
      });

      vi.setSystemTime(NOW + 61_000);
      expect(Date.now()).toBe(NOW + 61_000);
      releaseGet(RL_ALICE);

      const settled = await Promise.allSettled([p1, p2]);
      // Both still rate-limited: window filter used pre-hold `now` (= NOW)
      expect(settled.every((s) => s.status === 'rejected')).toBe(true);
      for (const s of settled) {
        if (s.status === 'rejected') {
          expect(s.reason).toMatchObject({ code: 'USER_RATE_LIMITED', statusCode: 429 });
        }
      }
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// retryAfterMs floor ≥1000 near window end under parallel reject
// ---------------------------------------------------------------------------

describe('residual race turn retryAfterMs floor under PA reject after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`seed=5 near window end → dual reject retryAfterMs≥1000 flood-${i}`, async () => {
      const data: Record<string, string> = {};
      // oldest ≈ NOW-59900 → retryAfter ≈ 100ms → floored to 1000
      seedRateLimit(data, RL_CAROL, 5, NOW - 59_900);
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
          expect(s.reason).toMatchObject({ code: 'USER_RATE_LIMITED', statusCode: 429 });
          expect(s.reason.retryAfterMs).toBeGreaterThanOrEqual(1000);
          expect(String(s.reason.message)).toMatch(/Rate limited\. Try again in \d+ms\./);
        }
      }
      expect(ctl.fetchStarts).toBe(0);
      expect(ctl.putCount.get(RL_CAROL) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// CREDS putBarrier lost-update + MAX∥MIN TTL stampede isolation
// ---------------------------------------------------------------------------

describe('residual race turn CREDS put lost-update + MAX∥MIN stampede after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`putBarrier=2 last-write; 86400∥300 stampede isolate flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[CREDS_KEY, 2]],
        putBarrier: [[CREDS_KEY, 2]],
      });
      let n = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          n += 1;
          return new Response(JSON.stringify(iceBody(`u${n}`, `p${n}`)), { status: 200 });
        })
      );

      const [a, b] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);
      expect(a.username).toMatch(/^u[12]$/);
      expect(b.username).toMatch(/^u[12]$/);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(2);
      // Last put wins
      expect(JSON.parse(ctl.data[CREDS_KEY]).username).toMatch(/^u[12]$/);

      const { kv: kv2, ctl: ctl2 } = createRacingKv({
        getBarrier: [
          [CREDS_KEY_TTL300, 3],
          [CREDS_KEY_TTL86400, 3],
        ],
      });
      stubFetchOk(ctl2, iceBody('iso', 'iso-pw'));
      const results = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv2), 300),
        getMatrixTurnCredentials(turnEnv(kv2), 300),
        getMatrixTurnCredentials(turnEnv(kv2), 300),
        getMatrixTurnCredentials(turnEnv(kv2), 86400),
        getMatrixTurnCredentials(turnEnv(kv2), 86400),
        getMatrixTurnCredentials(turnEnv(kv2), 86400),
      ]);
      expect(results.every((r) => r.username === 'iso')).toBe(true);
      expect(ctl2.putCount.get(CREDS_KEY_TTL300)).toBe(3);
      expect(ctl2.putCount.get(CREDS_KEY_TTL86400)).toBe(3);
      expect(ctl2.fetchStarts).toBe(6);
    });
  }
});

// ---------------------------------------------------------------------------
// deleteThrow on expiry ∥ rl putThrow fail-open sibling
// ---------------------------------------------------------------------------

describe('residual race turn expire deleteThrow∥rl putThrow after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`expired deleteThrow still refetches∥alice putThrow fail-open flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'exp', expiresAt: NOW - 1 })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        deleteThrows: [CREDS_KEY],
        putThrows: [RL_ALICE],
      });
      stubFetchOk(ctl, iceBody('post-del-throw', 'pw'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const [expired, alice] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);
      warn.mockRestore();

      expect(expired.username).toBe('post-del-throw');
      expect(alice.username).toBe('post-del-throw');
      expect(ctl.deleteCount.get(CREDS_KEY)).toBeGreaterThanOrEqual(1);
      expect(ctl.putCount.get(RL_ALICE)).toBe(1);
      expect(ctl.data[RL_ALICE]).toBeUndefined();
      expect(ctl.fetchStarts).toBeGreaterThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// iceServers missing urls flatten ∥ Content-Type/POST body pin under dual miss
// ---------------------------------------------------------------------------

describe('residual race turn missing urls flatten + fetch shape after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`flatMap missing urls→[]∥dual miss POST+json flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[CREDS_KEY, 2]],
      });
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
        ctl.fetchStarts += 1;
        return new Response(
          JSON.stringify({
            iceServers: [
              { username: 'u', credential: 'p' }, // no urls
              { urls: ['turn:ok.example.com:3478'], username: 'u', credential: 'p' },
            ],
          }),
          { status: 200 }
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const [a, b] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(a.uris).toEqual(['turn:ok.example.com:3478']);
      expect(b.uris).toEqual(['turn:ok.example.com:3478']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const call of fetchMock.mock.calls) {
        const reqInit = call[1] as RequestInit;
        expect(reqInit.method).toBe('POST');
        expect((reqInit.headers as Record<string, string>)['Content-Type']).toBe(
          'application/json'
        );
        expect(JSON.parse(String(reqInit.body))).toEqual({ ttl: 3600 });
        expect((reqInit.headers as Record<string, string>).Authorization).toBe(
          'Bearer turn-token'
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Short∥long keyId status concurrent with credential hot/miss
// ---------------------------------------------------------------------------

describe('residual race turn short∥long keyId status∥creds after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`status redact∥configured∥hot∥stun parallel flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'status-hot' })),
      };
      const { kv, ctl } = createRacingKv({ data });
      stubFetchOk(ctl);

      const shortEnv = turnEnv(kv, { TURN_KEY_ID: KEY_ID_SHORT });
      const longEnv = turnEnv(kv, { TURN_KEY_ID: KEY_ID_LONG });

      const [shortSt, longSt, cfg, stun, hot, uncfg] = await Promise.all([
        Promise.resolve(getTurnStatus(shortEnv)),
        Promise.resolve(getTurnStatus(longEnv)),
        Promise.resolve(isTurnConfigured(turnEnv(kv))),
        Promise.resolve(getStunServers()),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        Promise.resolve(isTurnConfigured({ CACHE: kv } as Env)),
      ]);

      expect(shortSt).toEqual({ configured: true, keyId: 'ab...' });
      expect(longSt.keyId).toBe(`${KEY_ID_LONG.slice(0, 8)}...`);
      expect(cfg).toBe(true);
      expect(uncfg).toBe(false);
      expect(stun.uris).toEqual(['stun:stun.cloudflare.com:3478']);
      expect(hot.username).toBe('status-hot');
      expect(ctl.fetchStarts).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Four-way: empty NOT_CONFIGURED ∥ API_ERROR ∥ hot ∥ status
// ---------------------------------------------------------------------------

describe('residual race turn four-way NOT_CONFIGURED∥API_ERROR∥hot∥status after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`quad settle under shared kv flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'quad-hot' })),
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
          return new Response('nope', { status: 502 });
        })
      );

      const settled = await Promise.allSettled([
        getMatrixTurnCredentials(
          { CACHE: kv, TURN_KEY_ID: '', TURN_API_TOKEN: 'x' } as Env,
          3600
        ),
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        Promise.resolve(getTurnStatus(turnEnv(kv))),
      ]);

      expect(settled[0]?.status).toBe('rejected');
      if (settled[0]?.status === 'rejected') {
        expect(settled[0].reason).toMatchObject({ code: 'NOT_CONFIGURED' });
      }
      expect(settled[1]?.status).toBe('rejected');
      if (settled[1]?.status === 'rejected') {
        expect(settled[1].reason).toMatchObject({ code: 'API_ERROR', statusCode: 502 });
      }
      expect(settled[2]?.status).toBe('fulfilled');
      if (settled[2]?.status === 'fulfilled') {
        expect(settled[2].value.username).toBe('quad-hot');
      }
      expect(settled[3]?.status).toBe('fulfilled');
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// TurnError construct under race with getStunServers (config helpers deepen)
// ---------------------------------------------------------------------------

describe('residual race turn TurnError fields∥stun after #299', () => {
  for (let i = 0; i < 8; i++) {
    it(`TurnError optional fields∥stun∥status parallel flood-${i}`, async () => {
      const { kv } = createRacingKv();
      const [errFull, errMin, stun, status] = await Promise.all([
        Promise.resolve(new TurnError('limited', 'USER_RATE_LIMITED', 429, 1500)),
        Promise.resolve(new TurnError('nc', 'NOT_CONFIGURED')),
        Promise.resolve(getStunServers()),
        Promise.resolve(getTurnStatus(turnEnv(kv))),
      ]);
      expect(errFull).toMatchObject({
        name: 'TurnError',
        code: 'USER_RATE_LIMITED',
        statusCode: 429,
        retryAfterMs: 1500,
      });
      expect(errMin.statusCode).toBeUndefined();
      expect(errMin.retryAfterMs).toBeUndefined();
      expect(stun.ttl).toBe(86400);
      expect(status.configured).toBe(true);
    });
  }
});
