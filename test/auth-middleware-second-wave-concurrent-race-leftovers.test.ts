/**
 * TOKENMAXX HEAVY leftovers after tip #266 — second-wave residual
 * *auth middleware* concurrent-race / soft niches not covered by
 * auth-middleware-residual-concurrent-race leftovers (#266).
 *
 * Distinct from #266 residual:
 *   garbage Bearer blocks query; empty/whitespace user_id (errcode only);
 *   users-ns shape matrix; exclusive ignored; optionalAuth throwOnToken;
 *   device_id ''; corrupt namespaces; Basic/Digest under **requireAuth**.
 *
 * Second-wave deepen after #266 tip:
 *   default Errors strings `Missing access token` / `Unknown token` exact bind;
 *   optionalAuth + Basic/Digest + valid query → sets context;
 *   whitespace/%09/%0A user_id → exact `Invalid user_id format` under race;
 *   duplicate `?user_id=a&user_id=b` first-wins via searchParams.get.
 *
 * Tests-only. Fixtures use example.com / matrix.example.com only.
 * No product inventing. Does not touch auth.ts source (HITL).
 * Reversible by reverting this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
// Second-wave: default Errors strings exact bind under race
// (forever errcode-only; AS custom Missing/Invalid AS token saturated elsewhere)
// ---------------------------------------------------------------------------

describe('race second-wave auth default error strings after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`Missing access token + Unknown token exact bind flood-${i}`, async () => {
      const db = createAuthDb();
      const missing = makeAuthCtx({ db });
      const unknown = makeAuthCtx({
        db,
        headers: { Authorization: `Bearer nope_${i}` },
      });
      const emptyBearer = makeAuthCtx({
        db,
        headers: { Authorization: 'Bearer ' },
      });
      const [resM, resU, resE] = await Promise.all([
        requireAuth()(missing, vi.fn()),
        requireAuth()(unknown, vi.fn()),
        requireAuth()(emptyBearer, vi.fn()),
      ]);
      expect(await jsonBody(resM as Response)).toEqual({
        errcode: 'M_MISSING_TOKEN',
        error: 'Missing access token',
        status: 401,
      });
      expect(await jsonBody(resU as Response)).toEqual({
        errcode: 'M_UNKNOWN_TOKEN',
        error: 'Unknown token',
        status: 401,
      });
      // Headers trim "Bearer " → bare scheme / empty token path still missing-or-unknown
      const emptyBody = await jsonBody(resE as Response);
      expect(emptyBody.status).toBe(401);
      expect(['M_MISSING_TOKEN', 'M_UNKNOWN_TOKEN']).toContain(emptyBody.errcode);
      if (emptyBody.errcode === 'M_MISSING_TOKEN') {
        expect(emptyBody.error).toBe('Missing access token');
      } else {
        expect(emptyBody.error).toBe('Unknown token');
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Second-wave: optionalAuth + Basic/Digest + valid query → sets context
// (#266 Basic/Digest only under requireAuth)
// ---------------------------------------------------------------------------

describe('race second-wave auth optionalAuth scheme fallthrough after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`optionalAuth Basic/Digest + query sets context flood-${i}`, async () => {
      const token = `syt_opt_scheme_${i}`;
      const hash = await hashToken(token);
      const db = createAuthDb({
        tokens: new Map([[hash, { user_id: `@o${i}:${SERVER}`, device_id: 'OD' }]]),
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
      const queryOnly = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=${encodeURIComponent(token)}`,
      });
      const nextS = vi.fn(async () => 's');
      const nextW = vi.fn(async () => 'w');
      const nextQ = vi.fn(async () => 'q');
      const [resS, resW, resQ] = await Promise.all([
        optionalAuth()(withScheme, nextS),
        optionalAuth()(bearerWrong, nextW),
        optionalAuth()(queryOnly, nextQ),
      ]);
      expect(resS).toBe('s');
      expect(withScheme.get('userId')).toBe(`@o${i}:${SERVER}`);
      expect(withScheme.get('accessToken')).toBe(token);
      expect(withScheme.get('deviceId')).toBe('OD');
      // invalid Bearer does not fall through under optionalAuth either
      expect(resW).toBe('w');
      expect(bearerWrong.get('userId')).toBeUndefined();
      expect(resQ).toBe('q');
      expect(queryOnly.get('userId')).toBe(`@o${i}:${SERVER}`);
      expect(
        extractAccessToken(
          new Request(`https://${SERVER}/sync?access_token=${token}`, {
            headers: { Authorization: `${scheme} abc${i}` },
          })
        )
      ).toBe(token);
    });
  }
});

// ---------------------------------------------------------------------------
// Second-wave: whitespace / %09 / %0A user_id → exact Invalid user_id format
// (#266 space→forbid is errcode/status only)
// ---------------------------------------------------------------------------

describe('race second-wave auth whitespace user_id error string after #266', () => {
  const badUids = [' ', '\t', '\n', '  ', '@Bad', 'not-an-mxid', '@x'];

  for (let i = 0; i < badUids.length; i++) {
    it(`user_id=${JSON.stringify(badUids[i])} exact format forbid flood-${i}`, async () => {
      const tok = `as_fmt_${i}`;
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
      const bad = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(badUids[i])}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const good = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@bridge_u_${i}:${SERVER}`)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const nextB = vi.fn();
      const nextG = vi.fn(async () => 'g');
      const [resB, resG] = await Promise.all([
        requireAuth()(bad, nextB),
        requireAuth()(good, nextG),
      ]);
      expect(await jsonBody(resB as Response)).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Invalid user_id format',
        status: 403,
      });
      expect(nextB).not.toHaveBeenCalled();
      expect(resG).toBe('g');
      expect(good.get('userId')).toBe(`@bridge_u_${i}:${SERVER}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Second-wave: duplicate ?user_id=a&user_id=b — searchParams.get first-wins
// ---------------------------------------------------------------------------

describe('race second-wave auth duplicate user_id first-wins after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`first user_id wins; second ignored under race flood-${i}`, async () => {
      const tok = `as_dup_${i}`;
      const first = `@bot_first_${i}:${SERVER}`;
      const second = `@bot_second_${i}:${SERVER}`;
      const foreign = `@bot_foreign_${i}:other.example.com`;
      const db = createAuthDb({
        appservices: new Map([
          [
            tok,
            asRow({
              as_token: tok,
              sender_localpart: 'bridge',
              namespaces: JSON.stringify({
                users: [
                  {
                    exclusive: true,
                    regex: `@bot_.*:${SERVER.replace(/\./g, '\\.')}`,
                  },
                ],
              }),
            }),
          ],
        ]),
      });
      const firstWins = makeAuthCtx({
        db,
        url:
          `https://${SERVER}/sync?user_id=${encodeURIComponent(first)}` +
          `&user_id=${encodeURIComponent(second)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      // first foreign → forbid even if second is local (no fallthrough to later values)
      const foreignFirst = makeAuthCtx({
        db,
        url:
          `https://${SERVER}/sync?user_id=${encodeURIComponent(foreign)}` +
          `&user_id=${encodeURIComponent(first)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      // first good, second foreign — still ok (second ignored)
      const secondForeign = makeAuthCtx({
        db,
        url:
          `https://${SERVER}/sync?user_id=${encodeURIComponent(first)}` +
          `&user_id=${encodeURIComponent(foreign)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const nextF = vi.fn(async () => 'f');
      const nextX = vi.fn();
      const nextS = vi.fn(async () => 's');
      const [resF, resX, resS] = await Promise.all([
        requireAuth()(firstWins, nextF),
        requireAuth()(foreignFirst, nextX),
        requireAuth()(secondForeign, nextS),
      ]);
      expect(resF).toBe('f');
      expect(firstWins.get('userId')).toBe(first);
      expect(firstWins.get('userId')).not.toBe(second);
      expect(await jsonBody(resX as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot impersonate users on other servers',
        status: 403,
      });
      expect(nextX).not.toHaveBeenCalled();
      expect(resS).toBe('s');
      expect(secondForeign.get('userId')).toBe(first);
    });
  }
});
