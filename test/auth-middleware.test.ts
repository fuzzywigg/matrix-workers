import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateAccessToken,
  requireAuth,
  optionalAuth,
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

describe('validateAccessToken', () => {
  it('returns auth context when token hash hits D1', async () => {
    const token = 'syt_valid_user_token';
    const hash = await hashToken(token);
    const db = createAuthDb({
      tokens: new Map([[hash, { user_id: `@alice:${SERVER}`, device_id: 'DEVICE' }]]),
    });
    await expect(validateAccessToken(db, token)).resolves.toEqual({
      userId: `@alice:${SERVER}`,
      deviceId: 'DEVICE',
      accessToken: token,
    });
  });

  it('returns null on token miss', async () => {
    const db = createAuthDb();
    await expect(validateAccessToken(db, 'nope')).resolves.toBeNull();
  });

  it('preserves null device_id from the access_tokens row', async () => {
    const token = 'syt_null_device';
    const hash = await hashToken(token);
    const db = createAuthDb({
      tokens: new Map([[hash, { user_id: `@bob:${SERVER}`, device_id: null }]]),
    });
    await expect(validateAccessToken(db, token)).resolves.toEqual({
      userId: `@bob:${SERVER}`,
      deviceId: null,
      accessToken: token,
    });
  });
});

