/**
 * TOKENMAXX HEAVY leftovers after #266 — tertiary *auth middleware*
 * concurrent-race / soft niches not covered by residual (#266) or
 * #217/#236/#147 concurrent/failure leftovers.
 *
 * Distinct from #266 residual:
 *   garbage Bearer blocks query; empty/ws user_id; users-ns shape matrix;
 *   exclusive ignored; optionalAuth throwOnToken; device_id ''; corrupt
 *   namespaces JSON; Basic/Digest→query.
 *
 * Tertiary deepen after #266 tip:
 *   empty `access_token=` → missing (falsy); whitespace query → unknown;
 *   duplicate `user_id` first-wins; namespaces JSON `null`; users string
 *   → unknown; empty/missing(=allow)/null/invalid regex ns matrix under race.
 *
 * Tests-only. Fixtures use example.com / matrix.example.com only.
 * No product inventing. Does not touch auth.ts source (HITL).
 * Reversible by deleting this file.
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
// Tertiary: empty access_token= is falsy → missing (not unknown)
// ---------------------------------------------------------------------------

describe('race tertiary auth empty access_token= after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`access_token= → missing∥ws unknown∥valid parallel flood-${i}`, async () => {
      const good = `syt_good_${i}`;
      const hash = await hashToken(good);
      const db = createAuthDb({
        tokens: new Map([[hash, { user_id: `@g${i}:${SERVER}`, device_id: 'GD' }]]),
      });
      const emptyQ = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=`,
      });
      const wsQ = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=${encodeURIComponent(' ')}`,
      });
      const validQ = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=${encodeURIComponent(good)}`,
      });
      const nextE = vi.fn();
      const nextW = vi.fn();
      const nextV = vi.fn(async () => 'v');
      const [resE, resW, resV] = await Promise.all([
        requireAuth()(emptyQ, nextE),
        requireAuth()(wsQ, nextW),
        requireAuth()(validQ, nextV),
      ]);
      // searchParams.get('access_token') === '' is falsy → extract returns null
      expect(await jsonBody(resE as Response)).toMatchObject({
        errcode: 'M_MISSING_TOKEN',
        status: 401,
      });
      expect(nextE).not.toHaveBeenCalled();
      // whitespace is truthy → validate → unknown
      expect(await jsonBody(resW as Response)).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
      expect(nextW).not.toHaveBeenCalled();
      expect(resV).toBe('v');
      expect(validQ.get('userId')).toBe(`@g${i}:${SERVER}`);
      expect(extractAccessToken(new Request(`https://${SERVER}/sync?access_token=`))).toBeNull();
      expect(
        extractAccessToken(new Request(`https://${SERVER}/sync?access_token=${encodeURIComponent(' ')}`))
      ).toBe(' ');
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`optionalAuth access_token= leaves context unset flood-${i}`, async () => {
      const good = `syt_opt_${i}`;
      const hash = await hashToken(good);
      const db = createAuthDb({
        tokens: new Map([[hash, { user_id: `@o${i}:${SERVER}`, device_id: 'OD' }]]),
      });
      const empty = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=`,
      });
      const valid = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?access_token=${encodeURIComponent(good)}`,
      });
      const nextE = vi.fn(async () => 'e');
      const nextV = vi.fn(async () => 'v');
      const [resE, resV] = await Promise.all([
        optionalAuth()(empty, nextE),
        optionalAuth()(valid, nextV),
      ]);
      expect(resE).toBe('e');
      expect(empty.get('userId')).toBeUndefined();
      expect(resV).toBe('v');
      expect(valid.get('userId')).toBe(`@o${i}:${SERVER}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Tertiary: duplicate user_id query params — first wins
// ---------------------------------------------------------------------------

describe('race tertiary auth duplicate user_id first-wins after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`user_id=allow&user_id=deny → first wins flood-${i}`, async () => {
      const tok = `as_dup_${i}`;
      const allow = `@bot_ok_${i}:${SERVER}`;
      const deny = `@nope_${i}:${SERVER}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            tok,
            asRow({
              as_token: tok,
              sender_localpart: 'bot',
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
      const allowFirst = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(allow)}&user_id=${encodeURIComponent(deny)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const denyFirst = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(deny)}&user_id=${encodeURIComponent(allow)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const senderOnly = makeAuthCtx({
        db,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const nextA = vi.fn(async () => 'a');
      const nextD = vi.fn();
      const nextS = vi.fn(async () => 's');
      const [resA, resD, resS] = await Promise.all([
        requireAuth()(allowFirst, nextA),
        requireAuth()(denyFirst, nextD),
        requireAuth()(senderOnly, nextS),
      ]);
      expect(resA).toBe('a');
      expect(allowFirst.get('userId')).toBe(allow);
      expect(await jsonBody(resD as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(nextD).not.toHaveBeenCalled();
      expect(resS).toBe('s');
      expect(senderOnly.get('userId')).toBe(`@bot:${SERVER}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Tertiary: namespaces JSON null (top-level) skips gate
// ---------------------------------------------------------------------------

describe('race tertiary auth namespaces JSON null after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`namespaces JSON null → any local user∥foreign forbid flood-${i}`, async () => {
      const tok = `as_nullns_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            tok,
            asRow({
              as_token: tok,
              sender_localpart: 'nullns',
              // JSON.parse('null') → null; namespaces?.users?.length skips gate
              namespaces: 'null',
            }),
          ],
        ]),
      });
      const local = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@anyone_${i}:${SERVER}`)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const foreign = makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@anyone_${i}:other.example.com`)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const sender = makeAuthCtx({
        db,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const nextL = vi.fn(async () => 'l');
      const nextF = vi.fn();
      const nextS = vi.fn(async () => 's');
      const [resL, resF, resS] = await Promise.all([
        requireAuth()(local, nextL),
        requireAuth()(foreign, nextF),
        requireAuth()(sender, nextS),
      ]);
      expect(resL).toBe('l');
      expect(local.get('userId')).toBe(`@anyone_${i}:${SERVER}`);
      expect(await jsonBody(resF as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(nextF).not.toHaveBeenCalled();
      expect(resS).toBe('s');
      expect(sender.get('userId')).toBe(`@nullns:${SERVER}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Tertiary: users namespace as non-array string → .some throw → unknown
// ---------------------------------------------------------------------------

describe('race tertiary auth users string namespace after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`users string → unknown∥valid AS ok flood-${i}`, async () => {
      const bad = `as_strusers_${i}`;
      const good = `as_good_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            bad,
            asRow({
              as_token: bad,
              sender_localpart: 'bad',
              // users is a string → .length > 0, then .some is not a function
              namespaces: JSON.stringify({ users: '@bot_.*:matrix\\.example\\.com' }),
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
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(`@bot_x_${i}:${SERVER}`)}`,
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
      // throw inside AS path → catch → auth null → unknown
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
// Tertiary: users ns entry missing/null/empty regex matrix
// ---------------------------------------------------------------------------

describe('race tertiary auth users regex field matrix after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`regex empty∥missing∥null∥invalid∥good matrix flood-${i}`, async () => {
      // empty regex + missing regex both become /(?:)/ → allow-all
      const tokEmpty = `as_rx_empty_${i}`;
      const dbEmpty = createAuthDb({
        appservices: new Map([
          [
            tokEmpty,
            asRow({
              as_token: tokEmpty,
              sender_localpart: 'rxe',
              namespaces: JSON.stringify({
                users: [{ exclusive: true, regex: '' }],
              }),
            }),
          ],
        ]),
      });
      const tokMiss = `as_rx_miss_${i}`;
      const dbMiss = createAuthDb({
        appservices: new Map([
          [
            tokMiss,
            asRow({
              as_token: tokMiss,
              sender_localpart: 'rxm',
              // missing regex → RegExp(undefined) → /(?:)/ allow-all
              namespaces: JSON.stringify({
                users: [{ exclusive: true }],
              }),
            }),
          ],
        ]),
      });
      const tokNull = `as_rx_null_${i}`;
      const dbNull = createAuthDb({
        appservices: new Map([
          [
            tokNull,
            asRow({
              as_token: tokNull,
              sender_localpart: 'rxn',
              // RegExp(null) → /null/ → does not match mxid → forbid
              namespaces: JSON.stringify({
                users: [{ exclusive: true, regex: null }],
              }),
            }),
          ],
        ]),
      });
      const tokInv = `as_rx_inv_${i}`;
      const dbInv = createAuthDb({
        appservices: new Map([
          [
            tokInv,
            asRow({
              as_token: tokInv,
              sender_localpart: 'rxi',
              namespaces: JSON.stringify({
                users: [{ exclusive: true, regex: '[' }],
              }),
            }),
          ],
        ]),
      });
      const tokGood = `as_rx_good_${i}`;
      const dbGood = createAuthDb({
        appservices: new Map([
          [
            tokGood,
            asRow({
              as_token: tokGood,
              sender_localpart: 'rxg',
              namespaces: JSON.stringify({
                users: [
                  {
                    exclusive: true,
                    regex: `@rx_good_.*:${SERVER.replace(/\./g, '\\.')}`,
                  },
                ],
              }),
            }),
          ],
        ]),
      });

      const uid = `@random_${i}:${SERVER}`;
      const goodUid = `@rx_good_${i}:${SERVER}`;
      const emptyCtx = makeAuthCtx({
        db: dbEmpty,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(uid)}`,
        headers: { Authorization: `Bearer ${tokEmpty}` },
      });
      const missCtx = makeAuthCtx({
        db: dbMiss,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(uid)}`,
        headers: { Authorization: `Bearer ${tokMiss}` },
      });
      const nullCtx = makeAuthCtx({
        db: dbNull,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(uid)}`,
        headers: { Authorization: `Bearer ${tokNull}` },
      });
      const invCtx = makeAuthCtx({
        db: dbInv,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(uid)}`,
        headers: { Authorization: `Bearer ${tokInv}` },
      });
      const goodOk = makeAuthCtx({
        db: dbGood,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(goodUid)}`,
        headers: { Authorization: `Bearer ${tokGood}` },
      });
      const goodDeny = makeAuthCtx({
        db: dbGood,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent(uid)}`,
        headers: { Authorization: `Bearer ${tokGood}` },
      });

      const nextE = vi.fn(async () => 'e');
      const nextM = vi.fn(async () => 'm');
      const nextN = vi.fn();
      const nextI = vi.fn();
      const nextG = vi.fn(async () => 'g');
      const nextD = vi.fn();
      const [resE, resM, resN, resI, resG, resD] = await Promise.all([
        requireAuth()(emptyCtx, nextE),
        requireAuth()(missCtx, nextM),
        requireAuth()(nullCtx, nextN),
        requireAuth()(invCtx, nextI),
        requireAuth()(goodOk, nextG),
        requireAuth()(goodDeny, nextD),
      ]);
      expect(resE).toBe('e');
      expect(emptyCtx.get('userId')).toBe(uid);
      // missing regex → RegExp(undefined) → /(?:)/ → allow
      expect(resM).toBe('m');
      expect(missCtx.get('userId')).toBe(uid);
      // null regex → /null/ → forbid
      expect(await jsonBody(resN as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(nextN).not.toHaveBeenCalled();
      // invalid regex catch → false → forbid
      expect(await jsonBody(resI as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(nextI).not.toHaveBeenCalled();
      expect(resG).toBe('g');
      expect(goodOk.get('userId')).toBe(goodUid);
      expect(await jsonBody(resD as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(nextD).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Tertiary: validateAccessToken empty/whitespace token isolation
// ---------------------------------------------------------------------------

describe('race tertiary auth validateAccessToken empty shapes after #266', () => {
  for (let i = 0; i < 10; i++) {
    it(`validate empty∥ws∥good parallel flood-${i}`, async () => {
      const good = `syt_val_${i}`;
      const hash = await hashToken(good);
      const db = createAuthDb({
        tokens: new Map([[hash, { user_id: `@v${i}:${SERVER}`, device_id: 'VD' }]]),
      });
      const [empty, ws, ok] = await Promise.all([
        validateAccessToken(db, ''),
        validateAccessToken(db, ' '),
        validateAccessToken(db, good),
      ]);
      expect(empty).toBeNull();
      expect(ws).toBeNull();
      expect(ok).toEqual({
        userId: `@v${i}:${SERVER}`,
        deviceId: 'VD',
        accessToken: good,
      });
    });
  }
});
