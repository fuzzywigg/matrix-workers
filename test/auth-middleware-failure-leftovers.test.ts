/**
 * TOKENMAXX HEAVY leftovers after #147 — auth middleware failure/reliability edges.
 * Complements auth-middleware.test.ts. Prefer Bearer/query precedence, AS namespace
 * matrix, optionalAuth edges, errcode contracts. Tests-only — no product inventing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

function createAuthDb(opts: {
  tokens?: Map<string, TokenRow>;
  appservices?: Map<string, AsRow>;
  throwOnAs?: boolean;
} = {}) {
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

async function jsonBody(res: Response): Promise<{ errcode: string; error: string; status: number }> {
  const body = (await res.json()) as { errcode: string; error: string };
  return { ...body, status: res.status };
}

describe('auth leftovers extractAccessToken precedence after #147', () => {
  it('Bearer header wins over access_token query', () => {
    const req = new Request(`https://${SERVER}/sync?access_token=query_tok`, {
      headers: { Authorization: 'Bearer header_tok' },
    });
    expect(extractAccessToken(req)).toBe('header_tok');
  });

  it('empty Authorization falls through to query token', () => {
    const req = new Request(`https://${SERVER}/sync?access_token=query_only`, {
      headers: { Authorization: '' },
    });
    expect(extractAccessToken(req)).toBe('query_only');
  });

  it('Bearer with no token value does not match; query used', () => {
    const req = new Request(`https://${SERVER}/sync?access_token=q`, {
      headers: { Authorization: 'Bearer' },
    });
    expect(extractAccessToken(req)).toBe('q');
  });

  it('non-Bearer Authorization scheme falls through to query', () => {
    const req = new Request(`https://${SERVER}/sync?access_token=qtok`, {
      headers: { Authorization: 'Basic abc' },
    });
    expect(extractAccessToken(req)).toBe('qtok');
  });

  it('missing both header and query → null', () => {
    expect(extractAccessToken(new Request(`https://${SERVER}/sync`))).toBeNull();
  });

  it('Bearer match is case-insensitive', () => {
    const req = new Request(`https://${SERVER}/sync`, {
      headers: { Authorization: 'bearer CaseToken' },
    });
    expect(extractAccessToken(req)).toBe('CaseToken');
  });
});

describe('auth leftovers requireAuth failure matrix after #147', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('M_MISSING_TOKEN errcode/status contract', async () => {
    const next = vi.fn();
    const res = (await requireAuth()(makeAuthCtx({ db: createAuthDb() }), next)) as Response;
    expect(await jsonBody(res)).toEqual({
      errcode: 'M_MISSING_TOKEN',
      error: expect.any(String),
      status: 401,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('M_UNKNOWN_TOKEN errcode/status contract for garbage bearer', async () => {
    const next = vi.fn();
    const res = (await requireAuth()(
      makeAuthCtx({
        db: createAuthDb(),
        headers: { Authorization: 'Bearer nope' },
      }),
      next
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', status: 401 });
  });

  it('valid query-only user token sets context', async () => {
    const token = 'syt_query_ok';
    const hash = await hashToken(token);
    const db = createAuthDb({
      tokens: new Map([[hash, { user_id: `@alice:${SERVER}`, device_id: 'DQ' }]]),
    });
    const ctx = makeAuthCtx({
      db,
      url: `https://${SERVER}/_matrix/client/v3/sync?access_token=${token}`,
    });
    const next = vi.fn(async () => 'ok');
    await expect(requireAuth()(ctx, next)).resolves.toBe('ok');
    expect(ctx.get('userId')).toBe(`@alice:${SERVER}`);
    expect(ctx.get('deviceId')).toBe('DQ');
  });

  it('AS token + no user_id → @sender_localpart:SERVER_NAME with null deviceId', async () => {
    const db = createAuthDb({
      appservices: new Map([
        [
          'as_tok',
          asRow({ as_token: 'as_tok', sender_localpart: 'bridge', namespaces: JSON.stringify({ users: [] }) }),
        ],
      ]),
    });
    const ctx = makeAuthCtx({
      db,
      headers: { Authorization: 'Bearer as_tok' },
    });
    const next = vi.fn(async () => 'as');
    await expect(requireAuth()(ctx, next)).resolves.toBe('as');
    expect(ctx.get('userId')).toBe(`@bridge:${SERVER}`);
    expect(ctx.get('deviceId')).toBeNull();
  });

  it('AS foreign SERVER_NAME mismatch → M_FORBIDDEN', async () => {
    const db = createAuthDb({
      appservices: new Map([['as_tok', asRow({ as_token: 'as_tok', sender_localpart: 'bot' })]]),
    });
    const res = (await requireAuth()(
      makeAuthCtx({
        db,
        serverName: SERVER,
        url: `https://${SERVER}/_matrix/client/v3/sync?user_id=${encodeURIComponent('@bot:other.example')}`,
        headers: { Authorization: 'Bearer as_tok' },
      }),
      vi.fn()
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({ errcode: 'M_FORBIDDEN', status: 403 });
  });

  it('AS user_id uppercase localpart rejected as invalid format', async () => {
    const db = createAuthDb({
      appservices: new Map([['as_tok', asRow({ as_token: 'as_tok', sender_localpart: 'bot' })]]),
    });
    const res = (await requireAuth()(
      makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent('@BOT_Alice:' + SERVER)}`,
        headers: { Authorization: 'Bearer as_tok' },
      }),
      vi.fn()
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({ errcode: 'M_FORBIDDEN', status: 403 });
  });

  it('AS user_id with emoji rejected', async () => {
    const db = createAuthDb({
      appservices: new Map([['as_tok', asRow({ as_token: 'as_tok', sender_localpart: 'bot' })]]),
    });
    const res = (await requireAuth()(
      makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent('@bot😀:' + SERVER)}`,
        headers: { Authorization: 'Bearer as_tok' },
      }),
      vi.fn()
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('AS namespace exclusive regex allow/deny', async () => {
    const namespaces = JSON.stringify({
      users: [{ exclusive: true, regex: '@bridge_.*:' + SERVER.replace(/\./g, '\\.') }],
    });
    const db = createAuthDb({
      appservices: new Map([
        ['as_tok', asRow({ as_token: 'as_tok', sender_localpart: 'bridge', namespaces })],
      ]),
    });
    const allow = makeAuthCtx({
      db,
      url: `https://${SERVER}/sync?user_id=${encodeURIComponent('@bridge_1:' + SERVER)}`,
      headers: { Authorization: 'Bearer as_tok' },
    });
    const next = vi.fn(async () => 'yes');
    await expect(requireAuth()(allow, next)).resolves.toBe('yes');

    const deny = (await requireAuth()(
      makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent('@other_1:' + SERVER)}`,
        headers: { Authorization: 'Bearer as_tok' },
      }),
      vi.fn()
    )) as Response;
    expect(await jsonBody(deny)).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('invalid namespace regex treated as not allowed → M_FORBIDDEN', async () => {
    const namespaces = JSON.stringify({
      users: [{ exclusive: true, regex: '(unclosed' }],
    });
    const db = createAuthDb({
      appservices: new Map([
        ['as_tok', asRow({ as_token: 'as_tok', sender_localpart: 'bot', namespaces })],
      ]),
    });
    const res = (await requireAuth()(
      makeAuthCtx({
        db,
        url: `https://${SERVER}/sync?user_id=${encodeURIComponent('@bot:' + SERVER)}`,
        headers: { Authorization: 'Bearer as_tok' },
      }),
      vi.fn()
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('throwOnAs continues to M_UNKNOWN_TOKEN (not 500)', async () => {
    const db = createAuthDb({ throwOnAs: true });
    const res = (await requireAuth()(
      makeAuthCtx({
        db,
        headers: { Authorization: 'Bearer as_maybe' },
      }),
      vi.fn()
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', status: 401 });
  });

  it('query-only AS token works without Bearer header', async () => {
    const db = createAuthDb({
      appservices: new Map([
        [
          'as_q',
          asRow({
            as_token: 'as_q',
            sender_localpart: 'hook',
            namespaces: JSON.stringify({ users: [] }),
          }),
        ],
      ]),
    });
    const ctx = makeAuthCtx({
      db,
      url: `https://${SERVER}/sync?access_token=as_q`,
    });
    const next = vi.fn(async () => 'qas');
    await expect(requireAuth()(ctx, next)).resolves.toBe('qas');
    expect(ctx.get('userId')).toBe(`@hook:${SERVER}`);
  });

  it('deviceId null from token row preserved on requireAuth', async () => {
    const token = 'syt_null_dev';
    const hash = await hashToken(token);
    const db = createAuthDb({
      tokens: new Map([[hash, { user_id: `@alice:${SERVER}`, device_id: null }]]),
    });
    const ctx = makeAuthCtx({
      db,
      headers: { Authorization: `Bearer ${token}` },
    });
    await requireAuth()(ctx, vi.fn(async () => undefined));
    expect(ctx.get('deviceId')).toBeNull();
  });
});

describe('auth leftovers optionalAuth after #147', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invalid bearer still calls next and leaves context unset', async () => {
    const ctx = makeAuthCtx({
      db: createAuthDb(),
      headers: { Authorization: 'Bearer bad' },
    });
    const next = vi.fn(async () => 'cont');
    await expect(optionalAuth()(ctx, next)).resolves.toBe('cont');
    expect(ctx.get('userId')).toBeUndefined();
    expect(ctx.get('auth')).toBeUndefined();
  });

  it('valid bearer sets auth without AS fallback attempt on miss path', async () => {
    const token = 'syt_opt';
    const hash = await hashToken(token);
    const db = createAuthDb({
      tokens: new Map([[hash, { user_id: `@alice:${SERVER}`, device_id: 'D' }]]),
      appservices: new Map([['as_should_not_use', asRow({ as_token: 'as_should_not_use', sender_localpart: 'x' })]]),
    });
    const ctx = makeAuthCtx({
      db,
      headers: { Authorization: `Bearer ${token}` },
    });
    await optionalAuth()(ctx, vi.fn(async () => undefined));
    expect(ctx.get('userId')).toBe(`@alice:${SERVER}`);
  });

  it('AS-only token via optionalAuth does not impersonate (user-token path only)', async () => {
    const db = createAuthDb({
      appservices: new Map([
        ['as_only', asRow({ as_token: 'as_only', sender_localpart: 'bridge', namespaces: JSON.stringify({ users: [] }) })],
      ]),
    });
    const ctx = makeAuthCtx({
      db,
      headers: { Authorization: 'Bearer as_only' },
    });
    const next = vi.fn(async () => 'opt');
    await expect(optionalAuth()(ctx, next)).resolves.toBe('opt');
    expect(ctx.get('userId')).toBeUndefined();
  });
});

describe('auth leftovers concurrent token isolation after #147', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('two distinct tokens isolate user contexts', async () => {
    const t1 = 'syt_a';
    const t2 = 'syt_b';
    const h1 = await hashToken(t1);
    const h2 = await hashToken(t2);
    const db = createAuthDb({
      tokens: new Map([
        [h1, { user_id: `@a:${SERVER}`, device_id: 'DA' }],
        [h2, { user_id: `@b:${SERVER}`, device_id: 'DB' }],
      ]),
    });
    const ctx1 = makeAuthCtx({ db, headers: { Authorization: `Bearer ${t1}` } });
    const ctx2 = makeAuthCtx({ db, headers: { Authorization: `Bearer ${t2}` } });
    await Promise.all([
      requireAuth()(ctx1, vi.fn(async () => undefined)),
      requireAuth()(ctx2, vi.fn(async () => undefined)),
    ]);
    expect(ctx1.get('userId')).toBe(`@a:${SERVER}`);
    expect(ctx2.get('userId')).toBe(`@b:${SERVER}`);
    expect(ctx1.get('deviceId')).toBe('DA');
    expect(ctx2.get('deviceId')).toBe('DB');
  });
});
