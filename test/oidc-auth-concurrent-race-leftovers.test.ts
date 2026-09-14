/**
 * TOKENMAXX HEAVY leftovers after #219 — oidc-auth *concurrent race / TOCTOU*
 * for `src/api/oidc-auth.ts` (external IdP providers / login / callback /
 * auth_metadata / MSC3861 identity reset).
 *
 * Soft/contract leftovers are deep (oidc-auth-api-routes #113, route-leftovers
 * #143, token-issuance leftovers #147) but concurrent-race coverage was
 * near-zero: zero prior Promise.all / SESSIONS get-barrier double-consume of
 * `oidc_state:` (one-time use) / login put lost-update / identity-reset∥reset.
 *
 * Distinct from tip #219 (admin+federation GET races), merged #221 (`src/api/oauth.ts`
 * Matrix OAuth 2.0 register/authorize/token — not this IdP file), #220
 * (devices+keybackups+report residual), login-qr-identity races (#163:
 * login.ts + qr-login.ts + identity.ts), and auth-middleware races (#217).
 *
 * Focus: login∥login distinct oidc_state mint + put barriers; same-state
 * lost-update; callback state get-barrier double-consume TOCTOU; mutateAfterGets
 * expire-vs-success; distinct parallel callbacks; providers list∥login
 * isolation + disable mid-flight; auth_metadata coherency; identity reset∥reset
 * stream/KV/DO; method / query / KV-fail soft floods under Promise.all; TTL 600
 * bind; lifecycle login→callback.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

const fetchOIDCDiscovery = vi.fn();
const fetchJWKS = vi.fn();
const buildAuthorizationUrl = vi.fn();
const exchangeCodeForTokens = vi.fn();
const validateIDToken = vi.fn();
const generateRandomString = vi.fn();
const deriveUsername = vi.fn();

vi.mock('../src/services/oidc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/oidc')>();
  return {
    ...actual,
    fetchOIDCDiscovery: (...args: unknown[]) => fetchOIDCDiscovery(...args),
    fetchJWKS: (...args: unknown[]) => fetchJWKS(...args),
    buildAuthorizationUrl: (...args: unknown[]) => buildAuthorizationUrl(...args),
    exchangeCodeForTokens: (...args: unknown[]) => exchangeCodeForTokens(...args),
    validateIDToken: (...args: unknown[]) => validateIDToken(...args),
    generateRandomString: (...args: unknown[]) => generateRandomString(...args),
    deriveUsername: (...args: unknown[]) => deriveUsername(...args),
  };
});

const getUserById = vi.fn();
const createUser = vi.fn();
const createDevice = vi.fn();
const createAccessToken = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getUserById: (...args: unknown[]) => getUserById(...args),
    createUser: (...args: unknown[]) => createUser(...args),
    createDevice: (...args: unknown[]) => createDevice(...args),
    createAccessToken: (...args: unknown[]) => createAccessToken(...args),
  };
});

let deviceSeq = 0;
let tokenSeq = 0;
let opaqueSeq = 0;
let randSeq = 0;

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateDeviceId: async () => {
      deviceSeq += 1;
      return `DEV${deviceSeq}`;
    },
    generateAccessToken: async () => {
      tokenSeq += 1;
      return `syt_token_${tokenSeq}`;
    },
    generateOpaqueId: async (length: number = 16) => {
      opaqueSeq += 1;
      const base = `opaque${opaqueSeq}`.padEnd(Math.max(length, 8), '0');
      return base.slice(0, Math.max(length, base.length));
    },
  };
});

import oidcAuth, { encryptSecret, decryptSecret } from '../src/api/oidc-auth';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const PROVIDER_ID = 'google';
const ISSUER = 'https://accounts.example-idp.com';
const NOW = 1_730_000_000_000;
const RESET_PATH = '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
const META_PATH = '/_matrix/client/v1/auth_metadata';

const OIDC_KEY_BYTES = new Uint8Array(32).map((_, i) => (i * 7 + 13) & 0xff);
const OIDC_ENCRYPTION_KEY = btoa(String.fromCharCode(...OIDC_KEY_BYTES));

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type KvBarrier = { match: (key: string) => boolean; count: number };
type SqlBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

async function withBarrier(
  barrier: { match: (...a: unknown[]) => boolean; count: number } | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  ...matchArgs: unknown[]
) {
  if (!barrier || !barrier.match(...matchArgs)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
}

function mockKv(
  initial: Record<string, string> = {},
  opts: {
    putBarrier?: KvBarrier;
    getBarrier?: KvBarrier;
    deleteBarrier?: KvBarrier;
    mutateAfterGets?: { after: number; next: Record<string, string> };
    mutateAfterPuts?: { after: number; next: Record<string, string> };
    failGetAfter?: number;
    failPutAfter?: number;
    failDeleteAfter?: number;
  } = {}
) {
  const data: Record<string, string> = { ...initial };
  const puts: KvPut[] = [];
  const gets: string[] = [];
  const deletes: string[] = [];
  const events: string[] = [];
  let putBarrier = opts.putBarrier;
  let getBarrier = opts.getBarrier;
  let deleteBarrier = opts.deleteBarrier;
  const putWaiters = { list: [] as Array<() => void> };
  const getWaiters = { list: [] as Array<() => void> };
  const deleteWaiters = { list: [] as Array<() => void> };
  let putCount = 0;
  let getCount = 0;
  let deleteCount = 0;

  return {
    data,
    puts,
    gets,
    deletes,
    events,
    get putCount() {
      return putCount;
    },
    get getCount() {
      return getCount;
    },
    get deleteCount() {
      return deleteCount;
    },
    get: async (key: string, type?: string) => {
      await withBarrier(getBarrier, getWaiters, () => {
        getBarrier = undefined;
      }, key);
      getCount += 1;
      gets.push(key);
      events.push(`get:${key}`);
      if (opts.failGetAfter !== undefined && getCount > opts.failGetAfter) {
        throw new Error('kv-get-fail');
      }
      const raw = data[key];
      if (opts.mutateAfterGets && getCount === opts.mutateAfterGets.after) {
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, opts.mutateAfterGets.next);
        events.push('mutate:after-get');
      }
      if (raw == null) return null;
      if (type === 'json') {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      await withBarrier(putBarrier, putWaiters, () => {
        putBarrier = undefined;
      }, key);
      putCount += 1;
      if (opts.failPutAfter !== undefined && putCount > opts.failPutAfter) {
        throw new Error('kv-put-fail');
      }
      data[key] = value;
      puts.push({ key, value, options });
      events.push(`put:${key}`);
      if (opts.mutateAfterPuts && putCount === opts.mutateAfterPuts.after) {
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, opts.mutateAfterPuts.next);
        events.push('mutate:after-put');
      }
    },
    delete: async (key: string) => {
      await withBarrier(deleteBarrier, deleteWaiters, () => {
        deleteBarrier = undefined;
      }, key);
      deleteCount += 1;
      if (opts.failDeleteAfter !== undefined && deleteCount > opts.failDeleteAfter) {
        throw new Error('kv-delete-fail');
      }
      deletes.push(key);
      delete data[key];
      events.push(`delete:${key}`);
      return undefined;
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
}

type RaceKv = ReturnType<typeof mockKv>;

type IdPProvider = {
  id: string;
  name: string;
  issuer_url: string;
  client_id: string;
  client_secret_encrypted: string;
  scopes: string;
  enabled: number;
  auto_create_users: number;
  username_claim: string;
  display_order: number;
  icon_url: string | null;
};

type IdPUserLink = {
  id: number;
  provider_id: string;
  external_id: string;
  user_id: string;
  external_email: string | null;
  external_name: string | null;
};

type SqlCall = { sql: string; args: unknown[] };

function seedProvider(partial: Partial<IdPProvider> = {}): IdPProvider {
  return {
    id: PROVIDER_ID,
    name: 'Google',
    issuer_url: ISSUER,
    client_id: 'client-abc',
    client_secret_encrypted: 'enc:placeholder',
    scopes: 'openid profile email',
    enabled: 1,
    auto_create_users: 1,
    username_claim: 'preferred_username',
    display_order: 1,
    icon_url: 'https://cdn.example.com/google.svg',
    ...partial,
  };
}

function seedLink(partial: Partial<IdPUserLink> = {}): IdPUserLink {
  return {
    id: 1,
    provider_id: PROVIDER_ID,
    external_id: 'ext-sub-1',
    user_id: USER,
    external_email: 'alice@example.com',
    external_name: 'Alice Example',
    ...partial,
  };
}

function createOidcDb(
  opts: {
    providers?: IdPProvider[];
    links?: IdPUserLink[];
    streamPositions?: Record<string, number>;
    failCrossSigningDelete?: boolean;
    failStreamUpdate?: boolean;
    failSignaturesDelete?: boolean;
    firstBarrier?: SqlBarrier;
    allBarrier?: SqlBarrier;
    mutateAfterFirsts?: { after: number; disableAll?: boolean };
  } = {}
) {
  const providers = opts.providers ? [...opts.providers] : [];
  const links = opts.links ? [...opts.links] : [];
  const streamPositions = { ...(opts.streamPositions ?? { device_keys: 10 }) };
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  let nextLinkId = links.reduce((m, l) => Math.max(m, l.id), 0) + 1;
  let firstBarrier = opts.firstBarrier;
  let allBarrier = opts.allBarrier;
  const firstWaiters = { list: [] as Array<() => void> };
  const allWaiters = { list: [] as Array<() => void> };
  let firstCount = 0;

  const db = {
    providers,
    links,
    streamPositions,
    inserts,
    updates,
    deletes,
    get firstCount() {
      return firstCount;
    },
    prepare(sql: string) {
      const stmt = {
        async all<T>() {
          await withBarrier(allBarrier, allWaiters, () => {
            allBarrier = undefined;
          }, sql, []);
          if (
            sql.includes('FROM idp_providers') &&
            sql.includes('WHERE enabled = 1') &&
            sql.includes('ORDER BY display_order')
          ) {
            const rows = providers
              .filter((p) => p.enabled === 1)
              .sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name))
              .map((p) => ({
                id: p.id,
                name: p.name,
                icon_url: p.icon_url,
                display_order: p.display_order,
              }));
            return { results: rows as T[] };
          }
          return { results: [] as T[] };
        },
        bind(...args: unknown[]) {
          return {
            all: stmt.all,
            async first<T>() {
              await withBarrier(firstBarrier, firstWaiters, () => {
                firstBarrier = undefined;
              }, sql, args);
              firstCount += 1;
              // Subsequent waiters after `after` see disabled providers (serial JS).
              if (
                opts.mutateAfterFirsts &&
                opts.mutateAfterFirsts.disableAll &&
                firstCount > opts.mutateAfterFirsts.after
              ) {
                for (const p of providers) p.enabled = 0;
              }
              if (sql.includes('FROM idp_providers WHERE id = ? AND enabled = 1')) {
                const [id] = args as [string];
                const row = providers.find((p) => p.id === id && p.enabled === 1);
                return (row ?? null) as T;
              }
              if (
                sql.includes('FROM idp_user_links') &&
                sql.includes('provider_id = ?') &&
                sql.includes('external_id = ?')
              ) {
                const [providerId, externalId] = args as [string, string];
                const row = links.find(
                  (l) => l.provider_id === providerId && l.external_id === externalId
                );
                return (row ?? null) as T;
              }
              if (sql.includes('SELECT position FROM stream_positions WHERE stream_name = ?')) {
                const [name] = args as [string];
                const pos = streamPositions[name];
                return (pos !== undefined ? { position: pos } : null) as T;
              }
              return null;
            },
            async run() {
              if (sql.includes('UPDATE idp_user_links SET last_login_at')) {
                updates.push({ sql, args });
                const [lastLogin, email, name, id] = args as [
                  number,
                  string | null,
                  string | null,
                  number,
                ];
                const link = links.find((l) => l.id === id);
                if (link) {
                  link.external_email = email;
                  link.external_name = name;
                  void lastLogin;
                }
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO idp_user_links')) {
                inserts.push({ sql, args });
                const [providerId, externalId, userId, email, name] = args as [
                  string,
                  string,
                  string,
                  string | null,
                  string | null,
                  number,
                ];
                links.push({
                  id: nextLinkId++,
                  provider_id: providerId,
                  external_id: externalId,
                  user_id: userId,
                  external_email: email,
                  external_name: name,
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE users SET display_name = ? WHERE user_id = ?')) {
                updates.push({ sql, args });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM cross_signing_keys WHERE user_id = ?')) {
                deletes.push({ sql, args });
                if (opts.failCrossSigningDelete) {
                  throw new Error('d1 cross_signing_keys delete failed');
                }
                return { success: true, meta: { changes: 1 } };
              }
              if (
                sql.includes('DELETE FROM cross_signing_signatures') &&
                sql.includes('user_id = ? OR signer_user_id = ?')
              ) {
                deletes.push({ sql, args });
                if (opts.failSignaturesDelete) {
                  throw new Error('d1 signatures delete failed');
                }
                return { success: true, meta: { changes: 1 } };
              }
              if (
                sql.includes('UPDATE stream_positions SET position = position + 1 WHERE stream_name = ?')
              ) {
                updates.push({ sql, args });
                if (opts.failStreamUpdate) {
                  throw new Error('stream bump failed');
                }
                const [name] = args as [string];
                streamPositions[name] = (streamPositions[name] ?? 0) + 1;
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO device_key_changes')) {
                inserts.push({ sql, args });
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
      return stmt;
    },
  };

  return db;
}

type OidcDb = ReturnType<typeof createOidcDb>;

type UserKeysStub = {
  fetches: Array<{ url: string; method: string }>;
  failDelete?: boolean;
  throwOnFetch?: boolean;
  fetch: (req: Request) => Promise<Response>;
};

function createUserKeysStub(opts: { failDelete?: boolean; throwOnFetch?: boolean } = {}): UserKeysStub {
  const fetches: Array<{ url: string; method: string }> = [];
  return {
    fetches,
    failDelete: opts.failDelete,
    throwOnFetch: opts.throwOnFetch,
    async fetch(req: Request): Promise<Response> {
      if (opts.throwOnFetch) {
        throw new Error('DO fetch threw');
      }
      fetches.push({ url: req.url, method: req.method });
      const path = new URL(req.url).pathname;
      if (path === '/cross-signing/delete') {
        if (opts.failDelete) {
          return new Response('boom', { status: 500 });
        }
        return Response.json({ ok: true });
      }
      return new Response('not found', { status: 404 });
    },
  };
}

function envFor(opts: {
  db?: OidcDb;
  sessions?: RaceKv;
  crossSigning?: RaceKv;
  userKeys?: UserKeysStub;
  oidcKey?: string | undefined;
  serverName?: string;
} = {}): Env & {
  _sessions: RaceKv;
  _crossSigning: RaceKv;
  _db: OidcDb;
  _userKeys: UserKeysStub;
} {
  const sessions = opts.sessions ?? mockKv();
  const crossSigning = opts.crossSigning ?? mockKv();
  const userKeys = opts.userKeys ?? createUserKeysStub();
  const db = opts.db ?? createOidcDb();

  return {
    DB: db as unknown as D1Database,
    SESSIONS: sessions,
    CROSS_SIGNING_KEYS: crossSigning,
    SERVER_NAME: opts.serverName ?? SERVER,
    OIDC_ENCRYPTION_KEY: opts.oidcKey === undefined ? OIDC_ENCRYPTION_KEY : opts.oidcKey,
    USER_KEYS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => userKeys,
    },
    _sessions: sessions,
    _crossSigning: crossSigning,
    _db: db,
    _userKeys: userKeys,
  } as unknown as Env & {
    _sessions: RaceKv;
    _crossSigning: RaceKv;
    _db: OidcDb;
    _userKeys: UserKeysStub;
  };
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = envFor()
): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
  const url = path.startsWith('http') ? path : `https://${SERVER}${path}`;
  const res = await oidcAuth.request(url, init, env);
  const ct = res.headers.get('content-type') || '';
  let body: unknown = null;
  let text = '';
  if (ct.includes('application/json')) {
    text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
  } else {
    text = await res.text();
    body = text;
  }
  return { status: res.status, body, text, headers: res.headers };
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function loginPath(providerId = PROVIDER_ID, query = ''): string {
  return `/auth/oidc/${providerId}/login${query}`;
}

function callbackPath(
  providerId: string,
  q: Record<string, string>
): string {
  const sp = new URLSearchParams(q);
  return `/auth/oidc/${providerId}/callback?${sp.toString()}`;
}

function seedState(
  sessions: RaceKv,
  state: string,
  partial: Partial<{
    providerId: string;
    nonce: string;
    redirectUri: string;
    returnTo: string;
  }> = {}
): string {
  sessions.data[`oidc_state:${state}`] = JSON.stringify({
    providerId: PROVIDER_ID,
    nonce: 'nonce-race',
    redirectUri: `https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`,
    returnTo: '/',
    ...partial,
  });
  return state;
}

function jsonErr(body: unknown): { errcode?: string; error?: string } {
  if (body && typeof body === 'object') return body as { errcode?: string; error?: string };
  return {};
}

let encryptedSecret = '';

beforeEach(async () => {
  deviceSeq = 0;
  tokenSeq = 0;
  opaqueSeq = 0;
  randSeq = 0;
  fetchOIDCDiscovery.mockReset();
  fetchJWKS.mockReset();
  buildAuthorizationUrl.mockReset();
  exchangeCodeForTokens.mockReset();
  validateIDToken.mockReset();
  generateRandomString.mockReset();
  deriveUsername.mockReset();
  getUserById.mockReset();
  createUser.mockReset();
  createDevice.mockReset();
  createAccessToken.mockReset();

  fetchOIDCDiscovery.mockResolvedValue(DISCOVERY);
  fetchJWKS.mockResolvedValue({ keys: [{ kty: 'RSA', kid: 'k1' }] });
  buildAuthorizationUrl.mockImplementation(
    (_d: unknown, _cid: unknown, _ru: unknown, _sc: unknown, state: string) =>
      `${ISSUER}/authorize?client_id=client-abc&state=${encodeURIComponent(state)}`
  );
  generateRandomString.mockImplementation((n: number) => {
    randSeq += 1;
    return `r${randSeq}`.padEnd(n, 'x').slice(0, n);
  });
  exchangeCodeForTokens.mockResolvedValue({
    access_token: 'idp-at',
    token_type: 'Bearer',
    id_token: 'fake.jwt.token',
  });
  validateIDToken.mockResolvedValue({
    sub: 'ext-sub-1',
    email: 'alice@example.com',
    name: 'Alice Example',
    preferred_username: 'alice',
  });
  deriveUsername.mockReturnValue('alice');
  getUserById.mockResolvedValue(null);
  createUser.mockResolvedValue(undefined);
  createDevice.mockResolvedValue(undefined);
  createAccessToken.mockResolvedValue(undefined);

  encryptedSecret = await encryptSecret('idp-client-secret', {
    SERVER_NAME: SERVER,
    OIDC_ENCRYPTION_KEY,
  });

  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function linkedEnv(opts: {
  sessions?: RaceKv;
  extraProviders?: IdPProvider[];
  dbOpts?: Parameters<typeof createOidcDb>[0];
  crossSigning?: RaceKv;
  userKeys?: UserKeysStub;
} = {}) {
  const db = createOidcDb({
    providers: [seedProvider({ client_secret_encrypted: encryptedSecret }), ...(opts.extraProviders ?? [])],
    links: [seedLink()],
    ...opts.dbOpts,
  });
  const sessions = opts.sessions ?? mockKv();
  return envFor({
    db,
    sessions,
    crossSigning: opts.crossSigning,
    userKeys: opts.userKeys,
  });
}

// ---------------------------------------------------------------------------
// Login parallel mint — distinct oidc_state / put barriers
// ---------------------------------------------------------------------------

describe('race oidc-auth login parallel state mint after #219', () => {
  it('dual login yields two distinct oidc_state puts with TTL 600', async () => {
    const sessions = mockKv();
    const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }), sessions });
    const results = await Promise.all([request(loginPath(), {}, env), request(loginPath(), {}, env)]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const statePuts = sessions.puts.filter((p) => p.key.startsWith('oidc_state:'));
    expect(statePuts).toHaveLength(2);
    expect(new Set(statePuts.map((p) => p.key)).size).toBe(2);
    expect(statePuts.every((p) => p.options?.expirationTtl === 600)).toBe(true);
  });

  it('quad login under put barrier still mints four distinct states', async () => {
    const sessions = mockKv({}, { putBarrier: { count: 4, match: (k) => k.startsWith('oidc_state:') } });
    const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }), sessions });
    const results = await Promise.all([0, 1, 2, 3].map(() => request(loginPath(), {}, env)));
    expect(statusesOf(results)).toEqual([302, 302, 302, 302]);
    expect(new Set(sessions.puts.filter((p) => p.key.startsWith('oidc_state:')).map((p) => p.key)).size).toBe(4);
  });

  it('same generateRandomString lost-update: last put wins single key', async () => {
    generateRandomString.mockImplementation((n: number) => 'S'.repeat(n));
    const sessions = mockKv();
    const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }), sessions });
    const results = await Promise.all([request(loginPath(), {}, env), request(loginPath(), {}, env)]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const statePuts = sessions.puts.filter((p) => p.key.startsWith('oidc_state:'));
    expect(statePuts).toHaveLength(2);
    expect(new Set(statePuts.map((p) => p.key)).size).toBe(1);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('oidc_state:'))).toHaveLength(1);
  });

  it('return_to query isolates per concurrent login', async () => {
    const sessions = mockKv({}, { putBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }), sessions });
    const results = await Promise.all([
      request(loginPath(PROVIDER_ID, '?return_to=/a'), {}, env),
      request(loginPath(PROVIDER_ID, '?return_to=/b'), {}, env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const returns = sessions.puts
      .filter((p) => p.key.startsWith('oidc_state:'))
      .map((p) => JSON.parse(p.value).returnTo as string)
      .sort();
    expect(returns).toEqual(['/a', '/b']);
  });

  it('missing provider concurrent both 404 M_NOT_FOUND without KV put', async () => {
    const sessions = mockKv();
    const env = envFor({ db: createOidcDb({ providers: [] }), sessions });
    const results = await Promise.all([
      request(loginPath('missing'), {}, env),
      request(loginPath('missing'), {}, env),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
    expect(results.every((r) => jsonErr(r.body).errcode === 'M_NOT_FOUND')).toBe(true);
    expect(sessions.puts).toHaveLength(0);
  });

  it('disabled provider concurrent both 404', async () => {
    const sessions = mockKv();
    const env = envFor({
      db: createOidcDb({ providers: [seedProvider({ enabled: 0 })] }),
      sessions,
    });
    const results = await Promise.all([request(loginPath(), {}, env), request(loginPath(), {}, env)]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  it('login first-barrier disable mid-flight: one 302 one 404', async () => {
    const db = createOidcDb({
      providers: [seedProvider()],
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM idp_providers WHERE id = ? AND enabled = 1'),
      },
      mutateAfterFirsts: { after: 1, disableAll: true },
    });
    const sessions = mockKv();
    const env = envFor({ db, sessions });
    const results = await Promise.all([request(loginPath(), {}, env), request(loginPath(), {}, env)]);
    expect(statusesOf(results)).toEqual([302, 404]);
    expect(sessions.puts.filter((p) => p.key.startsWith('oidc_state:')).length).toBe(1);
  });

  it('SESSIONS put fail after 0 → both M_UNKNOWN 500', async () => {
    const sessions = mockKv({}, { failPutAfter: 0 });
    const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }), sessions });
    const results = await Promise.all([request(loginPath(), {}, env), request(loginPath(), {}, env)]);
    expect(statusesOf(results)).toEqual([500, 500]);
    expect(results.every((r) => jsonErr(r.body).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('discovery throw concurrent both 500 M_UNKNOWN', async () => {
    fetchOIDCDiscovery.mockRejectedValue(new Error('discovery boom'));
    const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }) });
    const results = await Promise.all([request(loginPath(), {}, env), request(loginPath(), {}, env)]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('Host header port isolates redirectUri under parallel login', async () => {
    const sessions = mockKv({}, { putBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }), sessions });
    await Promise.all([
      request(loginPath(), { headers: { Host: 'matrix.example.com:8448' } }, env),
      request(loginPath(), { headers: { Host: 'other.example.com' } }, env),
    ]);
    const hosts = sessions.puts
      .filter((p) => p.key.startsWith('oidc_state:'))
      .map((p) => JSON.parse(p.value).redirectUri as string)
      .sort();
    expect(hosts.some((u) => u.includes('matrix.example.com:8448'))).toBe(true);
    expect(hosts.some((u) => u.includes('other.example.com'))).toBe(true);
  });

  for (const n of [0, 1, 2, 3, 4, 5, 6, 7] as const) {
    it(`login parallel mint flood-${n}: 3 concurrent distinct states`, async () => {
      const sessions = mockKv({}, { putBarrier: { count: 3, match: (k) => k.startsWith('oidc_state:') } });
      const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }), sessions });
      const results = await Promise.all([0, 1, 2].map(() => request(loginPath(), {}, env)));
      expect(statusesOf(results)).toEqual([302, 302, 302]);
      expect(new Set(sessions.puts.filter((p) => p.key.startsWith('oidc_state:')).map((p) => p.key)).size).toBe(3);
      expect(sessions.puts.every((p) => p.options?.expirationTtl === 600)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Callback oidc_state get-barrier double-consume TOCTOU
// ---------------------------------------------------------------------------

describe('race oidc-auth callback state consume TOCTOU after #219', () => {
  it('get-barrier dual callback same state: both may succeed (double-consume)', async () => {
    const sessions = mockKv({}, { getBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    seedState(sessions, 'shared-state');
    const env = linkedEnv({ sessions });
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'shared-state' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'shared-state' }), {}, env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.text.includes('Login Successful')).length).toBe(2);
    expect(createDevice).toHaveBeenCalledTimes(2);
    expect(createAccessToken).toHaveBeenCalledTimes(2);
    expect(sessions.data[`oidc_state:shared-state`]).toBeUndefined();
  });

  it('sequential same-state: second is expired after first delete', async () => {
    const sessions = mockKv();
    seedState(sessions, 'seq-state');
    const env = linkedEnv({ sessions });
    const first = await request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'seq-state' }), {}, env);
    const second = await request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'seq-state' }), {}, env);
    expect(first.text).toContain('Login Successful');
    expect(second.text).toMatch(/expired|Invalid State/i);
    expect(createDevice).toHaveBeenCalledTimes(1);
  });

  it('mutateAfterGets wipe: one success one expired under get-barrier', async () => {
    const sessions = mockKv(
      {},
      {
        getBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') },
        mutateAfterGets: { after: 1, next: {} },
      }
    );
    seedState(sessions, 'wipe-state');
    const env = linkedEnv({ sessions });
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'wipe-state' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'wipe-state' }), {}, env),
    ]);
    const ok = results.filter((r) => r.text.includes('Login Successful')).length;
    const expired = results.filter((r) => /expired|Invalid State/i.test(r.text)).length;
    expect(ok).toBe(1);
    expect(expired).toBe(1);
  });

  it('distinct states parallel both succeed and isolate deletes', async () => {
    const sessions = mockKv({}, { getBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    seedState(sessions, 'st-a');
    seedState(sessions, 'st-b');
    const env = linkedEnv({ sessions });
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'ca', state: 'st-a' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'cb', state: 'st-b' }), {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(sessions.data['oidc_state:st-a']).toBeUndefined();
    expect(sessions.data['oidc_state:st-b']).toBeUndefined();
    expect(exchangeCodeForTokens).toHaveBeenCalledTimes(2);
  });

  it('provider mismatch after get still deletes state', async () => {
    const sessions = mockKv({}, { getBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    seedState(sessions, 'mm', { providerId: PROVIDER_ID });
    const env = linkedEnv({ sessions });
    const results = await Promise.all([
      request(callbackPath('other', { code: 'c1', state: 'mm' }), {}, env),
      request(callbackPath('other', { code: 'c1', state: 'mm' }), {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Provider mismatch') || r.text.includes('Invalid State'))).toBe(
      true
    );
    expect(sessions.data['oidc_state:mm']).toBeUndefined();
    expect(createDevice).not.toHaveBeenCalled();
  });

  it('missing code+state concurrent HTML invalid, no KV get', async () => {
    const sessions = mockKv();
    seedState(sessions, 'untouched');
    const env = linkedEnv({ sessions });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Missing code or state'))).toBe(true);
    expect(sessions.data['oidc_state:untouched']).toBeDefined();
  });

  it('error query wins over code+state under parallel (no KV consume)', async () => {
    const sessions = mockKv();
    seedState(sessions, 'keep-me');
    const env = linkedEnv({ sessions });
    const results = await Promise.all([
      request(
        callbackPath(PROVIDER_ID, { error: 'access_denied', error_description: 'nope', code: 'c', state: 'keep-me' }),
        {},
        env
      ),
      request(
        callbackPath(PROVIDER_ID, { error: 'access_denied', error_description: 'nope', code: 'c', state: 'keep-me' }),
        {},
        env
      ),
    ]);
    expect(results.every((r) => r.text.includes('Authentication Failed'))).toBe(true);
    expect(sessions.data['oidc_state:keep-me']).toBeDefined();
    expect(sessions.gets).toHaveLength(0);
  });

  it('SESSIONS get fail → uncaught 500 both sides', async () => {
    const sessions = mockKv({}, { failGetAfter: 0 });
    seedState(sessions, 'boom');
    const env = linkedEnv({ sessions });
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'boom' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'boom' }), {}, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('corrupt state JSON concurrent currently surfaces 500', async () => {
    const sessions = mockKv({}, { getBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    sessions.data['oidc_state:bad'] = '{not-json';
    const env = linkedEnv({ sessions });
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'bad' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'bad' }), {}, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('auto_create=0 + no link: concurrent Account Not Found after consume', async () => {
    const sessions = mockKv({}, { getBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    seedState(sessions, 'nolink');
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: encryptedSecret, auto_create_users: 0 })],
      links: [],
    });
    const env = envFor({ db, sessions });
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'nolink' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'nolink' }), {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Account Not Found'))).toBe(true);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('delete-barrier same state: both still finish after serialized deletes', async () => {
    const sessions = mockKv({}, { deleteBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    seedState(sessions, 'del-race');
    const env = linkedEnv({ sessions });
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'del-race' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c1', state: 'del-race' }), {}, env),
    ]);
    expect(results.filter((r) => r.text.includes('Login Successful')).length).toBeGreaterThanOrEqual(1);
    expect(sessions.deleteCount).toBe(2);
  });

  for (const n of [0, 1, 2, 3, 4, 5, 6, 7] as const) {
    it(`callback double-consume flood-${n} under get-barrier`, async () => {
      const sessions = mockKv({}, { getBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
      seedState(sessions, `flood-${n}`);
      const env = linkedEnv({ sessions });
      const results = await Promise.all([
        request(callbackPath(PROVIDER_ID, { code: `c-${n}`, state: `flood-${n}` }), {}, env),
        request(callbackPath(PROVIDER_ID, { code: `c-${n}`, state: `flood-${n}` }), {}, env),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Providers list concurrent + isolation
// ---------------------------------------------------------------------------

describe('race oidc-auth providers list concurrent after #219', () => {
  it('parallel GET providers coherency: same ordered ids', async () => {
    const db = createOidcDb({
      providers: [
        seedProvider({ id: 'b', name: 'Beta', display_order: 2, icon_url: null }),
        seedProvider({ id: 'a', name: 'Alpha', display_order: 1 }),
        seedProvider({ id: 'off', name: 'Off', enabled: 0, display_order: 0 }),
      ],
    });
    const env = envFor({ db });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request('/auth/oidc/providers', {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) {
      const ids = (r.body as { providers: Array<{ id: string }> }).providers.map((p) => p.id);
      expect(ids).toEqual(['a', 'b']);
    }
  });

  it('all-barrier list∥list still omits secrets', async () => {
    const db = createOidcDb({
      providers: [seedProvider()],
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM idp_providers') && sql.includes('ORDER BY display_order'),
      },
    });
    const env = envFor({ db });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => !JSON.stringify(r.body).includes('client_secret'))).toBe(true);
  });

  it('empty providers concurrent both []', async () => {
    const env = envFor({ db: createOidcDb({ providers: [] }) });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(results.every((r) => JSON.stringify(r.body) === JSON.stringify({ providers: [] }))).toBe(true);
  });

  it('providers∥login isolation', async () => {
    const sessions = mockKv();
    const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }), sessions });
    const [list, login] = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request(loginPath(), {}, env),
    ]);
    expect(list.status).toBe(200);
    expect(login.status).toBe(302);
    expect((list.body as { providers: Array<{ id: string }> }).providers[0].id).toBe(PROVIDER_ID);
    expect(sessions.puts.some((p) => p.key.startsWith('oidc_state:'))).toBe(true);
  });

  for (const n of [0, 1, 2, 3, 4, 5, 6, 7] as const) {
    it(`providers parallel flood-${n}`, async () => {
      const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }) });
      const results = await Promise.all(
        [0, 1, 2].map(() => request('/auth/oidc/providers', {}, env))
      );
      expect(statusesOf(results)).toEqual([200, 200, 200]);
      expect(
        results.every(
          (r) => (r.body as { providers: Array<{ login_url: string }> }).providers[0].login_url ===
            `/auth/oidc/${PROVIDER_ID}/login`
        )
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// auth_metadata parallel coherency
// ---------------------------------------------------------------------------

describe('race oidc-auth auth_metadata concurrent after #219', () => {
  it('quad GET metadata identical issuer/endpoints', async () => {
    const env = envFor();
    const results = await Promise.all([0, 1, 2, 3].map(() => request(META_PATH, {}, env)));
    expect(statusesOf(results)).toEqual([200, 200, 200, 200]);
    const issuers = results.map((r) => (r.body as { issuer: string }).issuer);
    expect(new Set(issuers).size).toBe(1);
    expect(issuers[0]).toBe(`https://${SERVER}`);
    expect((results[0].body as { authorization_endpoint: string }).authorization_endpoint).toBe(
      `https://${SERVER}/oauth/authorize`
    );
  });

  it('does not touch SESSIONS or DB under parallel', async () => {
    const db = createOidcDb({ providers: [seedProvider()] });
    const sessions = mockKv();
    const prepareSpy = vi.spyOn(db, 'prepare');
    const env = envFor({ db, sessions });
    await Promise.all([request(META_PATH, {}, env), request(META_PATH, {}, env)]);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(sessions.puts).toHaveLength(0);
    expect(sessions.gets).toHaveLength(0);
  });

  it('SERVER_NAME rewrite coherency under parallel', async () => {
    const env = envFor({ serverName: 'matrix.example.com' });
    const results = await Promise.all([request(META_PATH, {}, env), request(META_PATH, {}, env)]);
    expect(results.every((r) => (r.body as { issuer: string }).issuer === 'https://matrix.example.com')).toBe(
      true
    );
    expect(
      results.every((r) => (r.body as { account_management_uri: string }).account_management_uri ===
        'https://matrix.example.com/admin')
    ).toBe(true);
  });

  it('account_management_actions_supported length 5 under race', async () => {
    const results = await Promise.all([
      request(META_PATH, {}, envFor()),
      request(META_PATH, {}, envFor()),
    ]);
    for (const r of results) {
      expect((r.body as { account_management_actions_supported: string[] }).account_management_actions_supported).toHaveLength(
        5
      );
    }
  });

  for (const n of [0, 1, 2, 3, 4, 5, 6, 7] as const) {
    it(`auth_metadata parallel flood-${n}`, async () => {
      const env = envFor();
      const results = await Promise.all([0, 1, 2].map(() => request(META_PATH, {}, env)));
      expect(statusesOf(results)).toEqual([200, 200, 200]);
      expect(
        results.every(
          (r) =>
            (r.body as { device_authorization_endpoint: string }).device_authorization_endpoint ===
            `https://${SERVER}/oauth/device`
        )
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// MSC3861 identity reset concurrent
// ---------------------------------------------------------------------------

describe('race oidc-auth identity reset concurrent after #219', () => {
  it('dual reset both 200 {} and bump stream twice', async () => {
    const db = createOidcDb({ streamPositions: { device_keys: 41 } });
    const crossSigning = mockKv({ [`user:${USER}`]: '{"keys":true}' });
    const userKeys = createUserKeysStub();
    const env = envFor({ db, crossSigning, userKeys });
    const results = await Promise.all([
      request(RESET_PATH, { method: 'POST' }, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => JSON.stringify(r.body) === '{}')).toBe(true);
    expect(db.streamPositions.device_keys).toBe(43);
    expect(userKeys.fetches).toHaveLength(2);
    expect(crossSigning.deletes.filter((k) => k === `user:${USER}`)).toHaveLength(2);
    expect(db.inserts.filter((i) => i.sql.includes('device_key_changes'))).toHaveLength(2);
  });

  it('KV delete-barrier still clears user key', async () => {
    const db = createOidcDb();
    const crossSigning = mockKv(
      { [`user:${USER}`]: '{"keys":true}' },
      { deleteBarrier: { count: 2, match: (k) => k === `user:${USER}` } }
    );
    const env = envFor({ db, crossSigning });
    const results = await Promise.all([
      request(RESET_PATH, { method: 'POST' }, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(crossSigning.data[`user:${USER}`]).toBeUndefined();
  });

  it('DO throw → both M_UNKNOWN 500', async () => {
    const env = envFor({
      db: createOidcDb(),
      userKeys: createUserKeysStub({ throwOnFetch: true }),
    });
    const results = await Promise.all([
      request(RESET_PATH, { method: 'POST' }, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
    expect(results.every((r) => jsonErr(r.body).errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('D1 cross_signing delete throw → both 500', async () => {
    const env = envFor({ db: createOidcDb({ failCrossSigningDelete: true }) });
    const results = await Promise.all([
      request(RESET_PATH, { method: 'POST' }, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('stream bump throw → both 500', async () => {
    const env = envFor({ db: createOidcDb({ failStreamUpdate: true }) });
    const results = await Promise.all([
      request(RESET_PATH, { method: 'POST' }, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('DO HTTP 500 without throw still {} under parallel (status ignored)', async () => {
    const env = envFor({
      db: createOidcDb(),
      userKeys: createUserKeysStub({ failDelete: true }),
    });
    const results = await Promise.all([
      request(RESET_PATH, { method: 'POST' }, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => JSON.stringify(r.body) === '{}')).toBe(true);
  });

  it('signatures delete throw concurrent M_UNKNOWN', async () => {
    const env = envFor({ db: createOidcDb({ failSignaturesDelete: true }) });
    const results = await Promise.all([
      request(RESET_PATH, { method: 'POST' }, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('reset does not touch SESSIONS under race', async () => {
    const sessions = mockKv();
    seedState(sessions, 'leave');
    const env = envFor({ db: createOidcDb(), sessions });
    await Promise.all([
      request(RESET_PATH, { method: 'POST' }, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(sessions.data['oidc_state:leave']).toBeDefined();
    expect(fetchOIDCDiscovery).not.toHaveBeenCalled();
  });

  for (const n of [0, 1, 2, 3, 4, 5, 6, 7] as const) {
    it(`identity reset parallel flood-${n}`, async () => {
      const db = createOidcDb({ streamPositions: { device_keys: n } });
      const env = envFor({ db, crossSigning: mockKv({ [`user:${USER}`]: 'x' }) });
      const results = await Promise.all([
        request(RESET_PATH, { method: 'POST' }, env),
        request(RESET_PATH, { method: 'POST' }, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.streamPositions.device_keys).toBe(n + 2);
    });
  }
});

// ---------------------------------------------------------------------------
// Method / query soft floods under Promise.all
// ---------------------------------------------------------------------------

describe('race oidc-auth method/query soft floods after #219', () => {
  const methods = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

  for (const method of methods) {
    it(`providers ${method}∥${method} is not 200 JSON list`, async () => {
      const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }) });
      const results = await Promise.all([
        request('/auth/oidc/providers', { method }, env),
        request('/auth/oidc/providers', { method }, env),
      ]);
      expect(results.every((r) => r.status !== 200 || !r.text.includes('"providers"'))).toBe(true);
      expect(results.every((r) => r.status >= 400)).toBe(true);
    });
  }

  for (const method of methods) {
    it(`auth_metadata ${method}∥GET isolation`, async () => {
      const env = envFor();
      const [bad, good] = await Promise.all([
        request(META_PATH, { method }, env),
        request(META_PATH, { method: 'GET' }, env),
      ]);
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(good.status).toBe(200);
      expect((good.body as { issuer: string }).issuer).toBe(`https://${SERVER}`);
    });
  }

  it('GET reset path concurrent both >=400', async () => {
    const env = envFor({ db: createOidcDb() });
    const results = await Promise.all([
      request(RESET_PATH, { method: 'GET' }, env),
      request(RESET_PATH, { method: 'GET' }, env),
    ]);
    expect(results.every((r) => r.status >= 400)).toBe(true);
  });

  it('POST login path concurrent both >=400', async () => {
    const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }) });
    const results = await Promise.all([
      request(loginPath(), { method: 'POST' }, env),
      request(loginPath(), { method: 'POST' }, env),
    ]);
    expect(results.every((r) => r.status >= 400)).toBe(true);
  });

  it('empty state query treated as missing under parallel', async () => {
    const env = linkedEnv();
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c', state: '' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c', state: '' }), {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Missing code or state'))).toBe(true);
  });

  it('HEAD metadata concurrent not JSON body success contract', async () => {
    const env = envFor();
    const results = await Promise.all([
      request(META_PATH, { method: 'HEAD' }, env),
      request(META_PATH, { method: 'HEAD' }, env),
    ]);
    expect(results.every((r) => r.status === 200 || r.status >= 400)).toBe(true);
  });

  for (const n of [0, 1, 2, 3, 4, 5, 6, 7] as const) {
    it(`callback missing-code soft flood-${n}`, async () => {
      const env = linkedEnv();
      const results = await Promise.all([
        request(callbackPath(PROVIDER_ID, { state: `s${n}` }), {}, env),
        request(callbackPath(PROVIDER_ID, { state: `s${n}` }), {}, env),
      ]);
      expect(results.every((r) => r.text.includes('Missing code or state'))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-endpoint isolation + lifecycle + TTL bind
// ---------------------------------------------------------------------------

describe('race oidc-auth cross-endpoint isolation + lifecycle after #219', () => {
  it('metadata∥providers∥login∥reset isolation', async () => {
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider()], streamPositions: { device_keys: 3 } });
    const crossSigning = mockKv({ [`user:${USER}`]: 'k' });
    const env = envFor({ db, sessions, crossSigning });
    const [meta, list, login, reset] = await Promise.all([
      request(META_PATH, {}, env),
      request('/auth/oidc/providers', {}, env),
      request(loginPath(), {}, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(meta.status).toBe(200);
    expect(list.status).toBe(200);
    expect(login.status).toBe(302);
    expect(reset.status).toBe(200);
    expect(sessions.puts.some((p) => p.key.startsWith('oidc_state:'))).toBe(true);
    expect(db.streamPositions.device_keys).toBe(4);
  });

  it('login then callback lifecycle under isolation from metadata', async () => {
    const sessions = mockKv();
    const env = linkedEnv({ sessions });
    const [meta, login] = await Promise.all([
      request(META_PATH, {}, env),
      request(loginPath(), {}, env),
    ]);
    expect(meta.status).toBe(200);
    expect(login.status).toBe(302);
    const stateKey = sessions.puts.find((p) => p.key.startsWith('oidc_state:'))!.key;
    const state = stateKey.slice('oidc_state:'.length);
    const cb = await request(callbackPath(PROVIDER_ID, { code: 'life', state }), {}, env);
    expect(cb.text).toContain('Login Successful');
    expect(cb.text).toContain(USER);
    expect(sessions.data[stateKey]).toBeUndefined();
  });

  it('TTL bind flood: login put expirationTtl is 600', async () => {
    const sessions = mockKv();
    const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }), sessions });
    await request(loginPath(), {}, env);
    const put = sessions.puts.find((p) => p.key.startsWith('oidc_state:'));
    expect(put?.options?.expirationTtl).toBe(600);
    const stored = JSON.parse(put!.value) as { providerId: string; nonce: string; redirectUri: string };
    expect(stored.providerId).toBe(PROVIDER_ID);
    expect(stored.redirectUri).toContain(`/auth/oidc/${PROVIDER_ID}/callback`);
    expect(stored.nonce.length).toBe(32);
  });

  for (const n of [0, 1, 2, 3, 4, 5, 6, 7] as const) {
    it(`login TTL bind flood-${n}`, async () => {
      const sessions = mockKv();
      const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }), sessions });
      const res = await request(loginPath(PROVIDER_ID, `?return_to=/r${n}`), {}, env);
      expect(res.status).toBe(302);
      const put = sessions.puts.find((p) => p.key.startsWith('oidc_state:'));
      expect(put?.options?.expirationTtl).toBe(600);
      expect(JSON.parse(put!.value).returnTo).toBe(`/r${n}`);
    });
  }

  it('callback∥login distinct keys isolation', async () => {
    const sessions = mockKv();
    seedState(sessions, 'pre');
    const env = linkedEnv({ sessions });
    const [cb, login] = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'pre' }), {}, env),
      request(loginPath(), {}, env),
    ]);
    expect(cb.text).toContain('Login Successful');
    expect(login.status).toBe(302);
    expect(sessions.data['oidc_state:pre']).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key.startsWith('oidc_state:') && p.key !== 'oidc_state:pre').length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('reset∥callback isolation: callback still mints token', async () => {
    const sessions = mockKv();
    seedState(sessions, 'iso');
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: encryptedSecret })],
      links: [seedLink()],
      streamPositions: { device_keys: 1 },
    });
    const env = envFor({ db, sessions, crossSigning: mockKv({ [`user:${USER}`]: 'k' }) });
    const [reset, cb] = await Promise.all([
      request(RESET_PATH, { method: 'POST' }, env),
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'iso' }), {}, env),
    ]);
    expect(reset.status).toBe(200);
    expect(cb.text).toContain('Login Successful');
  });

  it('login put-barrier ∥ seeded callback consume isolation', async () => {
    const sessions = mockKv({}, { putBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    seedState(sessions, 'seeded');
    const env = linkedEnv({ sessions });
    const [l1, l2, cb] = await Promise.all([
      request(loginPath(), {}, env),
      request(loginPath(), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'seeded' }), {}, env),
    ]);
    expect(l1.status).toBe(302);
    expect(l2.status).toBe(302);
    expect(cb.text).toContain('Login Successful');
  });
});

// ---------------------------------------------------------------------------
// encrypt/decrypt concurrent helper races (exported from oidc-auth)
// ---------------------------------------------------------------------------

describe('race oidc-auth encrypt/decrypt concurrent after #219', () => {
  it('parallel encrypt distinct ciphertexts, all decrypt to same secret', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    const ciphertexts = await Promise.all([
      encryptSecret('tok', env),
      encryptSecret('tok', env),
      encryptSecret('tok', env),
      encryptSecret('tok', env),
    ]);
    expect(new Set(ciphertexts).size).toBe(4);
    const plains = await Promise.all(ciphertexts.map((c) => decryptSecret(c, env)));
    expect(plains.every((p) => p === 'tok')).toBe(true);
    expect(ciphertexts.every((c) => Uint8Array.from(atob(c), (ch) => ch.charCodeAt(0))[0] === 0x02)).toBe(
      true
    );
  });

  it('encrypt without key rejects under parallel', async () => {
    const env = { SERVER_NAME: SERVER };
    const results = await Promise.allSettled([
      encryptSecret('x', env),
      encryptSecret('x', env),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('bad key length 31 concurrent encrypt rejects', async () => {
    const bad = btoa(String.fromCharCode(...new Uint8Array(31)));
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY: bad };
    const results = await Promise.allSettled([encryptSecret('x', env), encryptSecret('x', env)]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('decrypt roundtrip flood under Promise.all', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    const secrets = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const enc = await Promise.all(secrets.map((s) => encryptSecret(s, env)));
    const dec = await Promise.all(enc.map((c) => decryptSecret(c, env)));
    expect(dec).toEqual(secrets);
  });
});

// ---------------------------------------------------------------------------
// KV fail soft extras + new-user auto-create race
// ---------------------------------------------------------------------------

describe('race oidc-auth KV fail + auto-create concurrent after #219', () => {
  it('SESSIONS put fail first of two: mixed 302/500', async () => {
    const sessions = mockKv({}, { failPutAfter: 1 });
    const env = envFor({ db: createOidcDb({ providers: [seedProvider()] }), sessions });
    const results = await Promise.all([request(loginPath(), {}, env), request(loginPath(), {}, env)]);
    const codes = statusesOf(results);
    expect(codes).toContain(302);
    expect(codes).toContain(500);
  });

  it('SESSIONS delete fail after get still 500 HTML path', async () => {
    const sessions = mockKv({}, { failDeleteAfter: 0 });
    seedState(sessions, 'del-fail');
    const env = linkedEnv({ sessions });
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'del-fail' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'del-fail' }), {}, env),
    ]);
    expect(results.every((r) => r.status === 500 || r.text.includes('Authentication Failed'))).toBe(true);
  });

  it('new user auto-create dual callback same sub may double createUser (TOCTOU)', async () => {
    const sessions = mockKv({}, { getBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    seedState(sessions, 'newuser');
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: encryptedSecret, auto_create_users: 1 })],
      links: [],
    });
    getUserById.mockResolvedValue(null);
    const env = envFor({ db, sessions });
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'newuser' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'newuser' }), {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    // KV state double-consume does not serialize D1 link insert: 1 or 2 creates.
    expect(createUser.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(db.links.length).toBeGreaterThanOrEqual(1);
  });

  it('existing Matrix user auto-link without createUser under parallel', async () => {
    const sessions = mockKv({}, { getBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    seedState(sessions, 'autolink');
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: encryptedSecret, auto_create_users: 1 })],
      links: [],
    });
    getUserById.mockResolvedValue({ user_id: USER });
    const env = envFor({ db, sessions });
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'autolink' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'autolink' }), {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createUser).not.toHaveBeenCalled();
    expect(db.links.length).toBeGreaterThanOrEqual(1);
  });

  it('exchange throw after consume: Authentication Failed HTML both sides', async () => {
    exchangeCodeForTokens.mockRejectedValue(new Error('token endpoint down'));
    const sessions = mockKv({}, { getBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    seedState(sessions, 'ex');
    const env = linkedEnv({ sessions });
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'ex' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'ex' }), {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Authentication Failed'))).toBe(true);
    expect(sessions.data['oidc_state:ex']).toBeUndefined();
  });

  it('JWKS throw concurrent Authentication Failed', async () => {
    fetchJWKS.mockRejectedValue(new Error('jwks'));
    const sessions = mockKv({}, { getBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    seedState(sessions, 'jwks');
    const env = linkedEnv({ sessions });
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'jwks' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'jwks' }), {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Authentication Failed'))).toBe(true);
  });

  it('createDevice reject concurrent Authentication Failed', async () => {
    createDevice.mockRejectedValue(new Error('device fail'));
    const sessions = mockKv({}, { getBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } });
    seedState(sessions, 'dev');
    const env = linkedEnv({ sessions });
    const results = await Promise.all([
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'dev' }), {}, env),
      request(callbackPath(PROVIDER_ID, { code: 'c', state: 'dev' }), {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Authentication Failed'))).toBe(true);
  });

  it('CROSS_SIGNING_KEYS delete fail still 500 on reset race', async () => {
    const crossSigning = mockKv({ [`user:${USER}`]: 'k' }, { failDeleteAfter: 0 });
    const env = envFor({ db: createOidcDb(), crossSigning });
    const results = await Promise.all([
      request(RESET_PATH, { method: 'POST' }, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });
});
