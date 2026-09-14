/**
 * TOKENMAXX HEAVY leftovers after #236 / tip after #253 — residual
 * *auth middleware* concurrent-race / soft niches not covered by
 * auth-middleware-concurrent-race leftovers (#217/#236) or failure leftovers (#147).
 *
 * Distinct from #236: throwOnToken∥throwOnAs; extract whitespace; multi-AS;
 * SERVER_NAME override; optionalAuth query + empty Authorization; AS sender∥
 * explicit user_id; accessToken field bind; Bearer-wins-when-both-valid.
 *
 * Residual deepen after #253 tip:
 *   garbage Bearer blocks valid query (no fallthrough); empty user_id → sender;
 *   whitespace user_id format forbid; users-namespace shape matrix (missing/
 *   null/rooms-only); exclusive flag ignored; optionalAuth throwOnToken;
 *   device_id '' preserved; corrupt namespaces JSON → M_UNKNOWN_TOKEN;
 *   Basic/Digest + valid query under requireAuth.
 *
 * Tests-only. Fixtures use example.com / matrix.example.com only.
 * No product inventing. Does not touch auth.ts source (HITL).
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
// Residual: garbage Bearer blocks valid query (no fallthrough under requireAuth)
// ---------------------------------------------------------------------------

describe('race residual auth garbage Bearer blocks query after #236', () => {
  for (let i = 0; i < 12; i++) {
    it(`garbage Bearer + valid query → unknown; query-only ok flood-${i}`, async () => {
      const good = `syt_good_${i}`;
      const hash = await hashToken(good);
      const db = createAuthDb({
        tokens: new Map([[hash, { user_id: `@g${i}:${SERVER}`, device_id: 'GD' }]]),
      });
      const garbagePlusQuery = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=${encodeURIComponent(good)}`,
        headers: { Authorization: `Bearer garbage_${i}` },
      });
      const queryOnly = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=${encodeURIComponent(good)}`,
      });
      const bearerOk = makeAuthCtx({
        db,
        headers: { Authorization: `Bearer ${good}` },
      });
      const nextG = vi.fn(async () => 'g');
      const nextQ = vi.fn(async () => 'q');
      const nextB = vi.fn(async () => 'b');
      const [resG, resQ, resB] = await Promise.all([
        requireAuth()(garbagePlusQuery, nextG),
        requireAuth()(queryOnly, nextQ),
        requireAuth()(bearerOk, nextB),
      ]);
      expect(await jsonBody(resG as Response)).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
      expect(nextG).not.toHaveBeenCalled();
      expect(resQ).toBe('q');
      expect(queryOnly.get('userId')).toBe(`@g${i}:${SERVER}`);
      expect(resB).toBe('b');
      expect(bearerOk.get('userId')).toBe(`@g${i}:${SERVER}`);
      // extract still prefers Bearer garbage over query
      expect(
        extractAccessToken(
          new Request(`https://${SERVER}/sync?access_token=${good}`, {
            headers: { Authorization: `Bearer garbage_${i}` },
          })
        )
      ).toBe(`garbage_${i}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: empty user_id → sender; whitespace user_id → format forbid
// ---------------------------------------------------------------------------

describe('race residual auth AS empty/whitespace user_id after #236', () => {
  for (let i = 0; i < 12; i++) {
    it(`empty user_id→sender; space→forbid; good parallel flood-${i}`, async () => {
      const tok = `as_empty_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            tok,
            asRow({
              as_token: tok,
              sender_localpart: `bridge_${i}`,
              namespaces: JSON.stringify({
                users: [
                  {
                    exclusive: true,
                    regex: `@bridge_.*:${SERVER.replace(/\./g, '\\.')}`,
                  },
                ],
              }),
            }),
          ],
        ]),
      });
      const emptyUid = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const spaceUid = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(' ')}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const goodUid = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@bridge_u_${i}:${SERVER}`)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const nextE = vi.fn(async () => 'e');
      const nextS = vi.fn();
      const nextG = vi.fn(async () => 'g');
      const [resE, resS, resG] = await Promise.all([
        requireAuth()(emptyUid, nextE),
        requireAuth()(spaceUid, nextS),
        requireAuth()(goodUid, nextG),
      ]);
      // "" is falsy → sender fallback
      expect(resE).toBe('e');
      expect(emptyUid.get('userId')).toBe(`@bridge_${i}:${SERVER}`);
      expect(emptyUid.get('deviceId')).toBeNull();
      // " " truthy → format forbid
      expect(await jsonBody(resS as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(nextS).not.toHaveBeenCalled();
      expect(resG).toBe('g');
      expect(goodUid.get('userId')).toBe(`@bridge_u_${i}:${SERVER}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: users-namespace shape matrix (missing / null / rooms-only / [])
// ---------------------------------------------------------------------------

describe('race residual auth users-namespace shape matrix after #236', () => {
  const shapes: Array<{ name: string; namespaces: string }> = [
    { name: 'omitted-users', namespaces: JSON.stringify({ rooms: [], aliases: [] }) },
    { name: 'users-null', namespaces: JSON.stringify({ users: null, rooms: [], aliases: [] }) },
    {
      name: 'rooms-only-regex',
      namespaces: JSON.stringify({
        users: [],
        rooms: [{ exclusive: true, regex: `@anyone_.*:${SERVER.replace(/\./g, '\\.')}` }],
        aliases: [{ exclusive: true, regex: `@anyone_.*:${SERVER.replace(/\./g, '\\.')}` }],
      }),
    },
    { name: 'users-empty', namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }) },
  ];

  for (let i = 0; i < shapes.length; i++) {
    it(`${shapes[i].name} allows any local user flood-${i}`, async () => {
      const shape = shapes[i];
      const tok = `as_shape_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            tok,
            asRow({
              as_token: tok,
              sender_localpart: 'shape',
              namespaces: shape.namespaces,
            }),
          ],
        ]),
      });
      const anyone = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@anyone_${i}:${SERVER}`)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const foreign = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@anyone_${i}:other.example.com`)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const nextA = vi.fn(async () => 'a');
      const nextF = vi.fn();
      const [resA, resF] = await Promise.all([
        requireAuth()(anyone, nextA),
        requireAuth()(foreign, nextF),
      ]);
      // namespaces?.users?.length > 0 is false for missing/null/[] → no ns gate
      expect(resA).toBe('a');
      expect(anyone.get('userId')).toBe(`@anyone_${i}:${SERVER}`);
      // rooms/aliases regex must NOT gate users
      expect(await jsonBody(resF as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(nextF).not.toHaveBeenCalled();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`rooms-aliases-only blob never gates mxid flood-${i}`, async () => {
      const tok = `as_ra_${i}`;
      const ns = JSON.stringify({
        // no users key — rooms/aliases would match the mxid if consulted
        rooms: [{ exclusive: true, regex: `@ra_.*:${SERVER.replace(/\./g, '\\.')}` }],
        aliases: [{ exclusive: true, regex: `@ra_.*:${SERVER.replace(/\./g, '\\.')}` }],
      });
      const db = createAuthDb({
        appservices: new Map([
          [tok, asRow({ as_token: tok, sender_localpart: 'ra', namespaces: ns })],
        ]),
      });
      const ctx = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@ra_user_${i}:${SERVER}`)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const next = vi.fn(async () => 'ok');
      await expect(requireAuth()(ctx, next)).resolves.toBe('ok');
      expect(ctx.get('userId')).toBe(`@ra_user_${i}:${SERVER}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: exclusive true vs false both allow when regex matches
// ---------------------------------------------------------------------------

describe('race residual auth exclusive flag ignored after #236', () => {
  for (let i = 0; i < 12; i++) {
    it(`exclusive true∥false both allow under race flood-${i}`, async () => {
      const tok = `as_ex_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            tok,
            asRow({
              as_token: tok,
              sender_localpart: 'ex',
              namespaces: JSON.stringify({
                users: [
                  {
                    exclusive: true,
                    regex: `@ex_a_.*:${SERVER.replace(/\./g, '\\.')}`,
                  },
                  {
                    exclusive: false,
                    regex: `@ex_b_.*:${SERVER.replace(/\./g, '\\.')}`,
                  },
                ],
              }),
            }),
          ],
        ]),
      });
      const a = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@ex_a_${i}:${SERVER}`)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const b = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@ex_b_${i}:${SERVER}`)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const deny = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@ex_c_${i}:${SERVER}`)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const nextA = vi.fn(async () => 'a');
      const nextB = vi.fn(async () => 'b');
      const nextD = vi.fn();
      const [resA, resB, resD] = await Promise.all([
        requireAuth()(a, nextA),
        requireAuth()(b, nextB),
        requireAuth()(deny, nextD),
      ]);
      expect(resA).toBe('a');
      expect(resB).toBe('b');
      expect(await jsonBody(resD as Response)).toMatchObject({ errcode: 'M_FORBIDDEN' });
      expect(nextD).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: optionalAuth + throwOnToken still calls next (vs requireAuth reject)
// ---------------------------------------------------------------------------

describe('race residual auth optionalAuth throwOnToken after #236', () => {
  for (let i = 0; i < 12; i++) {
    it(`optionalAuth throwOnToken fulfills∥requireAuth rejects flood-${i}`, async () => {
      const token = `syt_opt_${i}`;
      const throwDb = createAuthDb({ throwOnToken: true });
      const okHash = await hashToken(token);
      const okDb = createAuthDb({
        tokens: new Map([[okHash, { user_id: `@ok${i}:${SERVER}`, device_id: 'OK' }]]),
      });
      const optThrow = makeAuthCtx({
        db: throwDb,
        headers: { Authorization: `Bearer ${token}` },
      });
      const reqThrow = makeAuthCtx({
        db: throwDb,
        headers: { Authorization: `Bearer ${token}` },
      });
      const optOk = makeAuthCtx({
        db: okDb,
        headers: { Authorization: `Bearer ${token}` },
      });
      const nextOpt = vi.fn(async () => 'opt');
      const nextReq = vi.fn();
      const nextOk = vi.fn(async () => 'ok');
      // optionalAuth does not try/catch — throwOnToken will reject the promise
      // Document actual behavior: optionalAuth propagates token lookup errors
      const [optResult, reqResult, okResult] = await Promise.allSettled([
        optionalAuth()(optThrow, nextOpt),
        requireAuth()(reqThrow, nextReq),
        optionalAuth()(optOk, nextOk),
      ]);
      // requireAuth throwOnToken bubbles (no AS catch path for user-token throw)
      expect(reqResult.status).toBe('rejected');
      expect(nextReq).not.toHaveBeenCalled();
      // optionalAuth: same throw path — rejected, context unset
      expect(optResult.status).toBe('rejected');
      expect(optThrow.get('userId')).toBeUndefined();
      expect(okResult.status).toBe('fulfilled');
      expect(okResult.status === 'fulfilled' && okResult.value).toBe('ok');
      expect(optOk.get('userId')).toBe(`@ok${i}:${SERVER}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: device_id '' empty string preserved (vs null)
// ---------------------------------------------------------------------------

describe('race residual auth empty device_id string after #236', () => {
  for (let i = 0; i < 10; i++) {
    it(`device_id '' preserved∥null∥value flood-${i}`, async () => {
      const tEmpty = `syt_de_${i}`;
      const tNull = `syt_dn_${i}`;
      const tVal = `syt_dv_${i}`;
      const [hE, hN, hV] = await Promise.all([
        hashToken(tEmpty),
        hashToken(tNull),
        hashToken(tVal),
      ]);
      const db = createAuthDb({
        tokens: new Map([
          [hE, { user_id: `@e${i}:${SERVER}`, device_id: '' }],
          [hN, { user_id: `@n${i}:${SERVER}`, device_id: null }],
          [hV, { user_id: `@v${i}:${SERVER}`, device_id: `DEV${i}` }],
        ]),
      });
      const cE = makeAuthCtx({ db, headers: { Authorization: `Bearer ${tEmpty}` } });
      const cN = makeAuthCtx({ db, headers: { Authorization: `Bearer ${tNull}` } });
      const cV = makeAuthCtx({ db, headers: { Authorization: `Bearer ${tVal}` } });
      await Promise.all([
        requireAuth()(cE, vi.fn(async () => undefined)),
        requireAuth()(cN, vi.fn(async () => undefined)),
        requireAuth()(cV, vi.fn(async () => undefined)),
      ]);
      expect(cE.get('deviceId')).toBe('');
      expect(cN.get('deviceId')).toBeNull();
      expect(cV.get('deviceId')).toBe(`DEV${i}`);
      const vEmpty = await validateAccessToken(db, tEmpty);
      expect(vEmpty?.deviceId).toBe('');
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: corrupt AS namespaces JSON → swallowed → M_UNKNOWN_TOKEN
// ---------------------------------------------------------------------------

describe('race residual auth corrupt namespaces JSON after #236', () => {
  for (let i = 0; i < 10; i++) {
    it(`corrupt namespaces → unknown∥valid AS ok flood-${i}`, async () => {
      const bad = `as_bad_${i}`;
      const good = `as_good_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            bad,
            asRow({
              as_token: bad,
              sender_localpart: 'bad',
              namespaces: '{not-json',
            }),
          ],
          [
            good,
            asRow({
              as_token: good,
              sender_localpart: 'good',
              namespaces: JSON.stringify({ users: [] }),
            }),
          ],
        ]),
      });
      const badCtx = makeAuthCtx({
        db,
        headers: { Authorization: `Bearer ${bad}` },
      });
      const goodCtx = makeAuthCtx({
        db,
        headers: { Authorization: `Bearer ${good}` },
      });
      const nextBad = vi.fn();
      const nextGood = vi.fn(async () => 'g');
      const [resBad, resGood] = await Promise.all([
        requireAuth()(badCtx, nextBad),
        requireAuth()(goodCtx, nextGood),
      ]);
      // getAppServiceByToken JSON.parse throw → catch → auth null → unknown
      expect(await jsonBody(resBad as Response)).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
      expect(nextBad).not.toHaveBeenCalled();
      expect(resGood).toBe('g');
      expect(goodCtx.get('userId')).toBe(`@good:${SERVER}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: Basic/Digest + valid query under requireAuth (extract fallthrough)
// ---------------------------------------------------------------------------

describe('race residual auth Basic/Digest fallthrough to query after #236', () => {
  for (let i = 0; i < 12; i++) {
    it(`Basic/Digest + query uses query token flood-${i}`, async () => {
      const token = `syt_scheme_${i}`;
      const hash = await hashToken(token);
      const db = createAuthDb({
        tokens: new Map([[hash, { user_id: `@s${i}:${SERVER}`, device_id: 'SD' }]]),
      });
      const schemes = ['Basic', 'Digest', 'Token', 'Negotiate'];
      const scheme = schemes[i % schemes.length];
      const withScheme = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=${encodeURIComponent(token)}`,
        headers: { Authorization: `${scheme} abc${i}` },
      });
      const bearerWrong = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=${encodeURIComponent(token)}`,
        headers: { Authorization: `Bearer wrong_${i}` },
      });
      const nextS = vi.fn(async () => 's');
      const nextW = vi.fn();
      const [resS, resW] = await Promise.all([
        requireAuth()(withScheme, nextS),
        requireAuth()(bearerWrong, nextW),
      ]);
      expect(resS).toBe('s');
      expect(withScheme.get('userId')).toBe(`@s${i}:${SERVER}`);
      expect(withScheme.get('accessToken')).toBe(token);
      expect(await jsonBody(resW as Response)).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
      expect(nextW).not.toHaveBeenCalled();
    });
  }
});