describe('requireAuth', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns M_MISSING_TOKEN when no token is present', async () => {
    const next = vi.fn();
    const res = (await requireAuth()(makeAuthCtx({ db: createAuthDb() }), next)) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(await jsonBody(res)).toMatchObject({
      status: 401,
      errcode: 'M_MISSING_TOKEN',
    });
  });

  it('sets context and calls next for a valid user token', async () => {
    const token = 'syt_ok';
    const hash = await hashToken(token);
    const db = createAuthDb({
      tokens: new Map([[hash, { user_id: `@alice:${SERVER}`, device_id: 'D1' }]]),
    });
    const ctx = makeAuthCtx({
      db,
      headers: { Authorization: `Bearer ${token}` },
    });
    const next = vi.fn(async () => 'ok');
    await expect(requireAuth()(ctx, next)).resolves.toBe('ok');
    expect(ctx.get('userId')).toBe(`@alice:${SERVER}`);
    expect(ctx.get('deviceId')).toBe('D1');
    expect(ctx.get('accessToken')).toBe(token);
    expect(ctx.get('auth')).toEqual({
      userId: `@alice:${SERVER}`,
      deviceId: 'D1',
      accessToken: token,
    });
  });

  it('returns M_UNKNOWN_TOKEN when user and AS lookups both miss', async () => {
    const next = vi.fn();
    const res = (await requireAuth()(
      makeAuthCtx({
        db: createAuthDb(),
        headers: { Authorization: 'Bearer garbage' },
      }),
      next
    )) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(await jsonBody(res)).toMatchObject({
      status: 401,
      errcode: 'M_UNKNOWN_TOKEN',
    });
  });

  it('impersonates a namespaced local user_id via AS token', async () => {
    const asToken = 'as_secret';
    const db = createAuthDb({
      appservices: new Map([[asToken, asRow({ as_token: asToken, sender_localpart: 'bridge' })]]),
    });
    const ctx = makeAuthCtx({
      db,
      url: `https://${SERVER}/_matrix/client/v3/sync?user_id=@bot_alice:${SERVER}`,
      headers: { Authorization: `Bearer ${asToken}` },
    });
    const next = vi.fn(async () => 'as-ok');
    await expect(requireAuth()(ctx, next)).resolves.toBe('as-ok');
    expect(ctx.get('userId')).toBe(`@bot_alice:${SERVER}`);
    expect(ctx.get('deviceId')).toBeNull();
  });

  it('rejects invalid AS user_id format', async () => {
    const asToken = 'as_secret';
    const db = createAuthDb({
      appservices: new Map([[asToken, asRow({ as_token: asToken, sender_localpart: 'bridge' })]]),
    });
    const next = vi.fn();
    const res = (await requireAuth()(
      makeAuthCtx({
        db,
        url: `https://${SERVER}/_matrix/client/v3/sync?user_id=@Bad`,
        headers: { Authorization: `Bearer ${asToken}` },
      }),
      next
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({
      status: 403,
      errcode: 'M_FORBIDDEN',
      error: 'Invalid user_id format',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects AS impersonation of foreign-server users', async () => {
    const asToken = 'as_secret';
    const db = createAuthDb({
      appservices: new Map([[asToken, asRow({ as_token: asToken, sender_localpart: 'bridge' })]]),
    });
    const next = vi.fn();
    const res = (await requireAuth()(
      makeAuthCtx({
        db,
        url: `https://${SERVER}/_matrix/client/v3/sync?user_id=@bot_alice:other.example.com`,
        headers: { Authorization: `Bearer ${asToken}` },
      }),
      next
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({
      status: 403,
      errcode: 'M_FORBIDDEN',
      error: 'Cannot impersonate users on other servers',
    });
  });

  it('rejects AS user_id outside registered namespaces', async () => {
    const asToken = 'as_secret';
    const db = createAuthDb({
      appservices: new Map([[asToken, asRow({ as_token: asToken, sender_localpart: 'bridge' })]]),
    });
    const next = vi.fn();
    const res = (await requireAuth()(
      makeAuthCtx({
        db,
        url: `https://${SERVER}/_matrix/client/v3/sync?user_id=@alice:${SERVER}`,
        headers: { Authorization: `Bearer ${asToken}` },
      }),
      next
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({
      status: 403,
      errcode: 'M_FORBIDDEN',
      error: 'User not in application service namespace',
    });
  });

  it('treats invalid namespace regex as not allowed (catch → false)', async () => {
    const asToken = 'as_bad_re';
    const db = createAuthDb({
      appservices: new Map([
        [
          asToken,
          asRow({
            as_token: asToken,
            sender_localpart: 'bridge',
            namespaces: JSON.stringify({
              users: [{ exclusive: true, regex: '[unterminated' }],
              rooms: [],
              aliases: [],
            }),
          }),
        ],
      ]),
    });
    const next = vi.fn();
    const res = (await requireAuth()(
      makeAuthCtx({
        db,
        url: `https://${SERVER}/_matrix/client/v3/sync?user_id=@bot_x:${SERVER}`,
        headers: { Authorization: `Bearer ${asToken}` },
      }),
      next
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({
      status: 403,
      errcode: 'M_FORBIDDEN',
      error: 'User not in application service namespace',
    });
  });

  it('allows AS user_id when namespaces.users is empty', async () => {
    const asToken = 'as_open';
    const db = createAuthDb({
      appservices: new Map([
        [
          asToken,
          asRow({
            as_token: asToken,
            sender_localpart: 'bridge',
            namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
          }),
        ],
      ]),
    });
    const ctx = makeAuthCtx({
      db,
      url: `https://${SERVER}/_matrix/client/v3/sync?user_id=@anyone:${SERVER}`,
      headers: { Authorization: `Bearer ${asToken}` },
    });
    const next = vi.fn(async () => 'open');
    await expect(requireAuth()(ctx, next)).resolves.toBe('open');
    expect(ctx.get('userId')).toBe(`@anyone:${SERVER}`);
  });

  it('falls back to @sender_localpart:SERVER when AS token has no user_id', async () => {
    const asToken = 'as_sender';
    const db = createAuthDb({
      appservices: new Map([[asToken, asRow({ as_token: asToken, sender_localpart: 'hookshot' })]]),
    });
    const ctx = makeAuthCtx({
      db,
      headers: { Authorization: `Bearer ${asToken}` },
    });
    const next = vi.fn(async () => 'sender');
    await expect(requireAuth()(ctx, next)).resolves.toBe('sender');
    expect(ctx.get('userId')).toBe(`@hookshot:${SERVER}`);
    expect(ctx.get('deviceId')).toBeNull();
  });

  it('continues to M_UNKNOWN_TOKEN when AS lookup throws', async () => {
    const next = vi.fn();
    const res = (await requireAuth()(
      makeAuthCtx({
        db: createAuthDb({ throwOnAs: true }),
        headers: { Authorization: 'Bearer as_or_user' },
      }),
      next
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({
      status: 401,
      errcode: 'M_UNKNOWN_TOKEN',
    });
    expect(console.warn).toHaveBeenCalled();
  });

  it('accepts access_token query param for user tokens', async () => {
    const token = 'syt_query';
    const hash = await hashToken(token);
    const db = createAuthDb({
      tokens: new Map([[hash, { user_id: `@q:${SERVER}`, device_id: 'Q' }]]),
    });
    const ctx = makeAuthCtx({
      db,
      url: `https://${SERVER}/_matrix/client/v3/sync?access_token=${token}`,
    });
    const next = vi.fn(async () => 'q');
    await expect(requireAuth()(ctx, next)).resolves.toBe('q');
    expect(ctx.get('userId')).toBe(`@q:${SERVER}`);
  });

  it('rejects AS user_id whose server part contains a port (format regex)', async () => {
    // Format check is /^@[a-z0-9._=/+-]+:[a-zA-Z0-9.-]+$/ — a second ':' fails before the server compare
    const local = 'matrix.example.com:8448';
    const asToken = 'as_port';
    const db = createAuthDb({
      appservices: new Map([
        [
          asToken,
          asRow({
            as_token: asToken,
            sender_localpart: 'bridge',
            namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
          }),
        ],
      ]),
    });
    const next = vi.fn();
    const res = (await requireAuth()(
      makeAuthCtx({
        db,
        serverName: local,
        url: `https://example.com/_matrix/client/v3/sync?user_id=@bot:${local}`,
        headers: { Authorization: `Bearer ${asToken}` },
      }),
      next
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({
      status: 403,
      errcode: 'M_FORBIDDEN',
      error: 'Invalid user_id format',
    });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('optionalAuth', () => {
  it('always calls next with no token and leaves context unset', async () => {
    const ctx = makeAuthCtx({ db: createAuthDb() });
    const next = vi.fn(async () => 'anon');
    await expect(optionalAuth()(ctx, next)).resolves.toBe('anon');
    expect(ctx.get('userId')).toBeUndefined();
    expect(ctx.get('auth')).toBeUndefined();
  });

  it('calls next without setting context when token is invalid', async () => {
    const ctx = makeAuthCtx({
      db: createAuthDb(),
      headers: { Authorization: 'Bearer nope' },
    });
    const next = vi.fn(async () => 'invalid');
    await expect(optionalAuth()(ctx, next)).resolves.toBe('invalid');
    expect(ctx.get('userId')).toBeUndefined();
  });

  it('sets auth context when token is valid', async () => {
    const token = 'syt_opt';
    const hash = await hashToken(token);
    const db = createAuthDb({
      tokens: new Map([[hash, { user_id: `@opt:${SERVER}`, device_id: 'OD' }]]),
    });
    const ctx = makeAuthCtx({
      db,
      headers: { Authorization: `Bearer ${token}` },
    });
    const next = vi.fn(async () => 'opt');
    await expect(optionalAuth()(ctx, next)).resolves.toBe('opt');
    expect(ctx.get('userId')).toBe(`@opt:${SERVER}`);
    expect(ctx.get('deviceId')).toBe('OD');
    expect(ctx.get('accessToken')).toBe(token);
  });

  it('does not attempt AS impersonation (user-token path only)', async () => {
    const asToken = 'as_only';
    const db = createAuthDb({
      appservices: new Map([[asToken, asRow({ as_token: asToken, sender_localpart: 'bridge' })]]),
    });
    const ctx = makeAuthCtx({
      db,
      url: `https://${SERVER}/_matrix/client/v3/sync?user_id=@bot_alice:${SERVER}`,
      headers: { Authorization: `Bearer ${asToken}` },
    });
    const next = vi.fn(async () => 'no-as');
    await expect(optionalAuth()(ctx, next)).resolves.toBe('no-as');
    expect(ctx.get('userId')).toBeUndefined();
  });
});
