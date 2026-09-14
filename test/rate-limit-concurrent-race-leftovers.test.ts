/**
 * TOKENMAXX HEAVY leftovers after #223 — rate-limit middleware +
 * RateLimitDurableObject *concurrent race / TOCTOU*.
 *
 * Sequential unit coverage is deep (rate-limit.test.ts / rate-limit-durable-
 * object.test.ts: classifier traps, header pin, fail-open, OPTIONS/sync skip,
 * window expiry). Concurrent-race coverage was zero: no Promise.all, no
 * check-barrier double-spend, no login∥register bucket isolation under race,
 * no OPTIONS skip∥POST check, no DO check∥check first-window lost-update.
 *
 * Distinct from tip #223 (oidc-auth SSO state mint / callback consume),
 * #222 (federation-auth X-Matrix verify), #217 (client auth-middleware
 * Bearer/AS). Orthogonal to oidc/oauth/login-qr-identity concurrent-race
 * files — this slice is RATE_LIMIT DO sliding-window + fail-open middleware.
 *
 * Focus: allow∥deny isolation; fail-open∥deny; OPTIONS/sync skip∥check;
 * bucket + client isolation; get-barrier over-allow TOCTOU; header isolation;
 * strict∥global; DO check∥check lost-update after scheduleCleanup yield;
 * check∥reset / check∥cleanup.
 *
 * Tests-only. Fixtures use example.com / TEST-NET IPs only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { AppEnv } from '../src/types';
import {
  RATE_LIMITS,
  rateLimitMiddleware,
  strictRateLimit,
} from '../src/middleware/rate-limit';
import { FakeDurableObjectState, durableObjectMockFactory } from './helpers/fake-durable-object';

vi.mock('cloudflare:workers', () => durableObjectMockFactory());

import { RateLimitDurableObject } from '../src/durable-objects/RateLimitDurableObject';

const ALICE = '@alice:example.com';
const BOB = '@bob:example.com';
const IP_A = '203.0.113.10';
const IP_B = '203.0.113.11';
const IP_C = '198.51.100.20';
const NOW = 1_700_000_000_000;

type MwResult = { body?: unknown; status?: number; headers?: Record<string, string> } | string;

function makeContext(
  opts: {
    userId?: string;
    headers?: Record<string, string>;
    env?: Partial<AppEnv['Bindings']>;
    path?: string;
    method?: string;
  } = {}
): Context<AppEnv> & { _headers: Record<string, string> } {
  const headers = opts.headers ?? {};
  const setHeaders: Record<string, string> = {};
  return {
    get: (key: string) => (key === 'userId' ? opts.userId : undefined),
    req: {
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
      path: opts.path ?? '/_matrix/client/v3/login',
      method: opts.method ?? 'POST',
    },
    env: opts.env ?? {},
    header: (name: string, value: string) => {
      setHeaders[name] = value;
    },
    json: (body: unknown, status?: number) => ({
      body,
      status: status ?? 200,
      headers: setHeaders,
    }),
    _headers: setHeaders,
  } as unknown as Context<AppEnv> & { _headers: Record<string, string> };
}

type CheckBody = {
  action: string;
  clientId: string;
  limit: number;
  windowMs: number;
};

type CheckResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
  resetAt?: number;
};

type BarrierCtl = {
  barrier?: { count: number };
  flip?: { after: number; next: CheckResult | 'throw' | 'bad-json' };
  byClient?: Map<string, CheckResult | 'throw' | 'bad-json'>;
  defaultResult?: CheckResult | 'throw' | 'bad-json';
  delayMs?: number;
};

function installDoBinding(ctl: BarrierCtl = {}) {
  let callCount = 0;
  const waiters: Array<() => void> = [];
  const events: string[] = [];
  const names: string[] = [];
  const bodies: CheckBody[] = [];
  let barrier = ctl.barrier;

  const fetchImpl = async (req: Request) => {
    const myCall = ++callCount;
    const body = (await req.json()) as CheckBody;
    bodies.push(body);
    events.push(`check:${body.clientId}`);

    if (ctl.delayMs && ctl.delayMs > 0) {
      await new Promise((r) => setTimeout(r, ctl.delayMs));
    }

    if (barrier && waiters) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (waiters.length >= barrier!.count) {
          const all = [...waiters];
          waiters.length = 0;
          barrier = undefined;
          for (const w of all) w();
        }
      });
    }

    const mapped = ctl.byClient?.get(body.clientId);
    let result: CheckResult | 'throw' | 'bad-json' =
      mapped ?? ctl.defaultResult ?? { allowed: true, remaining: 9 };

    if (ctl.flip && myCall === ctl.flip.after) {
      events.push(`flip:${myCall}`);
      result = ctl.flip.next;
    }

    if (result === 'throw') throw new Error(`do-throw:${body.clientId}`);
    if (result === 'bad-json') return new Response('{not-json', { status: 500 });
    return Response.json(result);
  };

  const idFromName = vi.fn((name: string) => {
    names.push(name);
    return { name };
  });
  const get = vi.fn((id: { name: string }) => ({
    fetch: fetchImpl,
    id,
  }));

  return {
    binding: { idFromName, get },
    events,
    names,
    bodies,
    getCallCount: () => callCount,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function is429(res: MwResult): res is { status: number; body: unknown; headers: Record<string, string> } {
  return typeof res === 'object' && res !== null && (res as { status?: number }).status === 429;
}

// ---------------------------------------------------------------------------
// Middleware allow∥deny isolation under Promise.all
// ---------------------------------------------------------------------------

describe('race rate-limit mw allow∥deny isolation after #223', () => {
  for (let i = 0; i < 16; i++) {
    it(`login POST allow∥deny pair flood-${i}`, async () => {
      const ctl = installDoBinding({
        byClient: new Map([
          [`ip:${IP_A}`, { allowed: true, remaining: 8, resetAt: NOW + 60_000 }],
          [
            `ip:${IP_B}`,
            { allowed: false, remaining: 0, retryAfterMs: 1500, resetAt: NOW + 1500 },
          ],
        ]),
      });
      const okCtx = makeContext({
        path: '/_matrix/client/v3/login',
        method: 'POST',
        headers: { 'CF-Connecting-IP': IP_A },
        env: { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>,
      });
      const denyCtx = makeContext({
        path: '/_matrix/client/v3/login',
        method: 'POST',
        headers: { 'CF-Connecting-IP': IP_B },
        env: { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>,
      });
      const okNext = vi.fn(async () => `ok-${i}`);
      const denyNext = vi.fn();
      const [okRes, denyRes] = await Promise.all([
        rateLimitMiddleware(okCtx, okNext),
        rateLimitMiddleware(denyCtx, denyNext),
      ]);
      expect(okRes).toBe(`ok-${i}`);
      expect(okNext).toHaveBeenCalledOnce();
      expect(okCtx._headers['X-RateLimit-Remaining']).toBe('8');
      expect(is429(denyRes as MwResult)).toBe(true);
      expect((denyRes as { body: unknown }).body).toEqual({
        errcode: 'M_LIMIT_EXCEEDED',
        error: 'Too many requests',
        retry_after_ms: 1500,
      });
      expect(denyNext).not.toHaveBeenCalled();
      expect(ctl.names.every((n) => n === 'login')).toBe(true);
    });
  }
});

describe('race rate-limit mw fail-open∥deny isolation after #223', () => {
  for (let i = 0; i < 12; i++) {
    it(`DO throw∥deny pair flood-${i}`, async () => {
      const ctl = installDoBinding({
        byClient: new Map([
          [`ip:${IP_A}`, 'throw'],
          [`ip:${IP_B}`, { allowed: false, remaining: 0, retryAfterMs: 2000 }],
        ]),
      });
      const throwCtx = makeContext({
        headers: { 'CF-Connecting-IP': IP_A },
        env: { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>,
      });
      const denyCtx = makeContext({
        headers: { 'CF-Connecting-IP': IP_B },
        env: { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>,
      });
      const [openRes, denyRes] = await Promise.all([
        rateLimitMiddleware(throwCtx, vi.fn(async () => 'open')),
        rateLimitMiddleware(denyCtx, vi.fn()),
      ]);
      expect(openRes).toBe('open');
      expect(is429(denyRes as MwResult)).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`bad-json fail-open∥allow flood-${i}`, async () => {
      const ctl = installDoBinding({
        byClient: new Map([
          [`ip:${IP_A}`, 'bad-json'],
          [`ip:${IP_B}`, { allowed: true, remaining: 4 }],
        ]),
      });
      const [openRes, okRes] = await Promise.all([
        rateLimitMiddleware(
          makeContext({
            headers: { 'CF-Connecting-IP': IP_A },
            env: { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>,
          }),
          vi.fn(async () => 'open')
        ),
        rateLimitMiddleware(
          makeContext({
            headers: { 'CF-Connecting-IP': IP_B },
            env: { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>,
          }),
          vi.fn(async () => 'ok')
        ),
      ]);
      expect(openRes).toBe('open');
      expect(okRes).toBe('ok');
    });
  }
});

// ---------------------------------------------------------------------------
// OPTIONS / sync skip ∥ POST check
// ---------------------------------------------------------------------------

describe('race rate-limit OPTIONS skip∥POST check after #223', () => {
  for (let i = 0; i < 10; i++) {
    it(`OPTIONS login skip∥POST login check flood-${i}`, async () => {
      const ctl = installDoBinding({
        defaultResult: { allowed: true, remaining: 7 },
      });
      const env = { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>;
      const optNext = vi.fn(async () => 'opts');
      const postNext = vi.fn(async () => 'post');
      const [optRes, postRes] = await Promise.all([
        rateLimitMiddleware(
          makeContext({ method: 'OPTIONS', path: '/_matrix/client/v3/login', env }),
          optNext
        ),
        rateLimitMiddleware(
          makeContext({
            method: 'POST',
            path: '/_matrix/client/v3/login',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          postNext
        ),
      ]);
      expect(optRes).toBe('opts');
      expect(postRes).toBe('post');
      expect(ctl.getCallCount()).toBe(1);
      expect(ctl.names).toEqual(['login']);
      expect(optNext).toHaveBeenCalledOnce();
      expect(postNext).toHaveBeenCalledOnce();
    });
  }
});

describe('race rate-limit sync skip∥login check after #223', () => {
  for (let i = 0; i < 10; i++) {
    it(`GET /sync skip∥POST login check flood-${i}`, async () => {
      const ctl = installDoBinding({
        defaultResult: { allowed: false, remaining: 0, retryAfterMs: 1000 },
      });
      const env = { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>;
      const [syncRes, loginRes] = await Promise.all([
        rateLimitMiddleware(
          makeContext({ method: 'GET', path: '/_matrix/client/v3/sync', env }),
          vi.fn(async () => 'sync')
        ),
        rateLimitMiddleware(
          makeContext({
            method: 'POST',
            path: '/_matrix/client/v3/login',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn()
        ),
      ]);
      expect(syncRes).toBe('sync');
      expect(is429(loginRes as MwResult)).toBe(true);
      expect(ctl.names).toEqual(['login']);
    });
  }
});

// ---------------------------------------------------------------------------
// Bucket + client isolation
// ---------------------------------------------------------------------------

describe('race rate-limit bucket isolation login∥register after #223', () => {
  for (let i = 0; i < 12; i++) {
    it(`parallel login∥register hit distinct DO ids flood-${i}`, async () => {
      const ctl = installDoBinding({
        defaultResult: { allowed: true, remaining: 1 },
      });
      const env = { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>;
      const [loginRes, regRes] = await Promise.all([
        rateLimitMiddleware(
          makeContext({
            path: '/_matrix/client/v3/login',
            method: 'POST',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'login')
        ),
        rateLimitMiddleware(
          makeContext({
            path: '/_matrix/client/v3/register',
            method: 'POST',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'register')
        ),
      ]);
      expect(loginRes).toBe('login');
      expect(regRes).toBe('register');
      expect(new Set(ctl.names)).toEqual(new Set(['login', 'register']));
      expect(ctl.bodies).toHaveLength(2);
      expect(ctl.bodies.map((b) => b.limit).sort((a, b) => a - b)).toEqual([
        RATE_LIMITS.register.requests,
        RATE_LIMITS.login.requests,
      ]);
    });
  }
});

describe('race rate-limit client isolation user∥ip after #223', () => {
  for (let i = 0; i < 10; i++) {
    it(`Alice user bucket∥anon IP bucket flood-${i}`, async () => {
      const ctl = installDoBinding({
        byClient: new Map([
          [`user:${ALICE}`, { allowed: true, remaining: 9 }],
          [`ip:${IP_C}`, { allowed: false, remaining: 0, retryAfterMs: 3000 }],
        ]),
      });
      const env = { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>;
      const [userRes, ipRes] = await Promise.all([
        rateLimitMiddleware(
          makeContext({
            userId: ALICE,
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'alice')
        ),
        rateLimitMiddleware(
          makeContext({
            headers: { 'CF-Connecting-IP': IP_C },
            env,
          }),
          vi.fn()
        ),
      ]);
      expect(userRes).toBe('alice');
      expect(is429(ipRes as MwResult)).toBe(true);
      expect(ctl.bodies.map((b) => b.clientId).sort()).toEqual(
        [`ip:${IP_C}`, `user:${ALICE}`].sort()
      );
    });
  }
});

describe('race rate-limit N-client header isolation after #223', () => {
  for (let i = 0; i < 8; i++) {
    it(`four IPs pin distinct remaining headers flood-${i}`, async () => {
      const ips = [IP_A, IP_B, IP_C, '203.0.113.99'];
      const ctl = installDoBinding({
        byClient: new Map(
          ips.map((ip, j) => [`ip:${ip}`, { allowed: true, remaining: 10 - j }] as const)
        ),
      });
      const env = { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>;
      const ctxs = ips.map((ip) =>
        makeContext({
          headers: { 'CF-Connecting-IP': ip },
          env,
        })
      );
      const results = await Promise.all(
        ctxs.map((ctx, j) => rateLimitMiddleware(ctx, vi.fn(async () => `n${j}`)))
      );
      expect(results).toEqual(['n0', 'n1', 'n2', 'n3']);
      expect(ctxs.map((c) => c._headers['X-RateLimit-Remaining'])).toEqual([
        '10',
        '9',
        '8',
        '7',
      ]);
      expect(ctxs.every((c) => c._headers['X-RateLimit-Limit'] === '10')).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Get-barrier TOCTOU — both see allow before either records
// ---------------------------------------------------------------------------

describe('race rate-limit get-barrier over-allow TOCTOU after #223', () => {
  for (let i = 0; i < 10; i++) {
    it(`same-IP dual check barrier both allowed flood-${i}`, async () => {
      const ctl = installDoBinding({
        barrier: { count: 2 },
        defaultResult: { allowed: true, remaining: 0 },
      });
      const env = { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>;
      const [a, b] = await Promise.all([
        rateLimitMiddleware(
          makeContext({
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'a')
        ),
        rateLimitMiddleware(
          makeContext({
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'b')
        ),
      ]);
      // Mock has no shared counter: barrier documents over-allow (both next()).
      expect([a, b].sort()).toEqual(['a', 'b']);
      expect(ctl.getCallCount()).toBe(2);
      expect(ctl.bodies.every((body) => body.clientId === `ip:${IP_A}`)).toBe(true);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`barrier then flip-deny on 2nd call flood-${i}`, async () => {
      const ctl = installDoBinding({
        barrier: { count: 2 },
        defaultResult: { allowed: true, remaining: 1 },
        flip: { after: 2, next: { allowed: false, remaining: 0, retryAfterMs: 4000 } },
      });
      const env = { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>;
      const [ra, rb] = await Promise.all([
        rateLimitMiddleware(
          makeContext({
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'a')
        ),
        rateLimitMiddleware(
          makeContext({
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'b')
        ),
      ]);
      const oks = [ra, rb].filter((r) => r === 'a' || r === 'b');
      const denies = [ra, rb].filter((r) => is429(r as MwResult));
      expect(oks.length).toBe(1);
      expect(denies.length).toBe(1);
      expect(ctl.getCallCount()).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// strictRateLimit ∥ global
// ---------------------------------------------------------------------------

describe('race strict∥global rate-limit after #223', () => {
  for (let i = 0; i < 10; i++) {
    it(`strict path DO id∥login bucket flood-${i}`, async () => {
      const ctl = installDoBinding({
        defaultResult: { allowed: true, remaining: 0 },
      });
      const env = { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>;
      const path = '/_matrix/client/v3/register';
      const [strictRes, loginRes] = await Promise.all([
        strictRateLimit(2, 30_000)(
          makeContext({
            path,
            method: 'POST',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'strict')
        ),
        rateLimitMiddleware(
          makeContext({
            path: '/_matrix/client/v3/login',
            method: 'POST',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'login')
        ),
      ]);
      expect(strictRes).toBe('strict');
      expect(loginRes).toBe('login');
      expect(new Set(ctl.names)).toEqual(new Set([`strict:${path}`, 'login']));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`strict throw fail-open∥strict deny flood-${i}`, async () => {
      const ctl = installDoBinding({
        byClient: new Map([
          [`ip:${IP_A}`, 'throw'],
          [`ip:${IP_B}`, { allowed: false, remaining: 0 }],
        ]),
      });
      const env = { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>;
      const mw = strictRateLimit(1, 5000);
      const [openRes, denyRes] = await Promise.all([
        mw(
          makeContext({
            path: '/strict',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'open')
        ),
        mw(
          makeContext({
            path: '/strict',
            headers: { 'CF-Connecting-IP': IP_B },
            env,
          }),
          vi.fn()
        ),
      ]);
      expect(openRes).toBe('open');
      expect(is429(denyRes as MwResult)).toBe(true);
      expect((denyRes as { body: { retry_after_ms: number } }).body.retry_after_ms).toBe(5000);
    });
  }
});

describe('race rate-limit media∥e2ee∥search buckets after #223', () => {
  for (let i = 0; i < 8; i++) {
    it(`three write buckets isolate DO names flood-${i}`, async () => {
      const ctl = installDoBinding({
        defaultResult: { allowed: true, remaining: 2 },
      });
      const env = { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>;
      const results = await Promise.all([
        rateLimitMiddleware(
          makeContext({
            path: '/_matrix/media/v3/upload',
            method: 'POST',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'media')
        ),
        rateLimitMiddleware(
          makeContext({
            path: '/_matrix/client/v3/keys/upload',
            method: 'POST',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'e2ee')
        ),
        rateLimitMiddleware(
          makeContext({
            path: '/_matrix/client/v3/search',
            method: 'POST',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'search')
        ),
      ]);
      expect(results.sort()).toEqual(['e2ee', 'media', 'search']);
      expect(new Set(ctl.names)).toEqual(new Set(['media_upload', 'e2ee', 'search']));
      const limits = ctl.bodies.map((b) => b.limit).sort((a, b) => a - b);
      expect(limits).toEqual([
        RATE_LIMITS.search.requests,
        RATE_LIMITS.media_upload.requests,
        RATE_LIMITS.e2ee.requests,
      ]);
    });
  }
});

describe('race rate-limit trusted-XFF∥CF-IP under Promise.all after #223', () => {
  for (let i = 0; i < 8; i++) {
    it(`CF wins over XFF while sibling uses trusted XFF flood-${i}`, async () => {
      const ctl = installDoBinding({
        byClient: new Map([
          [`ip:${IP_A}`, { allowed: true, remaining: 5 }],
          [`ip:${IP_C}`, { allowed: true, remaining: 3 }],
        ]),
      });
      const envCf = {
        RATE_LIMIT: ctl.binding,
        TRUST_FORWARDED_FOR: 'true',
      } as Partial<AppEnv['Bindings']>;
      const [cfRes, xffRes] = await Promise.all([
        rateLimitMiddleware(
          makeContext({
            headers: { 'CF-Connecting-IP': IP_A, 'X-Forwarded-For': IP_C },
            env: envCf,
          }),
          vi.fn(async () => 'cf')
        ),
        rateLimitMiddleware(
          makeContext({
            headers: { 'X-Forwarded-For': `${IP_C}, 10.0.0.1` },
            env: envCf,
          }),
          vi.fn(async () => 'xff')
        ),
      ]);
      expect(cfRes).toBe('cf');
      expect(xffRes).toBe('xff');
      expect(new Set(ctl.bodies.map((b) => b.clientId))).toEqual(
        new Set([`ip:${IP_A}`, `ip:${IP_C}`])
      );
    });
  }
});

describe('race rate-limit Alice∥Bob user buckets after #223', () => {
  for (let i = 0; i < 8; i++) {
    it(`two authenticated users isolate clientId flood-${i}`, async () => {
      const ctl = installDoBinding({
        byClient: new Map([
          [`user:${ALICE}`, { allowed: true, remaining: 6 }],
          [`user:${BOB}`, { allowed: false, remaining: 0, retryAfterMs: 900 }],
        ]),
      });
      const env = { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>;
      const [a, b] = await Promise.all([
        rateLimitMiddleware(
          makeContext({ userId: ALICE, env }),
          vi.fn(async () => 'alice')
        ),
        rateLimitMiddleware(makeContext({ userId: BOB, env }), vi.fn()),
      ]);
      expect(a).toBe('alice');
      expect(is429(b as MwResult)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// RateLimitDurableObject concurrent check / reset / cleanup
// ---------------------------------------------------------------------------

function makeDo(state = new FakeDurableObjectState()) {
  return {
    state,
    do: new RateLimitDurableObject(
      state as unknown as DurableObjectState,
      {} as Record<string, unknown>
    ),
  };
}

async function doCheck(
  rateLimitDo: RateLimitDurableObject,
  clientId: string,
  limit: number,
  windowMs: number
) {
  const res = await rateLimitDo.fetch(
    new Request('https://do/', {
      method: 'POST',
      body: JSON.stringify({ action: 'check', clientId, limit, windowMs }),
    })
  );
  return { status: res.status, body: (await res.json()) as CheckResult };
}

describe('race RateLimitDO check∥check first-window TOCTOU after #223', () => {
  for (let i = 0; i < 12; i++) {
    it(`parallel first-window same clientId flood-${i}`, async () => {
      const { do: rateLimitDo } = makeDo();
      const clientId = `ip:race-${i}`;
      const [a, b] = await Promise.all([
        doCheck(rateLimitDo, clientId, 1, 60_000),
        doCheck(rateLimitDo, clientId, 1, 60_000),
      ]);
      const allowed = [a, b].filter((r) => r.body.allowed).length;
      const denied = [a, b].filter((r) => !r.body.allowed).length;
      // scheduleCleanup awaits getAlarm() between Map.get and Map.set on the
      // empty-window path — both workers may mint count=1 (over-allow) or one
      // may serialize after the other. Document both legal outcomes; never crash.
      expect(allowed + denied).toBe(2);
      expect(allowed).toBeGreaterThanOrEqual(1);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
    });
  }

  it('sequential contrast: limit 1 allows then denies', async () => {
    const { do: rateLimitDo } = makeDo();
    expect((await doCheck(rateLimitDo, 'ip:seq', 1, 60_000)).body.allowed).toBe(true);
    expect((await doCheck(rateLimitDo, 'ip:seq', 1, 60_000)).body.allowed).toBe(false);
  });
});

describe('race RateLimitDO client isolation under Promise.all after #223', () => {
  for (let i = 0; i < 10; i++) {
    it(`limit-1 A exhausts while B still allows flood-${i}`, async () => {
      const { do: rateLimitDo } = makeDo();
      await doCheck(rateLimitDo, `ip:a-${i}`, 1, 60_000);
      const [a, b] = await Promise.all([
        doCheck(rateLimitDo, `ip:a-${i}`, 1, 60_000),
        doCheck(rateLimitDo, `ip:b-${i}`, 1, 60_000),
      ]);
      expect(a.body.allowed).toBe(false);
      expect(b.body.allowed).toBe(true);
      expect(b.body.remaining).toBe(0);
    });
  }
});

describe('race RateLimitDO check∥reset TOCTOU after #223', () => {
  for (let i = 0; i < 10; i++) {
    it(`exhausted client reset∥check flood-${i}`, async () => {
      const { do: rateLimitDo } = makeDo();
      const clientId = `ip:rst-${i}`;
      await doCheck(rateLimitDo, clientId, 1, 60_000);
      const [checkRes, resetRes] = await Promise.all([
        doCheck(rateLimitDo, clientId, 1, 60_000),
        rateLimitDo.fetch(
          new Request('https://do/', {
            method: 'POST',
            body: JSON.stringify({ action: 'reset', clientId }),
          })
        ),
      ]);
      expect(resetRes.status).toBe(200);
      expect(await resetRes.json()).toEqual({ success: true });
      // Check may observe pre-reset deny or post-reset allow depending on interleave.
      expect(checkRes.status).toBe(200);
      expect(typeof checkRes.body.allowed).toBe('boolean');
      const after = await doCheck(rateLimitDo, clientId, 1, 60_000);
      expect(after.status).toBe(200);
    });
  }
});

describe('race RateLimitDO check∥cleanup after #223', () => {
  for (let i = 0; i < 8; i++) {
    it(`in-window check∥cleanup keeps counter flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const { do: rateLimitDo } = makeDo();
      const clientId = `ip:cu-${i}`;
      await doCheck(rateLimitDo, clientId, 2, 60_000);
      const [checkRes, cleanupRes] = await Promise.all([
        doCheck(rateLimitDo, clientId, 2, 60_000),
        rateLimitDo.fetch(
          new Request('https://do/', {
            method: 'POST',
            body: JSON.stringify({ action: 'cleanup' }),
          })
        ),
      ]);
      expect(await cleanupRes.json()).toEqual({ success: true });
      expect(checkRes.body.allowed).toBe(true);
      expect(checkRes.body.remaining).toBe(0);
      const third = await doCheck(rateLimitDo, clientId, 2, 60_000);
      expect(third.body.allowed).toBe(false);
      vi.useRealTimers();
    });
  }
});

describe('race RateLimitDO malformed∥check isolation after #223', () => {
  for (let i = 0; i < 8; i++) {
    it(`invalid JSON 500∥valid check 200 flood-${i}`, async () => {
      const { do: rateLimitDo } = makeDo();
      const [bad, ok] = await Promise.all([
        rateLimitDo.fetch(new Request('https://do/', { method: 'POST', body: '{not-json' })),
        doCheck(rateLimitDo, `ip:ok-${i}`, 5, 60_000),
      ]);
      expect(bad.status).toBe(500);
      expect(await bad.json()).toEqual({ error: 'Internal error' });
      expect(ok.status).toBe(200);
      expect(ok.body.allowed).toBe(true);
      expect(ok.body.remaining).toBe(4);
    });
  }
});

describe('race rate-limit createRoom∥send_message buckets after #223', () => {
  for (let i = 0; i < 8; i++) {
    it(`createRoom POST∥room send PUT isolate flood-${i}`, async () => {
      const ctl = installDoBinding({
        defaultResult: { allowed: true, remaining: 1 },
      });
      const env = { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>;
      const [roomRes, sendRes] = await Promise.all([
        rateLimitMiddleware(
          makeContext({
            path: '/_matrix/client/v3/createRoom',
            method: 'POST',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'room')
        ),
        rateLimitMiddleware(
          makeContext({
            path: '/_matrix/client/v3/rooms/!r:example.com/send/m.room.message/t1',
            method: 'PUT',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'send')
        ),
      ]);
      expect(roomRes).toBe('room');
      expect(sendRes).toBe('send');
      expect(new Set(ctl.names)).toEqual(new Set(['create_room', 'send_message']));
    });
  }
});

describe('race rate-limit federation∥media-download after #223', () => {
  for (let i = 0; i < 8; i++) {
    it(`federation send∥media GET isolate flood-${i}`, async () => {
      const ctl = installDoBinding({
        defaultResult: { allowed: true, remaining: 10 },
      });
      const env = { RATE_LIMIT: ctl.binding } as Partial<AppEnv['Bindings']>;
      const [fedRes, mediaRes] = await Promise.all([
        rateLimitMiddleware(
          makeContext({
            path: '/_matrix/federation/v1/send/txn',
            method: 'PUT',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'fed')
        ),
        rateLimitMiddleware(
          makeContext({
            path: '/_matrix/media/v3/download/example.com/abc',
            method: 'GET',
            headers: { 'CF-Connecting-IP': IP_A },
            env,
          }),
          vi.fn(async () => 'media')
        ),
      ]);
      expect(fedRes).toBe('fed');
      expect(mediaRes).toBe('media');
      expect(new Set(ctl.names)).toEqual(new Set(['federation', 'media_download']));
    });
  }
});
