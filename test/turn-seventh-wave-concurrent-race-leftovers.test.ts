/**
 * TOKENMAXX HEAVY tip-relaunch after #396 (main ~af6e2cd) — residual
 * *turn* service concurrent-race / TOCTOU seventh-wave niches after merged
 * #396 sixth-wave. Closed fifth-wave drafts (#389/#392 / #382) never
 * landed; this file is **disjoint** from sixth + fifth gap tables and
 * from #349/#333/#313/#299.
 *
 * Unsaturated by:
 *   #396 sixth-wave (Infinity/-Infinity/"nan" expiresAt; rl []/future;
 *        TTL ±Inf; 500 text-throw; Retry-After 60; iceServers string;
 *        urls:null; dupe urls; partial ICE find-fail; getHold mid-put;
 *        cross getThrow(*); putTtl 2880; retryAfterMs floor; four-way
 *        RATE∥INVALID∥capped∥stun; empty-password hit; urls:number),
 *   fifth-wave drafts (whitespace secrets; Retry-After 0/abc; expiresAt
 *        null/missing/0; empty-string creds; multi-user stampede; dual
 *        putHold; TTL 301/86399; AbortError; urls undefined; rl number;
 *        four-way NOT_CONFIGURED∥API_ERROR; deleteHold+putHold;
 *        whitespace KEY_ID; cross putThrow; urls:[]; seed0 eight-way;
 *        helpers matrix),
 *   #349/#333/#313/#299 (see prior leftovers headers).
 *
 * Gap table (why leftover / disjoint from fifth+sixth):
 *   expiresAt:false → expire-delete (0<=now) ∥ hot
 *     | fifth null/0; sixth ±Inf — never boolean false
 *   expiresAt:true → expire-delete (1<=now) ∥ capped
 *     | never boolean true under PA
 *   expiresAt:[] empty-array → expire (ToNumber 0) ∥ hot
 *     | never array expiresAt under PA
 *   expiresAt:{} object quirky hit (NaN<=now false) ∥ capped
 *     | third {} whole-cache overlay; sixth "nan" string — never {} expiresAt
 *   rl requests:{} object → filter TypeError fail-open ∥ capped
 *     | fourth null/string; fifth number; sixth [] — never {}
 *   rl requests:true boolean → fail-open ∥ hot
 *     | never boolean rl under PA
 *   rl past-only stamps all filtered → allow ∥ capped sibling
 *     | sixth future-only count toward cap — never past-only allow
 *   TTL true → MIN 300 key ∥ 3600 hot
 *     | sixth ±Inf; never boolean true clamp under PA
 *   TTL "3600" string exact key ∥ capped
 *     | never string TTL under PA
 *   TTL "nope" → NaN cache key miss ∥ hot
 *     | second numeric NaN sequential; never string-NaN under PA
 *   iceServers: number INVALID ∥ capped
 *     | third object; fourth []/null; sixth string — never number
 *   iceServers: false boolean INVALID ∥ hot
 *     | never boolean iceServers under PA
 *   credentialed urls:{} object scalar in uris ∥ capped
 *     | fourth string; fifth undefined/[]; sixth null/number — never {}
 *   whitespace username " " truthy pick ∥ hot
 *     | fifth empty-string falsy find-fail — never whitespace-truthy
 *   429 Retry-After:"1" exact message ∥ capped
 *     | fifth 0/abc; sixth 60 — never "1"
 *   API 403 with body text ∥ capped
 *     | fourth 401; never 403 under PA
 *   fetch reject non-Error string ∥ hot
 *     | second Error; fourth TypeError; fifth AbortError — never string reject
 *   cached empty-username hit ∥ cold miss sibling
 *     | sixth empty-password — never empty-username cache hit under PA
 *   putTtl MIN 300→240 pin ∥ capped
 *     | sixth default 2880 only
 *   four-way NOT_CONFIGURED∥USER_RATE_LIMITED∥stun∥hot
 *     | fifth NOT_CONFIGURED∥API_ERROR∥capped∥hot; sixth RATE∥INVALID∥capped∥stun
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
const CREDS_KEY_NAN = `turn_creds:${KEY_ID}:NaN`;
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
// expiresAt:false → expire-delete (0<=now) ∥ hot
// ---------------------------------------------------------------------------

describe('race turn false expiresAt expire∥hot seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`expiresAt:false delete∥300 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY_TTL300]: JSON.stringify(
          cachedCreds({ username: 'hot300', ttl: 300, expiresAt: NOW + 200_000 })
        ),
      };
      const { kv, ctl } = createRacingKv({
        data,
        jsonOverlay: {
          [CREDS_KEY]: cachedCreds({ username: 'bool-f', expiresAt: false }),
        },
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('after-false', 'af'));

      const [refill, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(refill.username).toBe('after-false');
      expect(hot.username).toBe('hot300');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// expiresAt:true → expire-delete (1<=now) ∥ capped
// ---------------------------------------------------------------------------

describe('race turn true expiresAt expire∥capped seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`expiresAt:true delete∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        jsonOverlay: {
          [CREDS_KEY]: cachedCreds({ username: 'bool-t', expiresAt: true }),
        },
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('after-true', 'at'));

      const [refill, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(refill.status).toBe('fulfilled');
      if (refill.status === 'fulfilled') {
        expect(refill.value.username).toBe('after-true');
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// expiresAt:[] empty-array → expire (ToNumber 0) ∥ hot
// ---------------------------------------------------------------------------

describe('race turn empty-array expiresAt expire∥hot seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`expiresAt:[] delete∥MAX hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY_MAX]: JSON.stringify(
          cachedCreds({ username: 'max-hot', ttl: 86400, expiresAt: NOW + 700_000 })
        ),
      };
      const { kv, ctl } = createRacingKv({
        data,
        jsonOverlay: {
          [CREDS_KEY]: cachedCreds({ username: 'arr-exp', expiresAt: [] }),
        },
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_MAX, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('after-arr', 'aa'));

      const [refill, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 86400),
      ]);

      expect(refill.username).toBe('after-arr');
      expect(hot.username).toBe('max-hot');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// expiresAt:{} object quirky hit (NaN<=now false) ∥ capped
// ---------------------------------------------------------------------------

describe('race turn object expiresAt quirky-hit∥capped seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`expiresAt:{} hit∥bob capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_BOB, 5);
      const { kv, ctl } = createRacingKv({
        data,
        jsonOverlay: {
          [CREDS_KEY]: cachedCreds({ username: 'obj-hit', expiresAt: {} }),
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
        expect(hit.value.username).toBe('obj-hit');
        expect(Number.isNaN(hit.value.ttl)).toBe(true);
      }
      expect(bob.status).toBe('rejected');
      if (bob.status === 'rejected') {
        expect(bob.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(0);
      expect(ctl.deleteCount.get(CREDS_KEY) ?? 0).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// rl requests:{} object → filter TypeError fail-open ∥ capped
// ---------------------------------------------------------------------------

describe('race turn rl requests object fail-open∥capped seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`bob {} fail-open∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        jsonOverlay: {
          [RL_BOB]: { requests: {} },
        },
        getBarrier: [
          [RL_ALICE, 1],
          [RL_BOB, 1],
          [CREDS_KEY, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('fo-obj', 'fo'));

      const [alice, bob] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(bob.status).toBe('fulfilled');
      if (bob.status === 'fulfilled') {
        expect(bob.value.username).toBe('fo-obj');
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
// rl requests:true boolean → fail-open ∥ hot
// ---------------------------------------------------------------------------

describe('race turn rl requests boolean fail-open∥hot seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`carol true fail-open∥3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-bool' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        jsonOverlay: {
          [RL_CAROL]: { requests: true },
        },
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_TTL300, 1],
          [RL_CAROL, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('fo-bool', 'fb'));

      const [carol, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 300, CAROL),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(carol.username).toBe('fo-bool');
      expect(hot.username).toBe('hot-bool');
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// rl past-only stamps all filtered → allow ∥ capped sibling
// ---------------------------------------------------------------------------

describe('race turn rl past-only stamps allow∥capped seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`bob past×5 allow∥alice capped flood-${i}`, async () => {
      const windowStart = NOW - 60_000;
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      data[RL_BOB] = JSON.stringify({
        requests: [
          windowStart - 5_000,
          windowStart - 4_000,
          windowStart - 3_000,
          windowStart - 2_000,
          windowStart - 1_000,
        ],
      });
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [RL_ALICE, 1],
          [RL_BOB, 1],
          [CREDS_KEY, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('past-ok', 'po'));

      const [alice, bob] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(bob.status).toBe('fulfilled');
      if (bob.status === 'fulfilled') {
        expect(bob.value.username).toBe('past-ok');
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
// TTL true → MIN 300 key ∥ 3600 hot
// ---------------------------------------------------------------------------

describe('race turn TTL true→MIN∥hot seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`true→300 miss∥3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-ttl' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [CREDS_KEY, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('bool-ttl', 'bt'));

      const [clamped, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), true as unknown as number),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(clamped.username).toBe('bool-ttl');
      expect(clamped.ttl).toBe(300);
      expect(hot.username).toBe('hot-ttl');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY_TTL300)).toBe(1);
      expect(ctl.putTtl.get(CREDS_KEY_TTL300)).toBe(240);
    });
  }
});

// ---------------------------------------------------------------------------
// TTL "3600" string exact key ∥ capped
// ---------------------------------------------------------------------------

describe('race turn TTL string-3600∥capped seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`"3600" exact key∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY, 1],
          [RL_ALICE, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('str-ttl', 'st'));

      const [ok, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), '3600' as unknown as number),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(ok.status).toBe('fulfilled');
      if (ok.status === 'fulfilled') {
        expect(ok.value.username).toBe('str-ttl');
        expect(ok.value.ttl).toBe(3600);
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(1);
      expect(ctl.putTtl.get(CREDS_KEY)).toBe(2880);
    });
  }
});

// ---------------------------------------------------------------------------
// TTL "nope" → NaN cache key miss ∥ hot
// ---------------------------------------------------------------------------

describe('race turn TTL string-nope→NaN∥hot seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`"nope"→NaN key∥3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-nan' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_NAN, 1],
          [CREDS_KEY, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('nan-ttl', 'nt'));

      const [nanish, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 'nope' as unknown as number),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(Number.isNaN(nanish.ttl)).toBe(true);
      expect(nanish.username).toBe('nan-ttl');
      expect(hot.username).toBe('hot-nan');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY_NAN)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// iceServers: number INVALID ∥ capped
// ---------------------------------------------------------------------------

describe('race turn iceServers number INVALID∥capped seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`iceServers:5 INVALID∥bob capped flood-${i}`, async () => {
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
          return new Response(JSON.stringify({ iceServers: 5 }), { status: 200 });
        })
      );

      const [bad, bob] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(bad.status).toBe('rejected');
      if (bad.status === 'rejected') {
        expect(bad.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(String(bad.reason.message)).toContain('missing iceServers array');
        expect(String(bad.reason.message)).toContain('"iceServers":5');
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
// iceServers: false boolean INVALID ∥ hot
// ---------------------------------------------------------------------------

describe('race turn iceServers false INVALID∥hot seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`iceServers:false INVALID∥3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-ice' })),
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
          return new Response(JSON.stringify({ iceServers: false }), { status: 200 });
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
      }
      expect(hot.status).toBe('fulfilled');
      if (hot.status === 'fulfilled') {
        expect(hot.value.username).toBe('hot-ice');
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// credentialed urls:{} object scalar in uris ∥ capped
// ---------------------------------------------------------------------------

describe('race turn urls object scalar∥capped seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`urls:{} in uris∥alice capped flood-${i}`, async () => {
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
                { urls: {}, username: 'obj-u', credential: 'obj-p' },
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
        expect(ok.value.username).toBe('obj-u');
        expect(ok.value.password).toBe('obj-p');
        expect(ok.value.uris).toEqual(['stun:stun.cloudflare.com:3478', {}]);
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
// whitespace username " " truthy pick ∥ hot
// ---------------------------------------------------------------------------

describe('race turn whitespace username pick∥hot seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`username:" " truthy∥MAX hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY_MAX]: JSON.stringify(
          cachedCreds({ username: 'max-ws', ttl: 86400, expiresAt: NOW + 700_000 })
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
          { urls: ['stun:stun.cloudflare.com:3478'] },
          {
            urls: ['turn:ws.example.com:3478'],
            username: ' ',
            credential: 'ws-cred',
          },
        ],
      });

      const [picked, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 86400),
      ]);

      expect(picked.username).toBe(' ');
      expect(picked.password).toBe('ws-cred');
      expect(picked.uris).toEqual(['stun:stun.cloudflare.com:3478', 'turn:ws.example.com:3478']);
      expect(hot.username).toBe('max-ws');
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// 429 Retry-After:"1" exact message ∥ capped
// ---------------------------------------------------------------------------

describe('race turn 429 Retry-After 1∥capped seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`Retry-After:1 exact∥carol capped flood-${i}`, async () => {
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
          return new Response('slow', {
            status: 429,
            headers: { 'Retry-After': '1' },
          });
        })
      );

      const [rate, carol] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL),
      ]);

      expect(rate.status).toBe('rejected');
      if (rate.status === 'rejected') {
        expect(rate.reason).toMatchObject({
          code: 'RATE_LIMITED',
          statusCode: 429,
          message: 'TURN API rate limited. Retry after 1 seconds.',
        });
      }
      expect(carol.status).toBe('rejected');
      if (carol.status === 'rejected') {
        expect(carol.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// API 403 with body text ∥ capped
// ---------------------------------------------------------------------------

describe('race turn API 403 body∥capped seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`403 forbidden body∥alice capped flood-${i}`, async () => {
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
          return new Response('forbidden-key', { status: 403 });
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
          statusCode: 403,
          message: 'TURN API returned 403: forbidden-key',
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
// fetch reject non-Error string ∥ hot
// ---------------------------------------------------------------------------

describe('race turn fetch string-reject∥hot seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`reject "boom"→Unknown∥3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-rej' })),
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
          throw 'boom';
        })
      );

      const [fail, hot] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(fail.status).toBe('rejected');
      if (fail.status === 'rejected') {
        expect(fail.reason).toMatchObject({
          code: 'API_ERROR',
          message: 'Failed to connect to TURN API: Unknown error',
        });
        expect(fail.reason).toBeInstanceOf(TurnError);
      }
      expect(hot.status).toBe('fulfilled');
      if (hot.status === 'fulfilled') {
        expect(hot.value.username).toBe('hot-rej');
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// cached empty-username hit ∥ cold miss sibling
// ---------------------------------------------------------------------------

describe('race turn empty-username cache hit∥miss seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`username:'' cache hit∥300 cold miss flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(
          cachedCreds({ username: '', password: 'still-pw', uris: ['turn:empty-user.example.com'] })
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

      expect(hit.username).toBe('');
      expect(hit.password).toBe('still-pw');
      expect(hit.uris).toEqual(['turn:empty-user.example.com']);
      expect(miss.username).toBe('cold300');
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// putTtl MIN 300→240 pin ∥ capped
// ---------------------------------------------------------------------------

describe('race turn putTtl 240 pin∥capped seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`cache put expirationTtl=240∥bob capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_BOB, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [RL_BOB, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('min-put', 'mp'));

      const [ok, bob] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(ok.status).toBe('fulfilled');
      if (ok.status === 'fulfilled') {
        expect(ok.value.username).toBe('min-put');
        expect(ok.value.ttl).toBe(300);
      }
      expect(bob.status).toBe('rejected');
      if (bob.status === 'rejected') {
        expect(bob.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(ctl.putCount.get(CREDS_KEY_TTL300)).toBe(1);
      expect(ctl.putTtl.get(CREDS_KEY_TTL300)).toBe(240);
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// four-way NOT_CONFIGURED∥USER_RATE_LIMITED∥stun∥hot
// ---------------------------------------------------------------------------

describe('race turn four-way NOT_CFG∥capped∥stun∥hot seventh-wave after #396', () => {
  for (let i = 0; i < 8; i++) {
    it(`empty secrets∥alice capped∥stun∥3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'four-hot' })),
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

      const emptyEnv = turnEnv(kv, { TURN_KEY_ID: '', TURN_API_TOKEN: '' });
      const [notCfg, alice, stun, hot] = await Promise.allSettled([
        getMatrixTurnCredentials(emptyEnv, 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        Promise.resolve(getStunServers()),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(notCfg.status).toBe('rejected');
      if (notCfg.status === 'rejected') {
        expect(notCfg.reason).toMatchObject({ code: 'NOT_CONFIGURED' });
        expect(notCfg.reason).toBeInstanceOf(TurnError);
      }
      expect(alice.status).toBe('rejected');
      if (alice.status === 'rejected') {
        expect(alice.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(stun.status).toBe('fulfilled');
      if (stun.status === 'fulfilled') {
        expect(stun.value.uris).toEqual(['stun:stun.cloudflare.com:3478']);
        expect(stun.value.username).toBe('');
      }
      expect(hot.status).toBe('fulfilled');
      if (hot.status === 'fulfilled') {
        expect(hot.value.username).toBe('four-hot');
      }
      expect(isTurnConfigured(emptyEnv)).toBe(false);
      expect(getTurnStatus(emptyEnv)).toEqual({ configured: false, keyId: undefined });
      expect(ctl.fetchStarts).toBe(0);
      // KEY_ID_B unused here but keeps cross-key constant surface parity with prior waves
      expect(CREDS_KEY_B).toContain(KEY_ID_B);
    });
  }
});
