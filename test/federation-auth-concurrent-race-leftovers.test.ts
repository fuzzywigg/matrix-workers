/**
 * TOKENMAXX HEAVY leftovers after #217 — federation-auth middleware
 * *concurrent race / TOCTOU* + residual soft edges.
 *
 * Complements federation-auth-middleware.test.ts + federation-auth-header
 * (sequential unit coverage after #81). Orthogonal to client auth-middleware
 * concurrent-race (#217) which races Bearer/AS requireAuth/optionalAuth —
 * not X-Matrix origin/key/sig verify under Promise.all.
 *
 * Tip niches burned (#214–#218): filters+capabilities, power-levels/redact,
 * event-auth+state-resolution, appservice-api + auth-middleware. This slice
 * is the unsaturated federation-side auth sibling left after #217.
 *
 * Focus: require ok∥fail isolation; optional valid∥invalid∥anon; verify
 * mid-flight flip TOCTOU; multi-origin context isolation; destination /
 * malformed / method / body soft floods; signed-uri + signature bind
 * contracts; require∥optional cross-path coherency under Promise.all.
 *
 * Tests-only. Fixtures use example.com / matrix.example.com only.
 * No product inventing. Does not touch federation-auth.ts source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requireFederationAuth,
  optionalFederationAuth,
  parseAuthHeader,
  buildSignedRequest,
} from '../src/middleware/federation-auth';

const SERVER = 'matrix.example.com';
const REMOTE = 'remote.example.com';
const REMOTE2 = 'bridge.example.com';
const REMOTE3 = 'peer.example.org';
const NOW = 1_700_000_000_000;

vi.mock('../src/services/federation-keys', () => ({
  verifyRemoteSignature: vi.fn(),
}));

import { verifyRemoteSignature } from '../src/services/federation-keys';

const verifyMock = vi.mocked(verifyRemoteSignature);

type VerifyBarrier = {
  match?: (origin: string) => boolean;
  count: number;
};

type VerifyFlip = {
  after: number;
  next: boolean | 'throw';
};

function makeFedCtx(opts: {
  method?: string;
  url?: string;
  auth?: string | null;
  bodyText?: string;
  serverName?: string;
  db?: D1Database;
  cache?: KVNamespace;
}) {
  const url = opts.url ?? `https://${SERVER}/_matrix/federation/v1/send/1`;
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (opts.auth !== null && opts.auth !== undefined) {
    headers.Authorization = opts.auth;
  }
  const store = new Map<string, unknown>();
  let bodyConsumed = false;
  return {
    req: {
      method,
      url,
      header: (name: string) => {
        if (name.toLowerCase() === 'authorization') return headers.Authorization;
        return undefined;
      },
      async text() {
        bodyConsumed = true;
        return opts.bodyText ?? '';
      },
      _bodyConsumed: () => bodyConsumed,
    },
    env: {
      SERVER_NAME: opts.serverName ?? SERVER,
      DB: opts.db ?? ({ id: 'db' } as unknown as D1Database),
      CACHE: opts.cache ?? ({ id: 'cache' } as unknown as KVNamespace),
    },
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
    _store: store,
  } as any;
}

function xMatrix(opts: {
  origin?: string;
  destination?: string;
  key?: string;
  sig?: string;
  quoted?: boolean;
}): string {
  const origin = opts.origin ?? REMOTE;
  const key = opts.key ?? 'ed25519:1';
  const sig = opts.sig ?? 'abc';
  const quoted = opts.quoted !== false;
  const q = (v: string) => (quoted ? `"${v}"` : v);
  const parts = [`origin=${q(origin)}`, `key=${q(key)}`, `sig=${q(sig)}`];
  if (opts.destination !== undefined) {
    parts.splice(1, 0, `destination=${q(opts.destination)}`);
  }
  return `X-Matrix ${parts.join(',')}`;
}

type VerifyCtl = {
  barrier?: VerifyBarrier;
  flip?: VerifyFlip;
  delayMs?: number;
  byOrigin?: Map<string, boolean | 'throw'>;
  defaultResult?: boolean | 'throw';
};

function installVerify(ctl: VerifyCtl = {}) {
  let callCount = 0;
  const waiters: Array<() => void> = [];
  const events: string[] = [];
  let barrier = ctl.barrier;

  verifyMock.mockImplementation(async (signed, origin) => {
    const myCall = ++callCount;
    events.push(`verify:${origin}`);
    const o = origin as string;

    if (ctl.delayMs && ctl.delayMs > 0) {
      await new Promise((r) => setTimeout(r, ctl.delayMs));
    }

    if (barrier && (!barrier.match || barrier.match(o))) {
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

    // Flip applies to the Nth verify invocation (by entry order), not live callCount.
    if (ctl.flip && myCall === ctl.flip.after) {
      events.push(`flip:${ctl.flip.next}`);
      if (ctl.flip.next === 'throw') throw new Error('verify-flip-throw');
      return ctl.flip.next;
    }

    const mapped = ctl.byOrigin?.get(o);
    const result = mapped ?? ctl.defaultResult ?? true;
    if (result === 'throw') throw new Error(`verify-throw:${o}`);
    return result;
  });

  return { events, getCallCount: () => callCount };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  verifyMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// requireFederationAuth: ok∥fail isolation under Promise.all
// ---------------------------------------------------------------------------

describe('race fed-auth require ok∥fail isolation after #217', () => {
  for (let i = 0; i < 16; i++) {
    it(`valid∥invalid signature pair flood-${i}`, async () => {
      const okOrigin = `ok${i}.example.com`;
      const badOrigin = `bad${i}.example.com`;
      installVerify({
        byOrigin: new Map([
          [okOrigin, true],
          [badOrigin, false],
        ]),
      });
      const okCtx = makeFedCtx({
        auth: xMatrix({ origin: okOrigin, destination: SERVER, sig: `ok${i}` }),
      });
      const badCtx = makeFedCtx({
        auth: xMatrix({ origin: badOrigin, destination: SERVER, sig: `bad${i}` }),
      });
      const okNext = vi.fn(async () => `ok-${i}`);
      const badNext = vi.fn();
      const [okRes, badRes] = await Promise.all([
        requireFederationAuth()(okCtx, okNext),
        requireFederationAuth()(badCtx, badNext),
      ]);
      expect(okRes).toBe(`ok-${i}`);
      expect(okCtx.get('federationOrigin')).toBe(okOrigin);
      expect(okNext).toHaveBeenCalledOnce();
      expect(badRes).toEqual({
        body: { errcode: 'M_UNAUTHORIZED', error: 'Invalid request signature' },
        status: 401,
      });
      expect(badNext).not.toHaveBeenCalled();
      expect(badCtx.get('federationOrigin')).toBeUndefined();
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`valid∥verify-throw pair flood-${i}`, async () => {
      const okOrigin = `live${i}.example.com`;
      const boomOrigin = `boom${i}.example.com`;
      installVerify({
        byOrigin: new Map([
          [okOrigin, true],
          [boomOrigin, 'throw'],
        ]),
      });
      const okCtx = makeFedCtx({
        auth: xMatrix({ origin: okOrigin, destination: SERVER }),
      });
      const boomCtx = makeFedCtx({
        auth: xMatrix({ origin: boomOrigin, destination: SERVER }),
      });
      const [okRes, boomRes] = await Promise.all([
        requireFederationAuth()(okCtx, vi.fn(async () => 'live')),
        requireFederationAuth()(boomCtx, vi.fn()),
      ]);
      expect(okRes).toBe('live');
      expect(okCtx.get('federationOrigin')).toBe(okOrigin);
      expect(boomRes).toEqual({
        body: { errcode: 'M_UNAUTHORIZED', error: 'Failed to verify request signature' },
        status: 401,
      });
      expect(boomCtx.get('federationOrigin')).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-origin context isolation under concurrent require
// ---------------------------------------------------------------------------

describe('race fed-auth multi-origin context isolation after #217', () => {
  for (let i = 0; i < 14; i++) {
    it(`N distinct origins isolate federationOrigin flood-${i}`, async () => {
      const n = 4;
      const origins = Array.from({ length: n }, (_, j) => `o${i}_${j}.example.com`);
      installVerify({ defaultResult: true });
      const ctxs = origins.map((o) =>
        makeFedCtx({
          auth: xMatrix({ origin: o, destination: SERVER, sig: `s-${o}` }),
          url: `https://${SERVER}/_matrix/federation/v1/send/${i}_${o}`,
        })
      );
      const nexts = origins.map((o) => vi.fn(async () => o));
      const results = await Promise.all(
        ctxs.map((ctx, j) => requireFederationAuth()(ctx, nexts[j]))
      );
      for (let j = 0; j < n; j++) {
        expect(results[j]).toBe(origins[j]);
        expect(ctxs[j].get('federationOrigin')).toBe(origins[j]);
        expect(nexts[j]).toHaveBeenCalledOnce();
      }
      expect(verifyMock).toHaveBeenCalledTimes(n);
      const seenOrigins = verifyMock.mock.calls.map((c) => c[1]);
      expect(new Set(seenOrigins).size).toBe(n);
    });
  }
});

// ---------------------------------------------------------------------------
// Verify barrier TOCTOU — mid-flight flip after N concurrent verifies
// ---------------------------------------------------------------------------

describe('race fed-auth verify mid-flight flip TOCTOU after #217', () => {
  for (let i = 0; i < 10; i++) {
    it(`dual require barrier then flip-false mid-flight flood-${i}`, async () => {
      const ctl = installVerify({
        barrier: { count: 2 },
        flip: { after: 2, next: false },
        defaultResult: true,
      });
      const a = makeFedCtx({
        auth: xMatrix({ origin: REMOTE, destination: SERVER, sig: `a${i}` }),
      });
      const b = makeFedCtx({
        auth: xMatrix({ origin: REMOTE2, destination: SERVER, sig: `b${i}` }),
      });
      // First two start together under barrier (both default true before flip fires on call 2)
      // Flip fires when callCount === 2, so second call gets false.
      const [ra, rb] = await Promise.all([
        requireFederationAuth()(a, vi.fn(async () => 'a')),
        requireFederationAuth()(b, vi.fn(async () => 'b')),
      ]);
      const outcomes = [ra, rb];
      const oks = outcomes.filter((r) => r === 'a' || r === 'b');
      const fails = outcomes.filter(
        (r) =>
          typeof r === 'object' &&
          r !== null &&
          (r as { status?: number }).status === 401
      );
      // One succeeds (first call default true), one fails after flip-false on 2nd
      expect(oks.length + fails.length).toBe(2);
      expect(oks.length).toBe(1);
      expect(fails.length).toBe(1);
      expect(ctl.getCallCount()).toBe(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`triple require barrier coherency flood-${i}`, async () => {
      installVerify({
        barrier: { count: 3 },
        defaultResult: true,
      });
      const origins = [REMOTE, REMOTE2, REMOTE3];
      const ctxs = origins.map((o) =>
        makeFedCtx({ auth: xMatrix({ origin: o, destination: SERVER }) })
      );
      const results = await Promise.all(
        ctxs.map((ctx, j) =>
          requireFederationAuth()(ctx, vi.fn(async () => `ok-${j}`))
        )
      );
      expect(results).toEqual(['ok-0', 'ok-1', 'ok-2']);
      for (let j = 0; j < 3; j++) {
        expect(ctxs[j].get('federationOrigin')).toBe(origins[j]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// optionalFederationAuth concurrent: valid∥invalid∥anon
// ---------------------------------------------------------------------------

describe('race fed-auth optional valid∥invalid∥anon after #217', () => {
  for (let i = 0; i < 14; i++) {
    it(`optional valid∥invalid∥missing triad flood-${i}`, async () => {
      const okOrigin = `optok${i}.example.com`;
      installVerify({
        byOrigin: new Map([
          [okOrigin, true],
          [REMOTE2, false],
        ]),
      });
      const okCtx = makeFedCtx({
        auth: xMatrix({ origin: okOrigin, destination: SERVER }),
      });
      const badCtx = makeFedCtx({
        auth: xMatrix({ origin: REMOTE2, destination: SERVER }),
      });
      const anonCtx = makeFedCtx({ auth: null });
      const [okRes, badRes, anonRes] = await Promise.all([
        optionalFederationAuth()(okCtx, vi.fn(async () => 'ok')),
        optionalFederationAuth()(badCtx, vi.fn()),
        optionalFederationAuth()(anonCtx, vi.fn(async () => 'anon')),
      ]);
      expect(okRes).toBe('ok');
      expect(okCtx.get('federationOrigin')).toBe(okOrigin);
      expect(badRes).toEqual({
        body: { errcode: 'M_UNAUTHORIZED', error: 'Invalid request signature' },
        status: 401,
      });
      expect(anonRes).toBe('anon');
      expect(anonCtx.get('federationOrigin')).toBeUndefined();
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`optional verify-throw degrades∥valid isolates flood-${i}`, async () => {
      const okOrigin = `keep${i}.example.com`;
      const boomOrigin = `drop${i}.example.com`;
      installVerify({
        byOrigin: new Map([
          [okOrigin, true],
          [boomOrigin, 'throw'],
        ]),
      });
      const okCtx = makeFedCtx({
        auth: xMatrix({ origin: okOrigin, destination: SERVER }),
      });
      const boomCtx = makeFedCtx({
        auth: xMatrix({ origin: boomOrigin, destination: SERVER }),
      });
      const [okRes, boomRes] = await Promise.all([
        optionalFederationAuth()(okCtx, vi.fn(async () => 'kept')),
        optionalFederationAuth()(boomCtx, vi.fn(async () => 'degraded')),
      ]);
      expect(okRes).toBe('kept');
      expect(okCtx.get('federationOrigin')).toBe(okOrigin);
      // optional: throw → proceed unauthenticated (unlike require)
      expect(boomRes).toBe('degraded');
      expect(boomCtx.get('federationOrigin')).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// require∥optional cross-path under Promise.all
// ---------------------------------------------------------------------------

describe('race fed-auth require∥optional cross-path after #217', () => {
  for (let i = 0; i < 12; i++) {
    it(`require-ok∥optional-anon isolation flood-${i}`, async () => {
      installVerify({ defaultResult: true });
      const reqCtx = makeFedCtx({
        auth: xMatrix({ origin: REMOTE, destination: SERVER, sig: `r${i}` }),
      });
      const optCtx = makeFedCtx({ auth: null });
      const [reqRes, optRes] = await Promise.all([
        requireFederationAuth()(reqCtx, vi.fn(async () => 'req')),
        optionalFederationAuth()(optCtx, vi.fn(async () => 'opt')),
      ]);
      expect(reqRes).toBe('req');
      expect(reqCtx.get('federationOrigin')).toBe(REMOTE);
      expect(optRes).toBe('opt');
      expect(optCtx.get('federationOrigin')).toBeUndefined();
      expect(verifyMock).toHaveBeenCalledTimes(1);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`require-fail∥optional-ok isolation flood-${i}`, async () => {
      installVerify({
        byOrigin: new Map([
          [REMOTE, false],
          [REMOTE2, true],
        ]),
      });
      const reqCtx = makeFedCtx({
        auth: xMatrix({ origin: REMOTE, destination: SERVER }),
      });
      const optCtx = makeFedCtx({
        auth: xMatrix({ origin: REMOTE2, destination: SERVER }),
      });
      const [reqRes, optRes] = await Promise.all([
        requireFederationAuth()(reqCtx, vi.fn()),
        optionalFederationAuth()(optCtx, vi.fn(async () => 'opt-ok')),
      ]);
      expect(reqRes).toMatchObject({ status: 401, body: { errcode: 'M_UNAUTHORIZED' } });
      expect(optRes).toBe('opt-ok');
      expect(optCtx.get('federationOrigin')).toBe(REMOTE2);
    });
  }
});

// ---------------------------------------------------------------------------
// Destination / missing / malformed soft floods under Promise.all
// ---------------------------------------------------------------------------

describe('race fed-auth destination + malformed soft floods after #217', () => {
  for (let i = 0; i < 12; i++) {
    it(`destination mismatch∥valid soft flood-${i}`, async () => {
      installVerify({ defaultResult: true });
      const bad = makeFedCtx({
        auth: xMatrix({
          origin: REMOTE,
          destination: `wrong${i}.example.com`,
          sig: `m${i}`,
        }),
      });
      const ok = makeFedCtx({
        auth: xMatrix({ origin: REMOTE2, destination: SERVER, sig: `g${i}` }),
      });
      const [badRes, okRes] = await Promise.all([
        requireFederationAuth()(bad, vi.fn()),
        requireFederationAuth()(ok, vi.fn(async () => 'ok')),
      ]);
      expect(badRes).toMatchObject({
        status: 401,
        body: { errcode: 'M_UNAUTHORIZED' },
      });
      expect((badRes as { body: { error: string } }).body.error).toContain('does not match');
      expect(okRes).toBe('ok');
      // mismatch short-circuits before verify
      expect(verifyMock).toHaveBeenCalledTimes(1);
      expect(verifyMock.mock.calls[0][1]).toBe(REMOTE2);
    });
  }

  for (let i = 0; i < 14; i++) {
    it(`missing∥malformed∥bearer soft flood-${i}`, async () => {
      installVerify({ defaultResult: true });
      const variants = [
        null,
        '',
        'Bearer tok',
        'Basic abc',
        'X-Matrix origin="only"',
        'not-auth',
        'X-Matrix ',
      ];
      const auth = variants[i % variants.length];
      const ctx = makeFedCtx({ auth: auth as string | null });
      const next = vi.fn();
      const res = await requireFederationAuth()(ctx, next);
      expect(res).toMatchObject({ status: 401, body: { errcode: 'M_UNAUTHORIZED' } });
      expect(next).not.toHaveBeenCalled();
      expect(verifyMock).not.toHaveBeenCalled();
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`parallel malformed require all-401 flood-${i}`, async () => {
      const auths = [
        null,
        'Bearer x',
        'X-Matrix origin="a"',
        xMatrix({ origin: REMOTE, destination: 'other.example.com' }),
      ];
      const results = await Promise.all(
        auths.map((auth) =>
          requireFederationAuth()(makeFedCtx({ auth: auth as string | null }), vi.fn())
        )
      );
      for (const r of results) {
        expect(r).toMatchObject({ status: 401, body: { errcode: 'M_UNAUTHORIZED' } });
      }
      expect(verifyMock).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Body buffer isolation under concurrent POST/PUT
// ---------------------------------------------------------------------------

describe('race fed-auth POST/PUT body buffer isolation after #217', () => {
  for (let i = 0; i < 12; i++) {
    it(`dual POST distinct bodies no crosstalk flood-${i}`, async () => {
      installVerify({ defaultResult: true });
      const bodyA = { pdus: [{ type: 'm.room.message', i, side: 'a' }] };
      const bodyB = { edus: [{ edu_type: 'm.presence', i, side: 'b' }] };
      const a = makeFedCtx({
        auth: xMatrix({ origin: REMOTE, destination: SERVER, sig: `pa${i}` }),
        method: 'POST',
        bodyText: JSON.stringify(bodyA),
      });
      const b = makeFedCtx({
        auth: xMatrix({ origin: REMOTE2, destination: SERVER, sig: `pb${i}` }),
        method: 'PUT',
        bodyText: JSON.stringify(bodyB),
      });
      await Promise.all([
        requireFederationAuth()(a, vi.fn(async () => 'a')),
        requireFederationAuth()(b, vi.fn(async () => 'b')),
      ]);
      expect(a.get('federationBody')).toEqual(bodyA);
      expect(b.get('federationBody')).toEqual(bodyB);
      expect(a.get('federationBodyRaw')).toBe(JSON.stringify(bodyA));
      expect(b.get('federationBodyRaw')).toBe(JSON.stringify(bodyB));
      const contents = verifyMock.mock.calls.map((c) => (c[0] as { content?: unknown }).content);
      expect(contents).toContainEqual(bodyA);
      expect(contents).toContainEqual(bodyB);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`POST invalid-json∥valid isolation flood-${i}`, async () => {
      installVerify({ defaultResult: true });
      const good = { ok: i };
      const bad = makeFedCtx({
        auth: xMatrix({ origin: REMOTE, destination: SERVER }),
        method: 'POST',
        bodyText: `{broken-${i}`,
      });
      const ok = makeFedCtx({
        auth: xMatrix({ origin: REMOTE2, destination: SERVER }),
        method: 'POST',
        bodyText: JSON.stringify(good),
      });
      await Promise.all([
        requireFederationAuth()(bad, vi.fn(async () => 'bad')),
        requireFederationAuth()(ok, vi.fn(async () => 'ok')),
      ]);
      expect(bad.get('federationBody')).toBeUndefined();
      expect(ok.get('federationBody')).toEqual(good);
      const badCall = verifyMock.mock.calls.find((c) => c[1] === REMOTE)!;
      const okCall = verifyMock.mock.calls.find((c) => c[1] === REMOTE2)!;
      expect(badCall[0]).not.toHaveProperty('content');
      expect(okCall[0]).toMatchObject({ content: good });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`GET does not consume body under parallel flood-${i}`, async () => {
      installVerify({ defaultResult: true });
      const ctxs = [0, 1, 2].map((j) =>
        makeFedCtx({
          auth: xMatrix({
            origin: `g${i}_${j}.example.com`,
            destination: SERVER,
          }),
          method: 'GET',
          bodyText: `{"should":"not-read-${j}"}`,
        })
      );
      await Promise.all(
        ctxs.map((ctx) => requireFederationAuth()(ctx, vi.fn(async () => 'g')))
      );
      for (const ctx of ctxs) {
        expect(ctx.req._bodyConsumed()).toBe(false);
        expect(ctx.get('federationBody')).toBeUndefined();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Signed URI + signature bind contracts under parallel
// ---------------------------------------------------------------------------

describe('race fed-auth signed-uri + signature bind after #217', () => {
  for (let i = 0; i < 12; i++) {
    it(`query-string uri bind under parallel flood-${i}`, async () => {
      installVerify({ defaultResult: true });
      const paths = [
        `/_matrix/federation/v1/query/directory?room_alias=%23a${i}%3As`,
        `/_matrix/federation/v1/query/profile?user_id=%40u${i}%3As`,
        `/_matrix/federation/v1/make_join/%21r${i}%3As/%40u%3As?ver=10`,
      ];
      const ctxs = paths.map((path, j) =>
        makeFedCtx({
          auth: xMatrix({
            origin: `u${i}_${j}.example.com`,
            destination: SERVER,
            key: `ed25519:k${j}`,
            sig: `sig${i}_${j}`,
          }),
          url: `https://${SERVER}${path}`,
        })
      );
      await Promise.all(
        ctxs.map((ctx) => requireFederationAuth()(ctx, vi.fn(async () => 'u')))
      );
      for (let j = 0; j < paths.length; j++) {
        const call = verifyMock.mock.calls.find(
          (c) => c[1] === `u${i}_${j}.example.com`
        )!;
        expect(call[0]).toMatchObject({
          uri: paths[j],
          method: 'GET',
          destination: SERVER,
          signatures: {
            [`u${i}_${j}.example.com`]: { [`ed25519:k${j}`]: `sig${i}_${j}` },
          },
        });
        expect(call[2]).toBe(`ed25519:k${j}`);
        expect(call[3]).toBe(ctxs[j].env.DB);
        expect(call[4]).toBe(ctxs[j].env.CACHE);
      }
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`unquoted∥quoted params parallel flood-${i}`, async () => {
      installVerify({ defaultResult: true });
      const quoted = makeFedCtx({
        auth: xMatrix({
          origin: REMOTE,
          destination: SERVER,
          key: 'ed25519:q',
          sig: `q${i}`,
          quoted: true,
        }),
      });
      const unquoted = makeFedCtx({
        auth: xMatrix({
          origin: REMOTE2,
          destination: SERVER,
          key: 'ed25519:u',
          sig: `u${i}`,
          quoted: false,
        }),
      });
      await Promise.all([
        requireFederationAuth()(quoted, vi.fn(async () => 'q')),
        requireFederationAuth()(unquoted, vi.fn(async () => 'u')),
      ]);
      expect(quoted.get('federationOrigin')).toBe(REMOTE);
      expect(unquoted.get('federationOrigin')).toBe(REMOTE2);
      expect(verifyMock.mock.calls.map((c) => c[2]).sort()).toEqual([
        'ed25519:q',
        'ed25519:u',
      ]);
    });
  }
});

// ---------------------------------------------------------------------------
// Method soft matrix under Promise.all
// ---------------------------------------------------------------------------

describe('race fed-auth method soft matrix after #217', () => {
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'];

  for (let i = 0; i < methods.length; i++) {
    it(`method ${methods[i]} concurrent soft flood-${i}`, async () => {
      installVerify({ defaultResult: true });
      const method = methods[i];
      const body =
        method === 'POST' || method === 'PUT'
          ? JSON.stringify({ method, i })
          : undefined;
      const ctxs = [0, 1, 2].map((j) =>
        makeFedCtx({
          auth: xMatrix({
            origin: `m${i}_${j}.example.com`,
            destination: SERVER,
          }),
          method,
          bodyText: body,
        })
      );
      const results = await Promise.all(
        ctxs.map((ctx) => requireFederationAuth()(ctx, vi.fn(async () => method)))
      );
      expect(results.every((r) => r === method)).toBe(true);
      for (const call of verifyMock.mock.calls) {
        expect(call[0]).toMatchObject({ method });
        if (method === 'POST' || method === 'PUT') {
          expect(call[0]).toMatchObject({ content: { method, i } });
        } else {
          expect(call[0]).not.toHaveProperty('content');
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// optional Bearer / non-X-Matrix soft under race (degrades to anon)
// ---------------------------------------------------------------------------

describe('race fed-auth optional non-X-Matrix soft floods after #217', () => {
  for (let i = 0; i < 12; i++) {
    it(`optional Bearer∥X-Matrix-ok∥missing flood-${i}`, async () => {
      installVerify({ defaultResult: true });
      const bearer = makeFedCtx({ auth: `Bearer tok_${i}` });
      const ok = makeFedCtx({
        auth: xMatrix({ origin: REMOTE, destination: SERVER }),
      });
      const missing = makeFedCtx({ auth: null });
      const [bRes, oRes, mRes] = await Promise.all([
        optionalFederationAuth()(bearer, vi.fn(async () => 'bearer')),
        optionalFederationAuth()(ok, vi.fn(async () => 'ok')),
        optionalFederationAuth()(missing, vi.fn(async () => 'miss')),
      ]);
      expect(bRes).toBe('bearer');
      expect(bearer.get('federationOrigin')).toBeUndefined();
      expect(oRes).toBe('ok');
      expect(ok.get('federationOrigin')).toBe(REMOTE);
      expect(mRes).toBe('miss');
      expect(verifyMock).toHaveBeenCalledTimes(1);
    });
  }
});

// ---------------------------------------------------------------------------
// omit destination parallel (skip gate) + SERVER_NAME bind
// ---------------------------------------------------------------------------

describe('race fed-auth omitted-destination SERVER_NAME bind after #217', () => {
  for (let i = 0; i < 10; i++) {
    it(`no-dest∥with-dest parallel flood-${i}`, async () => {
      installVerify({ defaultResult: true });
      const noDest = makeFedCtx({
        auth: xMatrix({ origin: REMOTE, sig: `nd${i}` }),
        serverName: SERVER,
      });
      const withDest = makeFedCtx({
        auth: xMatrix({ origin: REMOTE2, destination: SERVER, sig: `wd${i}` }),
      });
      await Promise.all([
        requireFederationAuth()(noDest, vi.fn(async () => 'nd')),
        requireFederationAuth()(withDest, vi.fn(async () => 'wd')),
      ]);
      expect(noDest.get('federationOrigin')).toBe(REMOTE);
      expect(withDest.get('federationOrigin')).toBe(REMOTE2);
      for (const call of verifyMock.mock.calls) {
        expect(call[0]).toMatchObject({ destination: SERVER });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// parseAuthHeader / buildSignedRequest soft contracts (exported helpers)
// ---------------------------------------------------------------------------

describe('race fed-auth parseAuthHeader soft floods after #217', () => {
  for (let i = 0; i < 16; i++) {
    it(`quoted parse round-trip flood-${i}`, () => {
      const origin = `p${i}.example.com`;
      const key = `ed25519:${i}`;
      const sig = `sig_${i}`;
      const header = xMatrix({ origin, destination: SERVER, key, sig, quoted: true });
      const parsed = parseAuthHeader(header);
      expect(parsed).toEqual({
        origin,
        destination: SERVER,
        key,
        sig,
      });
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`unquoted parse round-trip flood-${i}`, () => {
      const origin = `u${i}.example.com`;
      const header = xMatrix({
        origin,
        destination: SERVER,
        key: `ed25519:u${i}`,
        sig: `usig${i}`,
        quoted: false,
      });
      expect(parseAuthHeader(header)).toMatchObject({
        origin,
        destination: SERVER,
        key: `ed25519:u${i}`,
        sig: `usig${i}`,
      });
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`reject non-X-Matrix soft flood-${i}`, () => {
      const junk = [
        '',
        'Bearer x',
        'Basic y',
        'X-Matrix',
        'x-matrix origin="a",key="b",sig="c"',
        'X-Matrix origin="only"',
      ];
      expect(parseAuthHeader(junk[i % junk.length])).toBeNull();
    });
  }
});

describe('race fed-auth buildSignedRequest soft floods after #217', () => {
  for (let i = 0; i < 14; i++) {
    it(`content omit∥attach coherency flood-${i}`, () => {
      const base = buildSignedRequest('GET', `/path/${i}`, REMOTE, SERVER);
      expect(base).toEqual({
        method: 'GET',
        uri: `/path/${i}`,
        origin: REMOTE,
        destination: SERVER,
      });
      const withContent = buildSignedRequest(
        'PUT',
        `/path/${i}`,
        REMOTE,
        SERVER,
        { i }
      );
      expect(withContent).toEqual({
        method: 'PUT',
        uri: `/path/${i}`,
        origin: REMOTE,
        destination: SERVER,
        content: { i },
      });
      const withNull = buildSignedRequest('POST', '/p', REMOTE, SERVER, null);
      expect(withNull).not.toHaveProperty('content');
      const withUndef = buildSignedRequest('POST', '/p', REMOTE, SERVER, undefined);
      expect(withUndef).not.toHaveProperty('content');
    });
  }
});

// ---------------------------------------------------------------------------
// Errcode contracts under parallel require
// ---------------------------------------------------------------------------

describe('race fed-auth errcode contracts under parallel after #217', () => {
  for (let i = 0; i < 12; i++) {
    it(`missing/malformed/dest/bad-sig/throw errcodes flood-${i}`, async () => {
      installVerify({
        byOrigin: new Map([
          ['badsig.example.com', false],
          ['boom.example.com', 'throw'],
        ]),
      });
      const cases = await Promise.all([
        requireFederationAuth()(makeFedCtx({ auth: null }), vi.fn()),
        requireFederationAuth()(makeFedCtx({ auth: 'Bearer x' }), vi.fn()),
        requireFederationAuth()(
          makeFedCtx({
            auth: xMatrix({ origin: REMOTE, destination: 'nope.example.com' }),
          }),
          vi.fn()
        ),
        requireFederationAuth()(
          makeFedCtx({
            auth: xMatrix({ origin: 'badsig.example.com', destination: SERVER }),
          }),
          vi.fn()
        ),
        requireFederationAuth()(
          makeFedCtx({
            auth: xMatrix({ origin: 'boom.example.com', destination: SERVER }),
          }),
          vi.fn()
        ),
      ]);
      for (const r of cases) {
        expect(r).toMatchObject({
          status: 401,
          body: { errcode: 'M_UNAUTHORIZED' },
        });
      }
      const errors = cases.map(
        (r) => (r as { body: { error: string } }).body.error
      );
      expect(errors[0]).toBe('Missing Authorization header');
      expect(errors[1]).toContain('Invalid Authorization header format');
      expect(errors[2]).toContain('does not match');
      expect(errors[3]).toBe('Invalid request signature');
      expect(errors[4]).toBe('Failed to verify request signature');
    });
  }
});

// ---------------------------------------------------------------------------
// Lifecycle chains: require then optional on fresh contexts
// ---------------------------------------------------------------------------

describe('race fed-auth lifecycle chains after #217', () => {
  for (let i = 0; i < 10; i++) {
    it(`require-ok then optional-ok∥anon chain flood-${i}`, async () => {
      installVerify({ defaultResult: true });
      const reqCtx = makeFedCtx({
        auth: xMatrix({ origin: REMOTE, destination: SERVER, sig: `lc${i}` }),
      });
      await expect(
        requireFederationAuth()(reqCtx, vi.fn(async () => 'r'))
      ).resolves.toBe('r');
      expect(reqCtx.get('federationOrigin')).toBe(REMOTE);

      const optOk = makeFedCtx({
        auth: xMatrix({ origin: REMOTE2, destination: SERVER }),
      });
      const optAnon = makeFedCtx({ auth: null });
      const [a, b] = await Promise.all([
        optionalFederationAuth()(optOk, vi.fn(async () => 'oo')),
        optionalFederationAuth()(optAnon, vi.fn(async () => 'oa')),
      ]);
      expect(a).toBe('oo');
      expect(b).toBe('oa');
      expect(optOk.get('federationOrigin')).toBe(REMOTE2);
      expect(optAnon.get('federationOrigin')).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// Delay soft — overlapping verify latency under fake timers
// ---------------------------------------------------------------------------

describe('race fed-auth delayed verify soft after #217', () => {
  for (let i = 0; i < 8; i++) {
    it(`dual delayed verify still isolates flood-${i}`, async () => {
      installVerify({ defaultResult: true, delayMs: 5 + i });
      const a = makeFedCtx({
        auth: xMatrix({ origin: REMOTE, destination: SERVER, sig: `d${i}a` }),
      });
      const b = makeFedCtx({
        auth: xMatrix({ origin: REMOTE2, destination: SERVER, sig: `d${i}b` }),
      });
      const pending = Promise.all([
        requireFederationAuth()(a, vi.fn(async () => 'a')),
        requireFederationAuth()(b, vi.fn(async () => 'b')),
      ]);
      await vi.advanceTimersByTimeAsync(50);
      const [ra, rb] = await pending;
      expect(ra).toBe('a');
      expect(rb).toBe('b');
      expect(a.get('federationOrigin')).toBe(REMOTE);
      expect(b.get('federationOrigin')).toBe(REMOTE2);
    });
  }
});

// ---------------------------------------------------------------------------
// Case-sensitive destination under concurrent soft
// ---------------------------------------------------------------------------

describe('race fed-auth case-sensitive destination soft after #217', () => {
  for (let i = 0; i < 8; i++) {
    it(`cased destination reject∥exact accept flood-${i}`, async () => {
      installVerify({ defaultResult: true });
      const cased = makeFedCtx({
        auth: xMatrix({
          origin: REMOTE,
          destination: 'Matrix.Example.Com',
          sig: `c${i}`,
        }),
        serverName: 'matrix.example.com',
      });
      const exact = makeFedCtx({
        auth: xMatrix({
          origin: REMOTE2,
          destination: 'matrix.example.com',
          sig: `e${i}`,
        }),
        serverName: 'matrix.example.com',
      });
      const [cRes, eRes] = await Promise.all([
        requireFederationAuth()(cased, vi.fn()),
        requireFederationAuth()(exact, vi.fn(async () => 'exact')),
      ]);
      expect(cRes).toMatchObject({ status: 401 });
      expect(eRes).toBe('exact');
      expect(verifyMock).toHaveBeenCalledTimes(1);
    });
  }
});
