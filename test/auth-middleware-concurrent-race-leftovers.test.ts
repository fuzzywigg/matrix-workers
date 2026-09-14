/**
 * TOKENMAXX HEAVY leftovers after #214 / #217 — auth-middleware *concurrent race*
 * + residual failure soft edges (first concurrent-race pass #217).
 *
 * Complements auth-middleware.test.ts and auth-middleware-failure-leftovers
 * (#147 extract/requireAuth/optionalAuth). Prior leftovers only race two
 * user tokens once — unsaturated: AS namespace allow/deny under Promise.all,
 * Bearer-over-query precedence under requireAuth, format/foreign/forbidden
 * soft floods, optionalAuth AS-non-impersonation isolation, sender fallback
 * coherency, throwOnAs → M_UNKNOWN_TOKEN under race.
 *
 * Residual deepen after #232: throwOnToken under race; empty/whitespace
 * Bearer extract; allowed localpart charset (=/_/+/.); multi-AS isolation;
 * SERVER_NAME override; optionalAuth query-token; empty Authorization;
 * AS sender∥user_id parallel; accessToken field bind under race.
 *
 * Tests-only. Fixtures use example.com / matrix.example.com only.
 * No product inventing. Does not touch auth.ts source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  validateAccessToken,
  requireAuth,
  optionalAuth,
  extractAccessToken,
} from '../src/middleware/auth';
import { hashToken } from '../src/utils/crypto';

const SERVER = 'matrix.example.com';

type TokenRow = { user_id: string; device_id: string | null };
type AsRow = {
  id: string;
  url: string;
  as_token: string;
  hs_token: string;
  sender_localpart: string;
  rate_limited: number;
  protocols: string | null;
  namespaces: string;
};

function createAuthDb(
  opts: {
    tokens?: Map<string, TokenRow>;
    appservices?: Map<string, AsRow>;
    throwOnAs?: boolean;
    throwOnToken?: boolean;
  } = {}
) {
  const tokens = opts.tokens ?? new Map<string, TokenRow>();
  const appservices = opts.appservices ?? new Map<string, AsRow>();
  return {
    tokens,
    appservices,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM access_tokens') && sql.includes('token_hash')) {
                if (opts.throwOnToken) throw new Error('token lookup failed');
                const hash = args[0] as string;
                return (tokens.get(hash) as T) ?? null;
              }
              if (sql.includes('FROM appservice_registrations') && sql.includes('as_token')) {
                if (opts.throwOnAs) throw new Error('as lookup failed');
                const token = args[0] as string;
                return (appservices.get(token) as T) ?? null;
              }
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database & {
    tokens: Map<string, TokenRow>;
    appservices: Map<string, AsRow>;
  };
}

function asRow(
  partial: Partial<AsRow> & Pick<AsRow, 'as_token' | 'sender_localpart'>
): AsRow {
  return {
    id: partial.id ?? 'as1',
    url: partial.url ?? 'https://as.example.com',
    as_token: partial.as_token,
    hs_token: partial.hs_token ?? 'hs',
    sender_localpart: partial.sender_localpart,
    rate_limited: partial.rate_limited ?? 0,
    protocols: partial.protocols ?? null,
    namespaces:
      partial.namespaces ??
      JSON.stringify({
        users: [{ exclusive: true, regex: '@bot_.*:matrix\\.example\\.com' }],
        rooms: [],
        aliases: [],
      }),
  };
}

function makeAuthCtx(opts: {
  url?: string;
  headers?: Record<string, string>;
  db: D1Database;
  serverName?: string;
}) {
  const url = opts.url ?? `https://${SERVER}/_matrix/client/v3/sync`;
  const headers = new Headers(opts.headers ?? {});
  const raw = new Request(url, { headers });
  const store = new Map<string, unknown>();
  return {
    req: {
      raw,
      url,
      header: (name: string) => headers.get(name),
    },
    env: { DB: opts.db, SERVER_NAME: opts.serverName ?? SERVER },
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
    _store: store,
  } as any;
}

async function jsonBody(
  res: Response
): Promise<{ errcode: string; error: string; status: number }> {
  const body = (await res.json()) as { errcode: string; error: string };
  return { ...body, status: res.status };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// extractAccessToken precedence soft floods (sync, residual chars)
// ---------------------------------------------------------------------------

describe('race auth extractAccessToken residual soft floods after #214', () => {
  for (let i = 0; i < 16; i++) {
    it(`Bearer wins over query flood-${i}`, () => {
      const req = new Request(
        `https://${SERVER}/sync?access_token=query_${i}`,
        { headers: { Authorization: `Bearer header_${i}` } }
      );
      expect(extractAccessToken(req)).toBe(`header_${i}`);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`scheme fallthrough soft flood-${i}`, () => {
      const schemes = ['Basic', 'Digest', 'Token', 'HOBA', 'Negotiate', 'AWS4'];
      const scheme = schemes[i % schemes.length];
      const req = new Request(`https://${SERVER}/sync?access_token=q${i}`, {
        headers: { Authorization: `${scheme} abc${i}` },
      });
      expect(extractAccessToken(req)).toBe(`q${i}`);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`case-insensitive Bearer flood-${i}`, () => {
      const variants = ['Bearer', 'bearer', 'BEARER', 'BeArEr'];
      const v = variants[i % variants.length];
      const req = new Request(`https://${SERVER}/sync`, {
        headers: { Authorization: `${v} CaseTok${i}` },
      });
      expect(extractAccessToken(req)).toBe(`CaseTok${i}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Concurrent user-token isolation soft floods
// ---------------------------------------------------------------------------

describe('race auth requireAuth user-token isolation after #214', () => {
  for (let i = 0; i < 16; i++) {
    it(`N distinct tokens isolate contexts flood-${i}`, async () => {
      const n = 4;
      const tokens = Array.from({ length: n }, (_, j) => `syt_u_${i}_${j}`);
      const hashes = await Promise.all(tokens.map((t) => hashToken(t)));
      const db = createAuthDb({
        tokens: new Map(
          hashes.map((h, j) => [
            h,
            { user_id: `@u${i}_${j}:${SERVER}`, device_id: `D${i}_${j}` },
          ])
        ),
      });
      const ctxs = tokens.map((t) =>
        makeAuthCtx({ db, headers: { Authorization: `Bearer ${t}` } })
      );
      await Promise.all(
        ctxs.map((ctx) => requireAuth()(ctx, vi.fn(async () => undefined)))
      );
      for (let j = 0; j < n; j++) {
        expect(ctxs[j].get('userId')).toBe(`@u${i}_${j}:${SERVER}`);
        expect(ctxs[j].get('deviceId')).toBe(`D${i}_${j}`);
        expect(ctxs[j].get('accessToken')).toBe(tokens[j]);
        expect(ctxs[j].get('auth')).toEqual({
          userId: `@u${i}_${j}:${SERVER}`,
          deviceId: `D${i}_${j}`,
          accessToken: tokens[j],
        });
      }
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`valid∥missing∥unknown parallel flood-${i}`, async () => {
      const token = `syt_ok_${i}`;
      const hash = await hashToken(token);
      const db = createAuthDb({
        tokens: new Map([[hash, { user_id: `@ok${i}:${SERVER}`, device_id: 'D' }]]),
      });
      const ok = makeAuthCtx({ db, headers: { Authorization: `Bearer ${token}` } });
      const missing = makeAuthCtx({ db });
      const unknown = makeAuthCtx({
        db,
        headers: { Authorization: `Bearer garbage_${i}` },
      });
      const nextOk = vi.fn(async () => 'ok');
      const nextMiss = vi.fn();
      const nextUnk = vi.fn();
      const [a, b, c] = await Promise.all([
        requireAuth()(ok, nextOk),
        requireAuth()(missing, nextMiss),
        requireAuth()(unknown, nextUnk),
      ]);
      expect(a).toBe('ok');
      expect(ok.get('userId')).toBe(`@ok${i}:${SERVER}`);
      expect(await jsonBody(b as Response)).toMatchObject({
        errcode: 'M_MISSING_TOKEN',
        status: 401,
      });
      expect(await jsonBody(c as Response)).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
      expect(nextMiss).not.toHaveBeenCalled();
      expect(nextUnk).not.toHaveBeenCalled();
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`query-only∥Bearer parallel flood-${i}`, async () => {
      const tq = `syt_q_${i}`;
      const tb = `syt_b_${i}`;
      const [hq, hb] = await Promise.all([hashToken(tq), hashToken(tb)]);
      const db = createAuthDb({
        tokens: new Map([
          [hq, { user_id: `@q${i}:${SERVER}`, device_id: 'DQ' }],
          [hb, { user_id: `@b${i}:${SERVER}`, device_id: 'DB' }],
        ]),
      });
      const ctxQ = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=${tq}`,
      });
      const ctxB = makeAuthCtx({
        db,
        headers: { Authorization: `Bearer ${tb}` },
      });
      // Bearer wins when both present — query ignored
      const ctxBoth = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=${tq}`,
        headers: { Authorization: `Bearer ${tb}` },
      });
      await Promise.all([
        requireAuth()(ctxQ, vi.fn(async () => undefined)),
        requireAuth()(ctxB, vi.fn(async () => undefined)),
        requireAuth()(ctxBoth, vi.fn(async () => undefined)),
      ]);
      expect(ctxQ.get('userId')).toBe(`@q${i}:${SERVER}`);
      expect(ctxB.get('userId')).toBe(`@b${i}:${SERVER}`);
      expect(ctxBoth.get('userId')).toBe(`@b${i}:${SERVER}`);
    });
  }
});

// ---------------------------------------------------------------------------
// AS namespace allow/deny under Promise.all
// ---------------------------------------------------------------------------

describe('race auth AS namespace allow∥deny after #214', () => {
  for (let i = 0; i < 16; i++) {
    it(`allow∥deny parallel flood-${i}`, async () => {
      const namespaces = JSON.stringify({
        users: [
          {
            exclusive: true,
            regex: `@bridge_.*:${SERVER.replace(/\./g, '\\.')}`,
          },
        ],
      });
      const db = createAuthDb({
        appservices: new Map([
          [
            'as_tok',
            asRow({
              as_token: 'as_tok',
              sender_localpart: 'bridge',
              namespaces,
            }),
          ],
        ]),
      });
      const allow = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@bridge_${i}:${SERVER}`)}`,
        headers: { Authorization: 'Bearer as_tok' },
      });
      const deny = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@other_${i}:${SERVER}`)}`,
        headers: { Authorization: 'Bearer as_tok' },
      });
      const next = vi.fn(async () => 'yes');
      const [a, b] = await Promise.all([
        requireAuth()(allow, next),
        requireAuth()(deny, vi.fn()),
      ]);
      expect(a).toBe('yes');
      expect(allow.get('userId')).toBe(`@bridge_${i}:${SERVER}`);
      expect(await jsonBody(b as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`multi-namespace OR allow flood-${i}`, async () => {
      const namespaces = JSON.stringify({
        users: [
          { exclusive: true, regex: `@alpha_.*:${SERVER.replace(/\./g, '\\.')}` },
          { exclusive: false, regex: `@beta_.*:${SERVER.replace(/\./g, '\\.')}` },
        ],
      });
      const db = createAuthDb({
        appservices: new Map([
          [
            'as_multi',
            asRow({
              as_token: 'as_multi',
              sender_localpart: 'multi',
              namespaces,
            }),
          ],
        ]),
      });
      const a = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@alpha_${i}:${SERVER}`)}`,
        headers: { Authorization: 'Bearer as_multi' },
      });
      const b = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@beta_${i}:${SERVER}`)}`,
        headers: { Authorization: 'Bearer as_multi' },
      });
      const c = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@gamma_${i}:${SERVER}`)}`,
        headers: { Authorization: 'Bearer as_multi' },
      });
      const [ra, rb, rc] = await Promise.all([
        requireAuth()(a, vi.fn(async () => 'a')),
        requireAuth()(b, vi.fn(async () => 'b')),
        requireAuth()(c, vi.fn()),
      ]);
      expect(ra).toBe('a');
      expect(rb).toBe('b');
      expect(await jsonBody(rc as Response)).toMatchObject({ errcode: 'M_FORBIDDEN' });
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`empty namespaces allow any local user flood-${i}`, async () => {
      const db = createAuthDb({
        appservices: new Map([
          [
            'as_open',
            asRow({
              as_token: 'as_open',
              sender_localpart: 'open',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });
      const ctx = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@anyone_${i}:${SERVER}`)}`,
        headers: { Authorization: 'Bearer as_open' },
      });
      await expect(
        requireAuth()(ctx, vi.fn(async () => 'open'))
      ).resolves.toBe('open');
      expect(ctx.get('userId')).toBe(`@anyone_${i}:${SERVER}`);
      expect(ctx.get('deviceId')).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// AS format / foreign / sender soft floods under race
// ---------------------------------------------------------------------------

describe('race auth AS format∥foreign∥sender after #214', () => {
  const badIds = [
    '@Bad',
    '@UPPER:matrix.example.com',
    '@bot😀:matrix.example.com',
    'not-an-mxid',
    '@:matrix.example.com',
    '@bot',
    '@bot:matrix.example.com:8448',
    '@@double:matrix.example.com',
  ];

  for (let i = 0; i < 16; i++) {
    it(`invalid format soft flood-${i}`, async () => {
      const bad = badIds[i % badIds.length];
      const db = createAuthDb({
        appservices: new Map([
          [
            'as_tok',
            asRow({
              as_token: 'as_tok',
              sender_localpart: 'bot',
              namespaces: JSON.stringify({ users: [] }),
            }),
          ],
        ]),
      });
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          requireAuth()(
            makeAuthCtx({
              db,
              url: `https://${SERVER}/sync?user_id=${encodeURIComponent(bad)}`,
              headers: { Authorization: 'Bearer as_tok' },
            }),
            vi.fn()
          )
        )
      );
      for (const res of results) {
        expect(await jsonBody(res as Response)).toMatchObject({
          errcode: 'M_FORBIDDEN',
          error: 'Invalid user_id format',
          status: 403,
        });
      }
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`foreign server soft flood-${i}`, async () => {
      const db = createAuthDb({
        appservices: new Map([
          [
            'as_tok',
            asRow({
              as_token: 'as_tok',
              sender_localpart: 'bot',
              namespaces: JSON.stringify({ users: [] }),
            }),
          ],
        ]),
      });
      const foreign = `@bot_${i}:other.example.com`;
      const [a, b] = await Promise.all([
        requireAuth()(
          makeAuthCtx({
            db,
            url: `https://${SERVER}/sync?user_id=${encodeURIComponent(foreign)}`,
            headers: { Authorization: 'Bearer as_tok' },
          }),
          vi.fn()
        ),
        requireAuth()(
          makeAuthCtx({
            db,
            url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@bot_${i}:${SERVER}`)}`,
            headers: { Authorization: 'Bearer as_tok' },
          }),
          vi.fn(async () => 'local')
        ),
      ]);
      expect(await jsonBody(a as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot impersonate users on other servers',
      });
      expect(b).toBe('local');
    });
  }

  for (let i = 0; i < 16; i++) {
    it(`sender_localpart fallback parallel flood-${i}`, async () => {
      const db = createAuthDb({
        appservices: new Map([
          [
            `as_s_${i}`,
            asRow({
              as_token: `as_s_${i}`,
              sender_localpart: `hook_${i}`,
              namespaces: JSON.stringify({ users: [] }),
            }),
          ],
        ]),
      });
      const ctxs = Array.from({ length: 3 }, () =>
        makeAuthCtx({
          db,
          headers: { Authorization: `Bearer as_s_${i}` },
        })
      );
      await Promise.all(
        ctxs.map((ctx) => requireAuth()(ctx, vi.fn(async () => undefined)))
      );
      for (const ctx of ctxs) {
        expect(ctx.get('userId')).toBe(`@hook_${i}:${SERVER}`);
        expect(ctx.get('deviceId')).toBeNull();
      }
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`allowed localpart charset flood-${i}`, async () => {
      // regex: /^@[a-z0-9._=/+-]+:[a-zA-Z0-9.-]+$/
      const locals = [
        `bot.dot_${i}`,
        `bot_under_${i}`,
        `bot=eq_${i}`,
        `bot/slash_${i}`,
        `bot+plus_${i}`,
        `bot-dash_${i}`,
      ];
      const local = locals[i % locals.length];
      const db = createAuthDb({
        appservices: new Map([
          [
            'as_tok',
            asRow({
              as_token: 'as_tok',
              sender_localpart: 'bot',
              namespaces: JSON.stringify({ users: [] }),
            }),
          ],
        ]),
      });
      const ctx = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@${local}:${SERVER}`)}`,
        headers: { Authorization: 'Bearer as_tok' },
      });
      await expect(
        requireAuth()(ctx, vi.fn(async () => 'ok'))
      ).resolves.toBe('ok');
      expect(ctx.get('userId')).toBe(`@${local}:${SERVER}`);
    });
  }
});

// ---------------------------------------------------------------------------
// throwOnAs / invalid regex / optionalAuth under race
// ---------------------------------------------------------------------------

describe('race auth throwOnAs∥invalid-regex∥optionalAuth after #214', () => {
  for (let i = 0; i < 16; i++) {
    it(`throwOnAs → M_UNKNOWN_TOKEN flood-${i}`, async () => {
      const db = createAuthDb({ throwOnAs: true });
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, j) =>
          requireAuth()(
            makeAuthCtx({
              db,
              headers: { Authorization: `Bearer as_maybe_${i}_${j}` },
            }),
            vi.fn()
          )
        )
      );
      for (const res of results) {
        expect(await jsonBody(res as Response)).toMatchObject({
          errcode: 'M_UNKNOWN_TOKEN',
          status: 401,
        });
      }
      expect(console.warn).toHaveBeenCalled();
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`invalid namespace regex → M_FORBIDDEN flood-${i}`, async () => {
      const db = createAuthDb({
        appservices: new Map([
          [
            'as_bad_re',
            asRow({
              as_token: 'as_bad_re',
              sender_localpart: 'bot',
              namespaces: JSON.stringify({
                users: [{ exclusive: true, regex: '[unterminated' }],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
        ]),
      });
      const [a, b] = await Promise.all([
        requireAuth()(
          makeAuthCtx({
            db,
            url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@bot_${i}:${SERVER}`)}`,
            headers: { Authorization: 'Bearer as_bad_re' },
          }),
          vi.fn()
        ),
        requireAuth()(
          makeAuthCtx({
            db,
            headers: { Authorization: 'Bearer as_bad_re' },
          }),
          vi.fn(async () => 'sender')
        ),
      ]);
      expect(await jsonBody(a as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'User not in application service namespace',
      });
      // no user_id → sender fallback, namespaces not checked
      expect(b).toBe('sender');
    });
  }

  for (let i = 0; i < 16; i++) {
    it(`optionalAuth never impersonates AS flood-${i}`, async () => {
      const db = createAuthDb({
        appservices: new Map([
          [
            `as_only_${i}`,
            asRow({
              as_token: `as_only_${i}`,
              sender_localpart: 'bridge',
              namespaces: JSON.stringify({ users: [] }),
            }),
          ],
        ]),
      });
      const ctxs = Array.from({ length: 3 }, () =>
        makeAuthCtx({
          db,
          url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@bridge_${i}:${SERVER}`)}`,
          headers: { Authorization: `Bearer as_only_${i}` },
        })
      );
      const results = await Promise.all(
        ctxs.map((ctx) => optionalAuth()(ctx, vi.fn(async () => 'opt')))
      );
      expect(results).toEqual(['opt', 'opt', 'opt']);
      for (const ctx of ctxs) {
        expect(ctx.get('userId')).toBeUndefined();
        expect(ctx.get('auth')).toBeUndefined();
      }
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`optionalAuth valid∥invalid parallel flood-${i}`, async () => {
      const token = `syt_opt_${i}`;
      const hash = await hashToken(token);
      const db = createAuthDb({
        tokens: new Map([
          [hash, { user_id: `@opt${i}:${SERVER}`, device_id: 'OD' }],
        ]),
      });
      const ok = makeAuthCtx({
        db,
        headers: { Authorization: `Bearer ${token}` },
      });
      const bad = makeAuthCtx({
        db,
        headers: { Authorization: `Bearer nope_${i}` },
      });
      const anon = makeAuthCtx({ db });
      await Promise.all([
        optionalAuth()(ok, vi.fn(async () => undefined)),
        optionalAuth()(bad, vi.fn(async () => undefined)),
        optionalAuth()(anon, vi.fn(async () => undefined)),
      ]);
      expect(ok.get('userId')).toBe(`@opt${i}:${SERVER}`);
      expect(ok.get('deviceId')).toBe('OD');
      expect(bad.get('userId')).toBeUndefined();
      expect(anon.get('userId')).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// validateAccessToken under parallel + user-vs-AS precedence
// ---------------------------------------------------------------------------

describe('race auth validateAccessToken∥user-vs-AS after #214', () => {
  for (let i = 0; i < 16; i++) {
    it(`parallel validateAccessToken hit∥miss flood-${i}`, async () => {
      const token = `syt_val_${i}`;
      const hash = await hashToken(token);
      const db = createAuthDb({
        tokens: new Map([
          [hash, { user_id: `@v${i}:${SERVER}`, device_id: null }],
        ]),
      });
      const [a, b, c] = await Promise.all([
        validateAccessToken(db, token),
        validateAccessToken(db, `nope_${i}`),
        validateAccessToken(db, token),
      ]);
      expect(a).toEqual({
        userId: `@v${i}:${SERVER}`,
        deviceId: null,
        accessToken: token,
      });
      expect(b).toBeNull();
      expect(c).toEqual(a);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`user token wins before AS fallback flood-${i}`, async () => {
      // Same string registered as both user token AND as_token — user path first
      const shared = `shared_tok_${i}`;
      const hash = await hashToken(shared);
      const db = createAuthDb({
        tokens: new Map([
          [hash, { user_id: `@user${i}:${SERVER}`, device_id: 'DU' }],
        ]),
        appservices: new Map([
          [
            shared,
            asRow({
              as_token: shared,
              sender_localpart: 'asbot',
              namespaces: JSON.stringify({ users: [] }),
            }),
          ],
        ]),
      });
      const ctx = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@asbot:${SERVER}`)}`,
        headers: { Authorization: `Bearer ${shared}` },
      });
      await requireAuth()(ctx, vi.fn(async () => undefined));
      // User path wins — AS user_id query ignored
      expect(ctx.get('userId')).toBe(`@user${i}:${SERVER}`);
      expect(ctx.get('deviceId')).toBe('DU');
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`null deviceId preserved under race flood-${i}`, async () => {
      const token = `syt_null_${i}`;
      const hash = await hashToken(token);
      const db = createAuthDb({
        tokens: new Map([
          [hash, { user_id: `@n${i}:${SERVER}`, device_id: null }],
        ]),
      });
      const ctxs = Array.from({ length: 3 }, () =>
        makeAuthCtx({ db, headers: { Authorization: `Bearer ${token}` } })
      );
      await Promise.all(
        ctxs.map((ctx) => requireAuth()(ctx, vi.fn(async () => undefined)))
      );
      for (const ctx of ctxs) {
        expect(ctx.get('deviceId')).toBeNull();
        expect(ctx.get('userId')).toBe(`@n${i}:${SERVER}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Errcode contract soft floods under concurrency
// ---------------------------------------------------------------------------

describe('race auth errcode contracts under parallel after #214', () => {
  for (let i = 0; i < 16; i++) {
    it(`M_MISSING_TOKEN contract flood-${i}`, async () => {
      const db = createAuthDb();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          requireAuth()(makeAuthCtx({ db }), vi.fn())
        )
      );
      for (const res of results) {
        const body = await jsonBody(res as Response);
        expect(body.status).toBe(401);
        expect(body.errcode).toBe('M_MISSING_TOKEN');
      }
    });
  }

  for (let i = 0; i < 16; i++) {
    it(`M_UNKNOWN_TOKEN contract flood-${i}`, async () => {
      const db = createAuthDb();
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, j) =>
          requireAuth()(
            makeAuthCtx({
              db,
              headers: { Authorization: `Bearer nope_${i}_${j}` },
            }),
            vi.fn()
          )
        )
      );
      for (const res of results) {
        expect(await jsonBody(res as Response)).toMatchObject({
          errcode: 'M_UNKNOWN_TOKEN',
          status: 401,
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #232 — throwOnToken isolation vs throwOnAs swallow
// ---------------------------------------------------------------------------

describe('race auth throwOnToken isolation after #232', () => {
  for (let i = 0; i < 12; i++) {
    it(`throwOnToken bubbles ∥ ok isolation flood-${i}`, async () => {
      const token = `syt_ok_${i}`;
      const hash = await hashToken(token);
      const throwDb = createAuthDb({ throwOnToken: true });
      const okDb = createAuthDb({
        tokens: new Map([[hash, { user_id: `@ok${i}:${SERVER}`, device_id: 'D' }]]),
      });
      const ok = makeAuthCtx({
        db: okDb,
        headers: { Authorization: `Bearer ${token}` },
      });
      const next = vi.fn(async () => 'ok');
      const [bad, good] = await Promise.allSettled([
        requireAuth()(makeAuthCtx({ db: throwDb, headers: { Authorization: `Bearer t${i}` } }), vi.fn()),
        requireAuth()(ok, next),
      ]);
      expect(bad.status).toBe('rejected');
      expect(good.status).toBe('fulfilled');
      expect(next).toHaveBeenCalledOnce();
      expect(ok.get('userId')).toBe(`@ok${i}:${SERVER}`);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`throwOnToken vs throwOnAs swallow isolation flood-${i}`, async () => {
      const asDb = createAuthDb({ throwOnAs: true });
      const tokDb = createAuthDb({ throwOnToken: true });
      const [asRes, tokRes] = await Promise.allSettled([
        requireAuth()(
          makeAuthCtx({ db: asDb, headers: { Authorization: `Bearer as_${i}` } }),
          vi.fn()
        ),
        requireAuth()(
          makeAuthCtx({ db: tokDb, headers: { Authorization: `Bearer tok_${i}` } }),
          vi.fn()
        ),
      ]);
      expect(asRes.status).toBe('fulfilled');
      expect(await jsonBody(asRes.value as Response)).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
      expect(tokRes.status).toBe('rejected');
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #232 — extractAccessToken whitespace / empty
// ---------------------------------------------------------------------------

describe('race auth extractAccessToken whitespace after #232', () => {
  for (let i = 0; i < 12; i++) {
    it(`Bearer extra whitespace still captures flood-${i}`, () => {
      const req = new Request(`https://${SERVER}/sync`, {
        headers: { Authorization: `Bearer    tok_ws_${i}` },
      });
      expect(extractAccessToken(req)).toBe(`tok_ws_${i}`);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`bare Bearer / empty header falls to query flood-${i}`, () => {
      const a = new Request(`https://${SERVER}/sync?access_token=q${i}`, {
        headers: { Authorization: 'Bearer' },
      });
      const b = new Request(`https://${SERVER}/sync?access_token=q${i}`, {
        headers: { Authorization: '' },
      });
      const c = new Request(`https://${SERVER}/sync?access_token=q${i}`, {
        headers: { Authorization: 'Bearer ' },
      });
      expect(extractAccessToken(a)).toBe(`q${i}`);
      expect(extractAccessToken(b)).toBe(`q${i}`);
      // "Bearer " + empty capture fails `.+` → query fallback
      expect(extractAccessToken(c)).toBe(`q${i}`);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`tab/newline Bearer whitespace flood-${i}`, () => {
      const req = new Request(`https://${SERVER}/sync`, {
        headers: { Authorization: `Bearer\ttabtok_${i}` },
      });
      expect(extractAccessToken(req)).toBe(`tabtok_${i}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #232 — multi-AS isolation + SERVER_NAME override
// ---------------------------------------------------------------------------

describe('race auth multi-AS + SERVER_NAME after #232', () => {
  for (let i = 0; i < 12; i++) {
    it(`two AS tokens isolate senders flood-${i}`, async () => {
      const db = createAuthDb({
        appservices: new Map([
          [
            `as_a_${i}`,
            asRow({
              id: 'a',
              as_token: `as_a_${i}`,
              sender_localpart: `alpha_${i}`,
              namespaces: JSON.stringify({ users: [] }),
            }),
          ],
          [
            `as_b_${i}`,
            asRow({
              id: 'b',
              as_token: `as_b_${i}`,
              sender_localpart: `beta_${i}`,
              namespaces: JSON.stringify({ users: [] }),
            }),
          ],
        ]),
      });
      const ctxA = makeAuthCtx({ db, headers: { Authorization: `Bearer as_a_${i}` } });
      const ctxB = makeAuthCtx({ db, headers: { Authorization: `Bearer as_b_${i}` } });
      await Promise.all([
        requireAuth()(ctxA, vi.fn(async () => undefined)),
        requireAuth()(ctxB, vi.fn(async () => undefined)),
      ]);
      expect(ctxA.get('userId')).toBe(`@alpha_${i}:${SERVER}`);
      expect(ctxB.get('userId')).toBe(`@beta_${i}:${SERVER}`);
      expect(ctxA.get('deviceId')).toBeNull();
      expect(ctxB.get('deviceId')).toBeNull();
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`SERVER_NAME override foreign vs local flood-${i}`, async () => {
      const db = createAuthDb({
        appservices: new Map([
          [
            'as_tok',
            asRow({
              as_token: 'as_tok',
              sender_localpart: 'bot',
              namespaces: JSON.stringify({ users: [] }),
            }),
          ],
        ]),
      });
      const other = 'other.example.com';
      const [foreign, local] = await Promise.all([
        requireAuth()(
          makeAuthCtx({
            db,
            serverName: other,
            url: `https://${other}/sync?user_id=${encodeURIComponent(`@bot_${i}:${SERVER}`)}`,
            headers: { Authorization: 'Bearer as_tok' },
          }),
          vi.fn()
        ),
        requireAuth()(
          makeAuthCtx({
            db,
            serverName: other,
            url: `https://${other}/sync?user_id=${encodeURIComponent(`@bot_${i}:${other}`)}`,
            headers: { Authorization: 'Bearer as_tok' },
          }),
          vi.fn(async () => 'ok')
        ),
      ]);
      expect(await jsonBody(foreign as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot impersonate users on other servers',
      });
      expect(local).toBe('ok');
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`AS sender fallback ∥ explicit user_id parallel flood-${i}`, async () => {
      const db = createAuthDb({
        appservices: new Map([
          [
            `as_p_${i}`,
            asRow({
              as_token: `as_p_${i}`,
              sender_localpart: `hook_${i}`,
              namespaces: JSON.stringify({
                users: [{ exclusive: true, regex: `@hook_.*:${SERVER.replace(/\./g, '\\.')}` }],
              }),
            }),
          ],
        ]),
      });
      const fallback = makeAuthCtx({
        db,
        headers: { Authorization: `Bearer as_p_${i}` },
      });
      const explicit = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@hook_user_${i}:${SERVER}`)}`,
        headers: { Authorization: `Bearer as_p_${i}` },
      });
      await Promise.all([
        requireAuth()(fallback, vi.fn(async () => undefined)),
        requireAuth()(explicit, vi.fn(async () => undefined)),
      ]);
      expect(fallback.get('userId')).toBe(`@hook_${i}:${SERVER}`);
      expect(explicit.get('userId')).toBe(`@hook_user_${i}:${SERVER}`);
      expect(fallback.get('accessToken')).toBe(`as_p_${i}`);
      expect(explicit.get('accessToken')).toBe(`as_p_${i}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #232 — optionalAuth query-token + empty Authorization
// ---------------------------------------------------------------------------

describe('race auth optionalAuth query + empty Authorization after #232', () => {
  for (let i = 0; i < 12; i++) {
    it(`optionalAuth query-only token flood-${i}`, async () => {
      const token = `syt_q_${i}`;
      const hash = await hashToken(token);
      const db = createAuthDb({
        tokens: new Map([[hash, { user_id: `@q${i}:${SERVER}`, device_id: 'QD' }]]),
      });
      const q = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=${encodeURIComponent(token)}`,
      });
      const missing = makeAuthCtx({ db });
      const emptyAuth = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=${encodeURIComponent(token)}`,
        headers: { Authorization: '' },
      });
      await Promise.all([
        optionalAuth()(q, vi.fn(async () => undefined)),
        optionalAuth()(missing, vi.fn(async () => undefined)),
        optionalAuth()(emptyAuth, vi.fn(async () => undefined)),
      ]);
      expect(q.get('userId')).toBe(`@q${i}:${SERVER}`);
      expect(q.get('deviceId')).toBe('QD');
      expect(missing.get('userId')).toBeUndefined();
      expect(emptyAuth.get('userId')).toBe(`@q${i}:${SERVER}`);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`requireAuth empty Authorization uses query flood-${i}`, async () => {
      const token = `syt_empty_${i}`;
      const hash = await hashToken(token);
      const db = createAuthDb({
        tokens: new Map([[hash, { user_id: `@e${i}:${SERVER}`, device_id: 'ED' }]]),
      });
      const ctx = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=${encodeURIComponent(token)}`,
        headers: { Authorization: '' },
      });
      const next = vi.fn(async () => 'ok');
      await expect(requireAuth()(ctx, next)).resolves.toBe('ok');
      expect(ctx.get('userId')).toBe(`@e${i}:${SERVER}`);
      expect(ctx.get('accessToken')).toBe(token);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`accessToken field bind under parallel flood-${i}`, async () => {
      const tokens = [`syt_a_${i}`, `syt_b_${i}`, `syt_c_${i}`];
      const hashes = await Promise.all(tokens.map((t) => hashToken(t)));
      const db = createAuthDb({
        tokens: new Map(
          hashes.map((h, j) => [h, { user_id: `@ab${i}_${j}:${SERVER}`, device_id: `D${j}` }])
        ),
      });
      const ctxs = tokens.map((t) =>
        makeAuthCtx({ db, headers: { Authorization: `Bearer ${t}` } })
      );
      await Promise.all(ctxs.map((ctx) => requireAuth()(ctx, vi.fn(async () => undefined))));
      for (let j = 0; j < tokens.length; j++) {
        expect(ctxs[j].get('accessToken')).toBe(tokens[j]);
        expect((ctxs[j].get('auth') as { accessToken: string }).accessToken).toBe(tokens[j]);
      }
    });
  }
});
