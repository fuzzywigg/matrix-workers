/**
 * TOKENMAXX HEAVY tip-relaunch after #357 (main ~76189b73) — residual
 * *turn* service concurrent-race / TOCTOU sixth-wave niches after #349
 * fourth-wave on tip. Relays closed #365/#362 unsaturated niches (owner
 * kept open #367 fifth-wave twin) onto fresh tip past #333/#313/#299.
 * Disjoint from open draft #367 fifth-wave niches.
 *
 * Unsaturated by:
 *   #349 fourth-wave (iceServers []/null; string-urls; multi-cred
 *        pick-first; 401∥capped; partial-secrets∥capped; TTL 0/299/86401;
 *        rl null/string; putThrow(*); deleteHold∥capped∥hot; TypeError∥capped;
 *        429 empty Retry-After∥capped; NaN expiresAt; ttl floor0; three-way
 *        capped∥getThrow∥hot; short-key status; dual KEY_ID miss;
 *        windowStart exact; deleteThrow(*); INVALID∥capped∥stun),
 *   #333 third-wave (RATE_LIMITED∥USER_RATE_LIMITED; expiresAt<now;
 *        null/{} cache overlay∥hot; putThrow miss∥capped; iceServers
 *        not-array/empty-urls; deleteThrow∥hot; stale∥capped; creds
 *        putBarrier stampede; TTL 300∥86400∥3600 triad; API_ERROR∥capped;
 *        four-way; getThrow(*); RATE_LIMITED∥INVALID∥hot; ttl-shrink∥capped;
 *        helpers∥RATE_LIMITED; omitted∥rl putThrow∥capped; cross KEY_ID
 *        deleteThrow∥hot; retryAfterMs exact pin),
 *   #313 second-wave / #299 first-wave (see prior leftovers headers).
 *   open #367 fifth-wave (API empty body∥capped; string reject∥capped;
 *        iceServers {}∥capped; username-only∥capped; cred-only∥hot;
 *        TTL NaN∥hot; NEG_INFINITY∥capped; ===now deleteHold∥capped;
 *        RATE∥INVALID∥capped; seed=4 triple; KEY_A hot∥KEY_B empty-token;
 *        getThrow refill∥capped; ttl-shrink∥miss; helpers∥USER∥NOT_CONFIG;
 *        malformed JSON miss∥hot; four-way API∥capped∥healthy∥hot;
 *        text() throw∥capped; ===now dual-delete∥capped; omitted stampede∥capped;
 *        rl putHold∥sibling∥MAX hot) — niches below are disjoint.
 *
 * Gap table (why leftover after fourth-wave / disjoint from #367 fifth):
 *   whitespace-only secrets truthy → fetch ∥ '' NOT_CONFIGURED
 *     | second empty-string∥configured; fourth partial∥capped
 *   Retry-After "0" exact message ∥ USER_RATE_LIMITED
 *     | never zero Retry-After under PA
 *   Retry-After "abc" non-numeric ∥ hot hit
 *     | fourth empty-string header only
 *   cache expiresAt:null → expire (null<=now) ∥ hot
 *     | fourth NaN expiresAt quirky-hit; third {} overlay
 *   cache missing expiresAt → remaining ttl NaN ∥ capped
 *     | distinct from explicit NaN expiresAt
 *   empty-string username/credential falsy find-fail ∥ hot
 *     | second username-only/cred-only (missing field) not ''
 *   multi-user same CREDS miss stampede (alice∥bob∥carol rl)
 *     | first-wave single-user stampede only
 *   putHold CREDS ∥ putHold RL orthogonal
 *     | never dual orthogonal put-holds
 *   TTL 301∥86399 near-bound exact keys ∥ 3600 hot
 *     | third exact 300/86400/3600; fourth clamp outsides
 *   fetch AbortError ∥ USER_RATE_LIMITED
 *     | second Error∥hot; fourth TypeError∥capped
 *   credentialed urls:undefined → stun-only uris ∥ capped
 *     | third empty-urls []; fourth string-urls
 *   rl requests:number → filter TypeError fail-open ∥ capped
 *     | fourth null/string only
 *   cache expiresAt:0 always-expired ∥ hot
 *     | never epoch-0 under PA
 *   four-way NOT_CONFIGURED∥API_ERROR∥capped∥hot
 *     | third four-way put-hold∥capped∥healthy∥hot
 *   deleteHold expired then putHold refill ∥ capped
 *     | first delete-hold alone; fourth deleteHold∥capped∥hot
 *   whitespace KEY_ID status redact ∥ cold miss OK
 *     | fourth short-key; never whitespace key
 *   cross KEY_ID putThrow warn∥hot∥capped three-way
 *     | second API fail∥hot; third deleteThrow∥hot
 *   credentialed urls:[] → uris=[stun] ok ∥ no-creds INVALID
 *     | third empty-urls∥valid (valid had urls)
 *   seed=0 eight-way same-user RMW all-allow last-write-1
 *     | first 4-way only
 *   helpers∥TurnError matrix∥cold miss under PA
 *     | third helpers∥RATE_LIMITED fetch only
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
const KEY_ID_WS = '  turnws  ';
const ALICE = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DAVE = '@dave:example.com';
const CREDS_KEY = `turn_creds:${KEY_ID}:3600`;
const CREDS_KEY_TTL300 = `turn_creds:${KEY_ID}:300`;
const CREDS_KEY_301 = `turn_creds:${KEY_ID}:301`;
const CREDS_KEY_86399 = `turn_creds:${KEY_ID}:86399`;
const CREDS_KEY_B = `turn_creds:${KEY_ID_B}:3600`;
const CREDS_KEY_WS = `turn_creds:${KEY_ID_WS}:3600`;
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
// Whitespace-only secrets truthy → fetch ∥ empty-string NOT_CONFIGURED
// ---------------------------------------------------------------------------

describe('race turn whitespace secrets∥empty NOT_CONFIGURED sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`space/tab secrets fetch∥'' key/token reject flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[`turn_creds: :3600`, 1], [`turn_creds:\t:3600`, 1]],
      });
      stubFetchOk(ctl, iceBody(`ws-${i}`, 'wp'));

      const settled = await Promise.allSettled([
        getMatrixTurnCredentials(
          turnEnv(kv, { TURN_KEY_ID: ' ', TURN_API_TOKEN: 'turn-token' }),
          3600
        ),
        getMatrixTurnCredentials(
          turnEnv(kv, { TURN_KEY_ID: '\t', TURN_API_TOKEN: 'turn-token' }),
          3600
        ),
        getMatrixTurnCredentials(
          turnEnv(kv, { TURN_KEY_ID: '', TURN_API_TOKEN: 'turn-token' }),
          3600
        ),
        getMatrixTurnCredentials(
          turnEnv(kv, { TURN_KEY_ID: KEY_ID, TURN_API_TOKEN: '' }),
          3600
        ),
      ]);

      expect(settled[0].status).toBe('fulfilled');
      expect(settled[1].status).toBe('fulfilled');
      expect(settled[2].status).toBe('rejected');
      if (settled[2].status === 'rejected') {
        expect(settled[2].reason).toMatchObject({ code: 'NOT_CONFIGURED' });
      }
      expect(settled[3].status).toBe('rejected');
      if (settled[3].status === 'rejected') {
        expect(settled[3].reason).toMatchObject({ code: 'NOT_CONFIGURED' });
      }
      expect(ctl.fetchStarts).toBe(2);
      expect(isTurnConfigured(turnEnv(kv, { TURN_KEY_ID: ' ', TURN_API_TOKEN: 't' }))).toBe(true);
      expect(isTurnConfigured(turnEnv(kv, { TURN_KEY_ID: '', TURN_API_TOKEN: 't' }))).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Retry-After "0" exact message ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn Retry-After 0∥USER_RATE_LIMITED sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`429 Retry-After:0 → "0 seconds"∥alice capped flood-${i}`, async () => {
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
          return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
        })
      );

      const [miss, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({
          code: 'RATE_LIMITED',
          statusCode: 429,
          message: 'TURN API rate limited. Retry after 0 seconds.',
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
// Retry-After "abc" non-numeric ∥ hot hit
// ---------------------------------------------------------------------------

describe('race turn Retry-After abc∥hot hit sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`429 Retry-After:abc passthrough∥3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-abc' })),
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
          return new Response('', { status: 429, headers: { 'Retry-After': 'abc' } });
        })
      );

      const [hit, miss] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hit.status).toBe('fulfilled');
      if (hit.status === 'fulfilled') {
        expect(hit.value.username).toBe('hot-abc');
      }
      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({
          code: 'RATE_LIMITED',
          message: 'TURN API rate limited. Retry after abc seconds.',
        });
      }
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// cache expiresAt:null → expire (null<=now) ∥ hot
// ---------------------------------------------------------------------------

describe('race turn expiresAt null expire∥hot sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`null expiresAt deletes+refetch∥300 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'null-exp', expiresAt: null })),
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
      stubFetchOk(ctl, iceBody(`fresh-null-${i}`, 'fn'));

      const [expired, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(expired.username).toBe(`fresh-null-${i}`);
      expect(hot.username).toBe('hot300');
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// cache missing expiresAt → remaining ttl NaN ∥ capped
// ---------------------------------------------------------------------------

describe('race turn missing expiresAt NaN-ttl∥capped sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`no expiresAt field → ttl NaN hit∥alice capped flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify({
          username: 'no-exp',
          password: 'pw',
          uris: ['turn:no-exp.example.com'],
          ttl: 3600,
          // expiresAt intentionally absent
        }),
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

      const [hit, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(hit.status).toBe('fulfilled');
      if (hit.status === 'fulfilled') {
        expect(hit.value.username).toBe('no-exp');
        expect(Number.isNaN(hit.value.ttl)).toBe(true);
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
// empty-string username/credential falsy find-fail ∥ hot
// ---------------------------------------------------------------------------

describe('race turn empty-string creds find-fail∥hot sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`username:''∥credential:'' INVALID∥3600 hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'hot-empty' })),
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
            return new Response(
              JSON.stringify({
                iceServers: [{ urls: ['turn:x'], username: '', credential: 'p' }],
              }),
              { status: 200 }
            );
          }
          return new Response(
            JSON.stringify({
              iceServers: [{ urls: ['turn:x'], username: 'u', credential: '' }],
            }),
            { status: 200 }
          );
        })
      );

      const [hit, emptyUser, emptyCred] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 300),
      ]);

      expect(hit.status).toBe('fulfilled');
      if (hit.status === 'fulfilled') {
        expect(hit.value.username).toBe('hot-empty');
      }
      expect(emptyUser.status).toBe('rejected');
      if (emptyUser.status === 'rejected') {
        expect(emptyUser.reason).toMatchObject({
          code: 'INVALID_RESPONSE',
          message: expect.stringContaining('no server with credentials'),
        });
      }
      expect(emptyCred.status).toBe('rejected');
      if (emptyCred.status === 'rejected') {
        expect(emptyCred.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
      }
      expect(ctl.fetchStarts).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// multi-user same CREDS miss stampede (alice∥bob∥carol rl)
// ---------------------------------------------------------------------------

describe('race turn multi-user shared CREDS miss stampede sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`alice∥bob∥carol miss share CREDS_KEY; 3 rl puts flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[CREDS_KEY, 3]],
      });
      stubFetchOk(ctl, iceBody(`shared-${i}`, 'sp'));

      const [a, b, c] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
        getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL),
      ]);

      expect(a.username).toBe(`shared-${i}`);
      expect(b.username).toBe(`shared-${i}`);
      expect(c.username).toBe(`shared-${i}`);
      expect(ctl.fetchStarts).toBe(3);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(3);
      expect(ctl.putCount.get(RL_ALICE)).toBe(1);
      expect(ctl.putCount.get(RL_BOB)).toBe(1);
      expect(ctl.putCount.get(RL_CAROL)).toBe(1);
      expect(ctl.putTtl.get(RL_ALICE)).toBe(70);
    });
  }
});

// ---------------------------------------------------------------------------
// putHold CREDS ∥ putHold RL orthogonal
// ---------------------------------------------------------------------------

describe('race turn putHold CREDS∥putHold RL orthogonal sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`creds put-hold∥alice rl put-hold both release flood-${i}`, async () => {
      const { kv, ctl, releasePut } = createRacingKv({
        putHold: [CREDS_KEY, RL_ALICE],
      });
      stubFetchOk(ctl, iceBody('ortho', 'op'));

      let missDone = false;
      let aliceDone = false;
      const missP = getMatrixTurnCredentials(turnEnv(kv), 3600).then((r) => {
        missDone = true;
        return r;
      });
      const aliceP = getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE).then((r) => {
        aliceDone = true;
        return r;
      });

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${CREDS_KEY}`))).toBe(true);
        expect(ctl.events.some((e) => e.includes(`put-wait:${RL_ALICE}`))).toBe(true);
      });
      expect(missDone).toBe(false);
      expect(aliceDone).toBe(false);

      releasePut(RL_ALICE);
      await vi.waitFor(() => {
        expect(aliceDone || ctl.data[RL_ALICE] !== undefined || ctl.putCount.get(RL_ALICE)! >= 1).toBe(
          true
        );
      });
      // alice may still be blocked on CREDS put if she missed cache
      releasePut(CREDS_KEY);
      const [miss, alice] = await Promise.all([missP, aliceP]);
      expect(miss.username).toBe('ortho');
      expect(alice.username).toBe('ortho');
      expect(missDone).toBe(true);
      expect(aliceDone).toBe(true);
      expect(ctl.fetchStarts).toBeGreaterThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// TTL 301∥86399 near-bound exact keys ∥ 3600 hot
// ---------------------------------------------------------------------------

describe('race turn TTL 301∥86399∥3600 hot triad sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`301 miss∥86399 miss∥3600 hot under barriers flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'mid-hot' })),
      };
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_301, 1],
          [CREDS_KEY_86399, 1],
          [CREDS_KEY, 1],
        ],
      });
      const fetchMock = stubFetchOk(ctl, iceBody(`near-${i}`, 'np'));

      const [low, high, hot] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 301),
        getMatrixTurnCredentials(turnEnv(kv), 86399),
        getMatrixTurnCredentials(turnEnv(kv), 3600),
      ]);

      expect(low.ttl).toBe(301);
      expect(high.ttl).toBe(86399);
      expect(hot.username).toBe('mid-hot');
      expect(ctl.fetchStarts).toBe(2);
      expect(ctl.putTtl.get(CREDS_KEY_301)).toBe(Math.floor(301 * 0.8));
      expect(ctl.putTtl.get(CREDS_KEY_86399)).toBe(Math.floor(86399 * 0.8));
      const bodies = fetchMock.mock.calls.map((c) => c[1].body as string).sort();
      expect(bodies).toEqual([
        JSON.stringify({ ttl: 301 }),
        JSON.stringify({ ttl: 86399 }),
      ]);
    });
  }
});

// ---------------------------------------------------------------------------
// fetch AbortError ∥ USER_RATE_LIMITED
// ---------------------------------------------------------------------------

describe('race turn fetch AbortError∥USER_RATE_LIMITED sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`AbortError connect fail∥bob capped flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_BOB, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [RL_BOB, 1],
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          ctl.fetchStarts += 1;
          throw new DOMException('The operation was aborted.', 'AbortError');
        })
      );

      const [miss, bob] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(miss.status).toBe('rejected');
      if (miss.status === 'rejected') {
        expect(miss.reason).toMatchObject({
          code: 'API_ERROR',
          message: 'Failed to connect to TURN API: The operation was aborted.',
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
// credentialed urls:undefined → stun-only uris ∥ capped
// ---------------------------------------------------------------------------

describe('race turn credentialed urls undefined∥capped sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`urls omitted → uris=[stun] only∥alice capped flood-${i}`, async () => {
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
                { username: 'nou', credential: 'nop' }, // urls undefined
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
        expect(ok.value.username).toBe('nou');
        expect(ok.value.uris).toEqual(['stun:stun.cloudflare.com:3478']);
      }
      expect(alice.status).toBe('rejected');
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// rl requests:number → filter TypeError fail-open ∥ capped
// ---------------------------------------------------------------------------

describe('race turn rl requests number fail-open∥capped sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`alice requests:7 TypeError fail-open∥bob seed=5 flood-${i}`, async () => {
      const data: Record<string, string> = {};
      seedRateLimit(data, RL_BOB, 5);
      const { kv, ctl } = createRacingKv({
        data,
        jsonOverlay: {
          [RL_ALICE]: { requests: 7 },
        },
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
      // fail-open skips put after throw inside try
      expect(ctl.putCount.get(RL_ALICE) ?? 0).toBe(0);
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// cache expiresAt:0 always-expired ∥ hot
// ---------------------------------------------------------------------------

describe('race turn expiresAt 0 always-expired∥hot sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`expiresAt:0 delete+refetch∥MAX hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'epoch', expiresAt: 0 })),
        [`turn_creds:${KEY_ID}:86400`]: JSON.stringify(
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
          [CREDS_KEY, 1],
          [`turn_creds:${KEY_ID}:86400`, 1],
        ],
      });
      stubFetchOk(ctl, iceBody(`epoch-fresh-${i}`, 'ef'));

      const [expired, max] = await Promise.all([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 99_999),
      ]);

      expect(expired.username).toBe(`epoch-fresh-${i}`);
      expect(max.username).toBe('max-hot');
      expect(ctl.deleteCount.get(CREDS_KEY)).toBe(1);
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// four-way NOT_CONFIGURED∥API_ERROR∥capped∥hot
// ---------------------------------------------------------------------------

describe('race turn four-way NOT_CONFIGURED∥API_ERROR∥capped∥hot sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`empty secrets∥300 502∥alice capped∥bob hot flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'bob-hot' })),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        getBarrier: [
          [CREDS_KEY_TTL300, 1],
          [CREDS_KEY, 1],
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

      const [bad, miss, alice, bob] = await Promise.allSettled([
        getMatrixTurnCredentials({ CACHE: kv } as Env, 3600),
        getMatrixTurnCredentials(turnEnv(kv), 300),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
        getMatrixTurnCredentials(turnEnv(kv), 3600, BOB),
      ]);

      expect(bad.status).toBe('rejected');
      if (bad.status === 'rejected') {
        expect(bad.reason).toMatchObject({ code: 'NOT_CONFIGURED' });
      }
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
    });
  }
});

// ---------------------------------------------------------------------------
// deleteHold expired then putHold refill ∥ capped
// ---------------------------------------------------------------------------

describe('race turn deleteHold then putHold refill∥capped sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`expire delete-hold→put-hold refill∥carol capped flood-${i}`, async () => {
      const data: Record<string, string> = {
        [CREDS_KEY]: JSON.stringify(cachedCreds({ username: 'stale', expiresAt: NOW - 1 })),
      };
      seedRateLimit(data, RL_CAROL, 5);
      const { kv, ctl, releaseDelete, releasePut } = createRacingKv({
        data,
        deleteHold: [CREDS_KEY],
        putHold: [CREDS_KEY],
      });
      stubFetchOk(ctl, iceBody(`refill-${i}`, 'rf'));

      let expireDone = false;
      const expireP = getMatrixTurnCredentials(turnEnv(kv), 3600).then((r) => {
        expireDone = true;
        return r;
      });

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`delete-wait:${CREDS_KEY}`))).toBe(true);
      });
      expect(expireDone).toBe(false);

      // Attach rejection handler immediately to avoid unhandled USER_RATE_LIMITED
      const carolSettled = getMatrixTurnCredentials(turnEnv(kv), 3600, CAROL).then(
        (v) => ({ status: 'fulfilled' as const, value: v }),
        (reason) => ({ status: 'rejected' as const, reason })
      );

      releaseDelete(CREDS_KEY);

      await vi.waitFor(() => {
        expect(ctl.events.some((e) => e.includes(`put-wait:${CREDS_KEY}`))).toBe(true);
      });
      expect(expireDone).toBe(false);

      releasePut(CREDS_KEY);
      const [expired, carol] = await Promise.all([expireP, carolSettled]);
      expect(expired.username).toBe(`refill-${i}`);
      expect(carol.status).toBe('rejected');
      if (carol.status === 'rejected') {
        expect(carol.reason).toMatchObject({ code: 'USER_RATE_LIMITED' });
      }
      expect(expireDone).toBe(true);
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// whitespace KEY_ID status redact ∥ cold miss OK
// ---------------------------------------------------------------------------

describe('race turn whitespace KEY_ID status∥miss sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`status redact ws key∥cold miss fetch flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[CREDS_KEY_WS, 1]],
      });
      stubFetchOk(ctl, iceBody(`wskey-${i}`, 'wk'));
      const env = turnEnv(kv, { TURN_KEY_ID: KEY_ID_WS });

      const [status, configured, creds] = await Promise.all([
        Promise.resolve(getTurnStatus(env)),
        Promise.resolve(isTurnConfigured(env)),
        getMatrixTurnCredentials(env, 3600),
      ]);

      expect(configured).toBe(true);
      // slice(0, 8) of '  turnws  ' → '  turnws'
      expect(status).toEqual({ configured: true, keyId: '  turnws...' });
      expect(creds.username).toBe(`wskey-${i}`);
      expect(ctl.fetchStarts).toBe(1);
      expect(ctl.data[CREDS_KEY_WS]).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// cross KEY_ID putThrow warn∥hot∥capped three-way
// ---------------------------------------------------------------------------

describe('race turn cross KEY_ID putThrow∥hot∥capped sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`keyA putThrow warn∥keyB hot∥alice capped flood-${i}`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const data: Record<string, string> = {
        [CREDS_KEY_B]: JSON.stringify(cachedCreds({ username: 'hot-b' })),
      };
      seedRateLimit(data, RL_ALICE, 5);
      const { kv, ctl } = createRacingKv({
        data,
        putThrows: [CREDS_KEY],
        getBarrier: [
          [CREDS_KEY, 1],
          [CREDS_KEY_B, 1],
          [RL_ALICE, 1],
        ],
      });
      stubFetchOk(ctl, iceBody('a-miss', 'am'));

      const [a, b, alice] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv, { TURN_KEY_ID: KEY_ID_B }), 3600),
        getMatrixTurnCredentials(turnEnv(kv), 3600, ALICE),
      ]);

      expect(a.status).toBe('fulfilled');
      if (a.status === 'fulfilled') {
        expect(a.value.username).toBe('a-miss');
      }
      expect(b.status).toBe('fulfilled');
      if (b.status === 'fulfilled') {
        expect(b.value.username).toBe('hot-b');
      }
      expect(alice.status).toBe('rejected');
      expect(warn).toHaveBeenCalledWith('Failed to cache TURN credentials');
      expect(ctl.data[CREDS_KEY]).toBeUndefined();
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// credentialed urls:[] → uris=[stun] ok ∥ no-creds INVALID
// ---------------------------------------------------------------------------

describe('race turn empty-urls ok∥no-creds INVALID sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`urls:[] still credentialed∥stun-only INVALID∥barriers flood-${i}`, async () => {
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
            return new Response(
              JSON.stringify({ iceServers: [{ urls: ['stun:only'] }] }),
              { status: 200 }
            );
          }
          return new Response(
            JSON.stringify({
              iceServers: [
                { urls: ['stun:stun.cloudflare.com:3478'] },
                { urls: [], username: 'empty-urls', credential: 'eu' },
              ],
            }),
            { status: 200 }
          );
        })
      );

      const [ok, bad] = await Promise.allSettled([
        getMatrixTurnCredentials(turnEnv(kv), 3600),
        getMatrixTurnCredentials(turnEnv(kv, { TURN_KEY_ID: KEY_ID_B }), 3600),
      ]);

      expect(ok.status).toBe('fulfilled');
      if (ok.status === 'fulfilled') {
        expect(ok.value.username).toBe('empty-urls');
        expect(ok.value.uris).toEqual(['stun:stun.cloudflare.com:3478']);
      }
      expect(bad.status).toBe('rejected');
      if (bad.status === 'rejected') {
        expect(bad.reason).toMatchObject({ code: 'INVALID_RESPONSE' });
      }
      expect(ctl.fetchStarts).toBe(2);
      expect(ctl.data[CREDS_KEY]).toBeDefined();
      expect(ctl.data[CREDS_KEY_B]).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// seed=0 eight-way same-user RMW all-allow last-write-1
// ---------------------------------------------------------------------------

describe('race turn seed0 eight-way RMW last-write sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`8 parallel dave first-hits all allow; last rl length 1 flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[RL_DAVE, 8]],
      });
      stubFetchOk(ctl, iceBody(`eight-${i}`, 'ep'));

      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, () => getMatrixTurnCredentials(turnEnv(kv), 3600, DAVE))
      );

      expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
      expect(ctl.putCount.get(RL_DAVE)).toBe(8);
      const stored = JSON.parse(ctl.data[RL_DAVE]) as { requests: number[] };
      expect(stored.requests).toEqual([NOW]);
      expect(ctl.fetchStarts).toBe(8);
      expect(ctl.putCount.get(CREDS_KEY)).toBe(8);
    });
  }
});

// ---------------------------------------------------------------------------
// helpers∥TurnError matrix∥cold miss under PA
// ---------------------------------------------------------------------------

describe('race turn helpers∥TurnError matrix∥cold miss sixth-wave after #349/#357', () => {
  for (let i = 0; i < 8; i++) {
    it(`stun∥status∥errors∥cold miss parallel flood-${i}`, async () => {
      const { kv, ctl } = createRacingKv({
        getBarrier: [[CREDS_KEY, 1]],
      });
      stubFetchOk(ctl, iceBody(`help-${i}`, 'hp'));
      const env = turnEnv(kv);

      const [stun, status, configured, e1, e2, e3, creds] = await Promise.all([
        Promise.resolve(getStunServers()),
        Promise.resolve(getTurnStatus(env)),
        Promise.resolve(isTurnConfigured(env)),
        Promise.resolve(new TurnError('a', 'NOT_CONFIGURED')),
        Promise.resolve(new TurnError('b', 'RATE_LIMITED', 429)),
        Promise.resolve(new TurnError('c', 'USER_RATE_LIMITED', 429, 1000)),
        getMatrixTurnCredentials(env, 3600),
      ]);

      expect(stun).toEqual({
        username: '',
        password: '',
        uris: ['stun:stun.cloudflare.com:3478'],
        ttl: 86400,
      });
      expect(status).toEqual({ configured: true, keyId: 'turnkey1...' });
      expect(configured).toBe(true);
      expect(e1).toMatchObject({ code: 'NOT_CONFIGURED', name: 'TurnError' });
      expect(e2).toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });
      expect(e3).toMatchObject({ code: 'USER_RATE_LIMITED', retryAfterMs: 1000 });
      expect(creds.username).toBe(`help-${i}`);
      expect(ctl.fetchStarts).toBe(1);
    });
  }
});
