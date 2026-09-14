/**
 * TOKENMAXX HEAVY leftovers after #222 — oidc-auth *concurrent race / TOCTOU*
 * for `src/api/oidc-auth.ts` (IdP client login / callback / auth_metadata /
 * MSC3861 identity reset).
 *
 * Soft/contract leftovers for oidc-auth are deep (#113/#143/#147:
 * oidc-auth-api-routes, oidc-auth-api-route-leftovers,
 * oidc-token-issuance-login-auth-leftovers) but concurrent-race coverage
 * was zero: sequential "consumes state exactly once" only — no Promise.all
 * / SESSIONS get-barrier double-redeem / auto-create double-INSERT /
 * identity-reset double-apply.
 *
 * Distinct from tip #222 (federation-auth X-Matrix require/optional),
 * #221 (oauth *provider* register/authorize/token/refresh/revoke),
 * #219 (admin+federation API). Orthogonal to login-qr-identity races
 * (#163) and account OpenID mint (#209). This is the IdP *client*
 * sibling left after the oauth-provider burn.
 *
 * Focus: oidc_state get-barrier double-redeem TOCTOU; distinct-state
 * isolation; login parallel state mint / RNG collision overwrite;
 * auto-create / auto-link SELECT-miss double-INSERT; last_login LWW;
 * mid-flight state wipe / provider disable; identity-reset double
 * DELETE + stream bump; providers/auth_metadata coherency; method /
 * missing / IdP-error soft floods under Promise.all; state TTL 600 bind.
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
const BOB = '@bob:example.com';
const PROVIDER_ID = 'google';
const PROVIDER_B = 'github';
const ISSUER = 'https://accounts.example-idp.com';
const NOW = 1_730_000_000_000;
const RESET_PATH = '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
const META_PATH = '/_matrix/client/v1/auth_metadata';

/** Fixed 32-byte key → base64 (OIDC_ENCRYPTION_KEY contract). */
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
type SqlCall = { sql: string; args: unknown[] };

async function withBarrier(
  barrier: KvBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  key: string
) {
  if (!barrier || !barrier.match(key)) return;
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

type FirstBarrier = { match?: (sql: string) => boolean; count: number };

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
    external_email: null,
    external_name: null,
    ...partial,
  };
}

function createOidcDb(opts: {
  providers?: IdPProvider[];
  links?: IdPUserLink[];
  streamPositions?: Record<string, number>;
  failCrossSigningDelete?: boolean;
  failStreamUpdate?: boolean;
  linkFirstBarrier?: FirstBarrier;
  providerFirstBarrier?: FirstBarrier;
  disableProviderAfterFirsts?: number;
} = {}) {
  const providers = opts.providers ? [...opts.providers] : [];
  const links = opts.links ? [...opts.links] : [];
  const streamPositions = { ...(opts.streamPositions ?? { device_keys: 10 }) };
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  let nextLinkId = links.reduce((m, l) => Math.max(m, l.id), 0) + 1;
  let linkBarrier = opts.linkFirstBarrier;
  let providerBarrier = opts.providerFirstBarrier;
  const linkWaiters = { list: [] as Array<() => void> };
  const providerWaiters = { list: [] as Array<() => void> };
  let providerFirstCount = 0;

  const db = {
    providers,
    links,
    streamPositions,
    inserts,
    updates,
    deletes,
    prepare(sql: string) {
      const stmt = {
        async all<T>() {
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
              if (sql.includes('FROM idp_providers WHERE id = ? AND enabled = 1')) {
                await withBarrier(
                  providerBarrier
                    ? { count: providerBarrier.count, match: () => true }
                    : undefined,
                  providerWaiters,
                  () => {
                    providerBarrier = undefined;
                  },
                  'provider'
                );
                providerFirstCount += 1;
                const [id] = args as [string];
                const row = providers.find((p) => p.id === id && p.enabled === 1);
                if (
                  opts.disableProviderAfterFirsts !== undefined &&
                  providerFirstCount >= opts.disableProviderAfterFirsts
                ) {
                  for (const p of providers) p.enabled = 0;
                }
                return (row ?? null) as T;
              }
              if (
                sql.includes('FROM idp_user_links') &&
                sql.includes('provider_id = ?') &&
                sql.includes('external_id = ?')
              ) {
                await withBarrier(
                  linkBarrier ? { count: linkBarrier.count, match: () => true } : undefined,
                  linkWaiters,
                  () => {
                    linkBarrier = undefined;
                  },
                  'link'
                );
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
  db?: ReturnType<typeof createOidcDb>;
  sessions?: RaceKv;
  crossSigning?: RaceKv;
  userKeys?: UserKeysStub;
  oidcKey?: string | undefined;
  serverName?: string;
} = {}): Env {
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
  } as unknown as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = envFor()
): Promise<{ status: number; body: unknown; text: string; headers: Headers; res: Response }> {
  const url = path.startsWith('http') ? path : `https://${SERVER}${path}`;
  const res = await oidcAuth.request(url, init, env);
  const ct = res.headers.get('content-type') || '';
  let body: unknown = null;
  let text = '';
  if (ct.includes('application/json')) {
    body = await res.json();
    text = JSON.stringify(body);
  } else {
    text = await res.text();
    body = text;
  }
  return { status: res.status, body, text, headers: res.headers, res };
}

async function encryptClientSecret(secret = 'idp-client-secret'): Promise<string> {
  return encryptSecret(secret, { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY });
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

async function linkedEnv(opts: {
  sessions?: RaceKv;
  extraLinks?: IdPUserLink[];
  extraProviders?: IdPProvider[];
  dbOpts?: Parameters<typeof createOidcDb>[0];
} = {}) {
  const secret = await encryptClientSecret();
  const db = createOidcDb({
    providers: [seedProvider({ client_secret_encrypted: secret }), ...(opts.extraProviders ?? [])],
    links: [seedLink(), ...(opts.extraLinks ?? [])],
    ...opts.dbOpts,
  });
  const sessions = opts.sessions ?? mockKv();
  return { env: envFor({ sessions, db }), sessions, db, secret };
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function loginPath(providerId = PROVIDER_ID, returnTo?: string): string {
  const q = returnTo !== undefined ? `?return_to=${encodeURIComponent(returnTo)}` : '';
  return `/auth/oidc/${providerId}/login${q}`;
}

function callbackPath(state: string, code = 'c1', providerId = PROVIDER_ID): string {
  return `/auth/oidc/${providerId}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
}

beforeEach(() => {
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
  buildAuthorizationUrl.mockReturnValue(`${ISSUER}/authorize?client_id=client-abc&state=STATE`);
  generateRandomString.mockImplementation((n: number) => {
    randSeq += 1;
    return `r${randSeq}`.padEnd(n, '0').slice(0, n);
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

// ---------------------------------------------------------------------------
// Callback oidc_state get-barrier double-redeem TOCTOU
// Sequential leftover already asserts second callback expires; concurrent
// get-before-delete lets both observe the one-time state.
// ---------------------------------------------------------------------------

describe('race oidc-auth callback state double-redeem TOCTOU after #222', () => {
  it('sequential contrast — second callback expires after first consumes state', async () => {
    const { env, sessions } = await linkedEnv();
    const state = seedState(sessions, 'seq-once');
    const first = await request(callbackPath(state, 'c1'), {}, env);
    const second = await request(callbackPath(state, 'c2'), {}, env);
    expect(first.text).toContain('Login Successful');
    expect(second.text).toContain('login session has expired');
    expect(sessions.data[`oidc_state:${state}`]).toBeUndefined();
  });

  for (let i = 0; i < 12; i++) {
    it(`dual callback same state under get barrier — both observe then delete flood-${i}`, async () => {
      const state = `same-${i}`;
      const sessions = mockKv(
        {},
        { getBarrier: { count: 2, match: (k) => k === `oidc_state:${state}` } }
      );
      seedState(sessions, state);
      const { env } = await linkedEnv({ sessions });
      const [a, b] = await Promise.all([
        request(callbackPath(state, `ca${i}`), {}, env),
        request(callbackPath(state, `cb${i}`), {}, env),
      ]);
      const texts = [a.text, b.text];
      expect(texts.every((t) => t.includes('Login Successful'))).toBe(true);
      expect(sessions.getCount).toBeGreaterThanOrEqual(2);
      expect(sessions.deletes.filter((k) => k === `oidc_state:${state}`).length).toBe(2);
      expect(sessions.data[`oidc_state:${state}`]).toBeUndefined();
      expect(createDevice).toHaveBeenCalledTimes(2);
      expect(createAccessToken).toHaveBeenCalledTimes(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`triple same-state get-barrier still double-applies tokens flood-${i}`, async () => {
      const state = `tri-${i}`;
      const sessions = mockKv(
        {},
        { getBarrier: { count: 3, match: (k) => k === `oidc_state:${state}` } }
      );
      seedState(sessions, state);
      const { env } = await linkedEnv({ sessions });
      const results = await Promise.all([
        request(callbackPath(state, `t0-${i}`), {}, env),
        request(callbackPath(state, `t1-${i}`), {}, env),
        request(callbackPath(state, `t2-${i}`), {}, env),
      ]);
      expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
      expect(sessions.deletes.filter((k) => k === `oidc_state:${state}`).length).toBe(3);
      expect(createDevice).toHaveBeenCalledTimes(3);
    });
  }

  it('mutate wipe after first get — second callback expires (TOCTOU sibling)', async () => {
    const state = 'wipe-1';
    const sessions = mockKv(
      {},
      {
        getBarrier: { count: 2, match: (k) => k === `oidc_state:${state}` },
        mutateAfterGets: { after: 1, next: {} },
      }
    );
    seedState(sessions, state);
    const { env } = await linkedEnv({ sessions });
    const [a, b] = await Promise.all([
      request(callbackPath(state, 'w1'), {}, env),
      request(callbackPath(state, 'w2'), {}, env),
    ]);
    const texts = [a.text, b.text];
    const ok = texts.filter((t) => t.includes('Login Successful')).length;
    const expired = texts.filter((t) => t.includes('login session has expired')).length;
    expect(ok + expired).toBe(2);
    expect(ok).toBe(1);
    expect(expired).toBe(1);
  });

  it('SESSIONS get fail after first — sibling surfaces error HTML / 500', async () => {
    const state = 'fail-get';
    const sessions = mockKv(
      {},
      {
        getBarrier: { count: 2, match: (k) => k === `oidc_state:${state}` },
        failGetAfter: 1,
      }
    );
    seedState(sessions, state);
    const { env } = await linkedEnv({ sessions });
    const [a, b] = await Promise.all([
      request(callbackPath(state, 'f1'), {}, env),
      request(callbackPath(state, 'f2'), {}, env),
    ]);
    const pair = [a, b];
    const ok = pair.filter((r) => r.text.includes('Login Successful'));
    const failed = pair.filter((r) => r.status >= 500 || r.text.includes('Authentication Failed') || r.status === 500);
    expect(ok.length + failed.length).toBeGreaterThanOrEqual(1);
    expect(ok.length).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// Distinct-state isolation + sibling provider isolation
// ---------------------------------------------------------------------------

describe('race oidc-auth distinct-state isolation after #222', () => {
  for (let i = 0; i < 12; i++) {
    it(`distinct states parallel redeem isolate tokens flood-${i}`, async () => {
      const sessions = mockKv();
      const sa = seedState(sessions, `iso-a-${i}`, { returnTo: `/a${i}` });
      const sb = seedState(sessions, `iso-b-${i}`, { returnTo: `/b${i}` });
      const { env } = await linkedEnv({ sessions });
      const [a, b] = await Promise.all([
        request(callbackPath(sa, `ca-${i}`), {}, env),
        request(callbackPath(sb, `cb-${i}`), {}, env),
      ]);
      expect(a.text).toContain('Login Successful');
      expect(b.text).toContain('Login Successful');
      expect(a.text).toContain(`href="/a${i}"`);
      expect(b.text).toContain(`href="/b${i}"`);
      expect(sessions.data[`oidc_state:${sa}`]).toBeUndefined();
      expect(sessions.data[`oidc_state:${sb}`]).toBeUndefined();
      expect(createDevice).toHaveBeenCalledTimes(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`alice∥bob distinct links isolate user ids flood-${i}`, async () => {
      const sessions = mockKv();
      const sa = seedState(sessions, `alice-${i}`);
      const sb = seedState(sessions, `bob-${i}`, {
        providerId: PROVIDER_B,
        redirectUri: `https://${SERVER}/auth/oidc/${PROVIDER_B}/callback`,
      });
      const secret = await encryptClientSecret();
      const db = createOidcDb({
        providers: [
          seedProvider({ client_secret_encrypted: secret }),
          seedProvider({
            id: PROVIDER_B,
            name: 'GitHub',
            client_secret_encrypted: secret,
            display_order: 2,
          }),
        ],
        links: [
          seedLink(),
          seedLink({ id: 2, provider_id: PROVIDER_B, external_id: 'ext-bob', user_id: BOB }),
        ],
      });
      validateIDToken
        .mockResolvedValueOnce({
          sub: 'ext-sub-1',
          email: 'alice@example.com',
          name: 'Alice',
        })
        .mockResolvedValueOnce({
          sub: 'ext-bob',
          email: 'bob@example.com',
          name: 'Bob',
        });
      const env = envFor({ sessions, db });
      const [a, b] = await Promise.all([
        request(callbackPath(sa, `ca-${i}`), {}, env),
        request(callbackPath(sb, `cb-${i}`, PROVIDER_B), {}, env),
      ]);
      expect(a.text).toContain(USER);
      expect(b.text).toContain(BOB);
      expect(a.text).not.toContain(BOB);
      expect(b.text).not.toContain(USER);
    });
  }

  it('provider mismatch deletes state and isolates from valid sibling', async () => {
    const sessions = mockKv();
    const bad = seedState(sessions, 'mismatch-a', { providerId: PROVIDER_ID });
    const good = seedState(sessions, 'mismatch-b');
    const { env } = await linkedEnv({ sessions });
    const [a, b] = await Promise.all([
      request(callbackPath(bad, 'x', PROVIDER_B), {}, env),
      request(callbackPath(good, 'y'), {}, env),
    ]);
    expect(a.text).toContain('Provider mismatch');
    expect(b.text).toContain('Login Successful');
  });
});

// ---------------------------------------------------------------------------
// Login parallel state mint / RNG collision overwrite
// ---------------------------------------------------------------------------

describe('race oidc-auth login parallel state mint after #222', () => {
  for (let i = 0; i < 12; i++) {
    it(`dual login unique RNG mints two oidc_state keys flood-${i}`, async () => {
      const sessions = mockKv(
        {},
        { putBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } }
      );
      const db = createOidcDb({ providers: [seedProvider()] });
      const env = envFor({ sessions, db });
      const [a, b] = await Promise.all([
        request(loginPath(PROVIDER_ID, `/ret-a-${i}`), {}, env),
        request(loginPath(PROVIDER_ID, `/ret-b-${i}`), {}, env),
      ]);
      expect(statusesOf([a, b])).toEqual([302, 302]);
      const statePuts = sessions.puts.filter((p) => p.key.startsWith('oidc_state:'));
      expect(statePuts.length).toBe(2);
      expect(new Set(statePuts.map((p) => p.key)).size).toBe(2);
      expect(statePuts.every((p) => p.options?.expirationTtl === 600)).toBe(true);
      const returns = statePuts.map((p) => JSON.parse(p.value).returnTo).sort();
      expect(returns).toEqual([`/ret-a-${i}`, `/ret-b-${i}`].sort());
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`quad login put-barrier still four distinct states flood-${i}`, async () => {
      const sessions = mockKv(
        {},
        { putBarrier: { count: 4, match: (k) => k.startsWith('oidc_state:') } }
      );
      const db = createOidcDb({ providers: [seedProvider()] });
      const env = envFor({ sessions, db });
      const results = await Promise.all(
        [0, 1, 2, 3].map((j) => request(loginPath(PROVIDER_ID, `/q${i}-${j}`), {}, env))
      );
      expect(statusesOf(results)).toEqual([302, 302, 302, 302]);
      expect(new Set(sessions.puts.map((p) => p.key)).size).toBe(4);
    });
  }

  it('RNG collision — same state key overwrite is last-put-wins', async () => {
    generateRandomString.mockImplementation((n: number) => 'COLLIDE'.padEnd(n, 'x').slice(0, n));
    const sessions = mockKv(
      {},
      { putBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const [a, b] = await Promise.all([
      request(loginPath(PROVIDER_ID, '/one'), {}, env),
      request(loginPath(PROVIDER_ID, '/two'), {}, env),
    ]);
    expect(statusesOf([a, b])).toEqual([302, 302]);
    const stateKeys = sessions.puts.filter((p) => p.key.startsWith('oidc_state:')).map((p) => p.key);
    expect(new Set(stateKeys).size).toBe(1);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('oidc_state:')).length).toBe(1);
    const stored = JSON.parse(Object.values(sessions.data)[0]);
    expect(['/one', '/two']).toContain(stored.returnTo);
  });

  it('distinct providers parallel login isolate providerId in state', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcDb({
      providers: [seedProvider(), seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 })],
    });
    const env = envFor({ sessions, db });
    const [a, b] = await Promise.all([
      request(loginPath(PROVIDER_ID, '/g'), {}, env),
      request(loginPath(PROVIDER_B, '/h'), {}, env),
    ]);
    expect(statusesOf([a, b])).toEqual([302, 302]);
    const ids = sessions.puts.map((p) => JSON.parse(p.value).providerId).sort();
    expect(ids).toEqual([PROVIDER_B, PROVIDER_ID].sort());
  });

  it('unknown provider parallel soft — both M_NOT_FOUND, no KV put', async () => {
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const [a, b] = await Promise.all([
      request(loginPath('missing-a'), {}, env),
      request(loginPath('missing-b'), {}, env),
    ]);
    expect(statusesOf([a, b])).toEqual([404, 404]);
    expect((a.body as { errcode: string }).errcode).toBe('M_NOT_FOUND');
    expect((b.body as { errcode: string }).errcode).toBe('M_NOT_FOUND');
    expect(sessions.puts.length).toBe(0);
  });

  it('discovery throw parallel — both M_UNKNOWN 500 and no leftover state', async () => {
    fetchOIDCDiscovery.mockRejectedValue(new Error('discovery down'));
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const [a, b] = await Promise.all([
      request(loginPath(), {}, env),
      request(loginPath(), {}, env),
    ]);
    expect(statusesOf([a, b])).toEqual([500, 500]);
    expect((a.body as { errcode: string }).errcode).toBe('M_UNKNOWN');
    expect(sessions.puts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Auto-create / auto-link SELECT-miss double-INSERT
// ---------------------------------------------------------------------------

describe('race oidc-auth auto-create / auto-link SELECT-miss after #222', () => {
  for (let i = 0; i < 8; i++) {
    it(`auto-create dual callback both miss link then double INSERT flood-${i}`, async () => {
      const sa = `ac-a-${i}`;
      const sb = `ac-b-${i}`;
      const sessions = mockKv();
      seedState(sessions, sa);
      seedState(sessions, sb);
      const secret = await encryptClientSecret();
      const db = createOidcDb({
        providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 1 })],
        links: [],
        linkFirstBarrier: { count: 2 },
      });
      const env = envFor({ sessions, db });
      const [a, b] = await Promise.all([
        request(callbackPath(sa, `ca-${i}`), {}, env),
        request(callbackPath(sb, `cb-${i}`), {}, env),
      ]);
      expect(a.text).toContain('Login Successful');
      expect(b.text).toContain('Login Successful');
      expect(createUser).toHaveBeenCalledTimes(2);
      expect(db.links.filter((l) => l.external_id === 'ext-sub-1').length).toBe(2);
      expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO idp_user_links')).length).toBe(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`auto-link existing Matrix user double INSERT without createUser flood-${i}`, async () => {
      getUserById.mockResolvedValue({ user_id: USER, localpart: 'alice' });
      const sa = `al-a-${i}`;
      const sb = `al-b-${i}`;
      const sessions = mockKv();
      seedState(sessions, sa);
      seedState(sessions, sb);
      const secret = await encryptClientSecret();
      const db = createOidcDb({
        providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 1 })],
        links: [],
        linkFirstBarrier: { count: 2 },
      });
      const env = envFor({ sessions, db });
      const [a, b] = await Promise.all([
        request(callbackPath(sa, `ca-${i}`), {}, env),
        request(callbackPath(sb, `cb-${i}`), {}, env),
      ]);
      expect(a.text).toContain('Login Successful');
      expect(b.text).toContain('Login Successful');
      expect(createUser).not.toHaveBeenCalled();
      expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO idp_user_links')).length).toBe(2);
    });
  }

  it('auto_create=0 + no link — both Account Not Found, no INSERT', async () => {
    const sessions = mockKv();
    seedState(sessions, 'nc-a');
    seedState(sessions, 'nc-b');
    const secret = await encryptClientSecret();
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 0 })],
      links: [],
      linkFirstBarrier: { count: 2 },
    });
    const env = envFor({ sessions, db });
    const [a, b] = await Promise.all([
      request(callbackPath('nc-a', 'c1'), {}, env),
      request(callbackPath('nc-b', 'c2'), {}, env),
    ]);
    expect(a.text).toContain('Account Not Found');
    expect(b.text).toContain('Account Not Found');
    expect(createUser).not.toHaveBeenCalled();
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO idp_user_links')).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Existing-link last_login UPDATE LWW + provider disable mid-flight
// ---------------------------------------------------------------------------

describe('race oidc-auth last_login LWW + provider disable TOCTOU after #222', () => {
  for (let i = 0; i < 8; i++) {
    it(`existing link dual UPDATE last_login under barrier flood-${i}`, async () => {
      const sa = `ll-a-${i}`;
      const sb = `ll-b-${i}`;
      const sessions = mockKv();
      seedState(sessions, sa);
      seedState(sessions, sb);
      const { env, db } = await linkedEnv({
        sessions,
        dbOpts: { linkFirstBarrier: { count: 2 } },
      });
      const [a, b] = await Promise.all([
        request(callbackPath(sa, `ca-${i}`), {}, env),
        request(callbackPath(sb, `cb-${i}`), {}, env),
      ]);
      expect(a.text).toContain('Login Successful');
      expect(b.text).toContain('Login Successful');
      expect(db.updates.filter((u) => u.sql.includes('last_login_at')).length).toBe(2);
      expect(db.links).toHaveLength(1);
      expect(createUser).not.toHaveBeenCalled();
    });
  }

  it('provider disable after first lookup — second callback Provider Not Found', async () => {
    const sessions = mockKv();
    seedState(sessions, 'dis-a');
    seedState(sessions, 'dis-b');
    const secret = await encryptClientSecret();
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [seedLink()],
      providerFirstBarrier: { count: 2 },
      disableProviderAfterFirsts: 1,
    });
    const env = envFor({ sessions, db });
    const [a, b] = await Promise.all([
      request(callbackPath('dis-a', 'c1'), {}, env),
      request(callbackPath('dis-b', 'c2'), {}, env),
    ]);
    const texts = [a.text, b.text];
    const ok = texts.filter((t) => t.includes('Login Successful')).length;
    const missing = texts.filter((t) => t.includes('Provider Not Found') || t.includes('Identity provider')).length;
    expect(ok + missing).toBe(2);
    expect(missing).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// MSC3861 identity reset double-apply
// ---------------------------------------------------------------------------

describe('race oidc-auth MSC3861 identity reset concurrent after #222', () => {
  for (let i = 0; i < 10; i++) {
    it(`dual reset same user double DELETE + stream bump flood-${i}`, async () => {
      const userKeys = createUserKeysStub();
      const crossSigning = mockKv({ [`user:${USER}`]: '{"keys":1}' });
      const db = createOidcDb({ streamPositions: { device_keys: 40 + i } });
      const env = envFor({ db, userKeys, crossSigning });
      const [a, b] = await Promise.all([
        request(RESET_PATH, { method: 'POST' }, env),
        request(RESET_PATH, { method: 'POST' }, env),
      ]);
      expect(statusesOf([a, b])).toEqual([200, 200]);
      expect(a.body).toEqual({});
      expect(b.body).toEqual({});
      expect(userKeys.fetches.filter((f) => f.url.includes('/cross-signing/delete')).length).toBe(2);
      expect(db.deletes.filter((d) => d.sql.includes('cross_signing_keys')).length).toBe(2);
      expect(db.deletes.filter((d) => d.sql.includes('cross_signing_signatures')).length).toBe(2);
      expect(db.inserts.filter((x) => x.sql.includes('device_key_changes')).length).toBe(2);
      expect(db.streamPositions.device_keys).toBe(42 + i);
      expect(crossSigning.deletes.filter((k) => k === `user:${USER}`).length).toBe(2);
    });
  }

  it('reset∥reset under CROSS_SIGNING_KEYS delete barrier still both 200', async () => {
    const userKeys = createUserKeysStub();
    const crossSigning = mockKv(
      { [`user:${USER}`]: '{"keys":1}' },
      { deleteBarrier: { count: 2, match: (k) => k === `user:${USER}` } }
    );
    const db = createOidcDb({ streamPositions: { device_keys: 7 } });
    const env = envFor({ db, userKeys, crossSigning });
    const results = await Promise.all([
      request(RESET_PATH, { method: 'POST' }, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.streamPositions.device_keys).toBe(9);
  });

  it('DO throw on first of two — at least one M_UNKNOWN, sibling may still 200', async () => {
    let n = 0;
    const userKeys: UserKeysStub = {
      fetches: [],
      async fetch(req: Request) {
        n += 1;
        this.fetches.push({ url: req.url, method: req.method });
        if (n === 1) throw new Error('DO fetch threw');
        return Response.json({ ok: true });
      },
    };
    const db = createOidcDb();
    const env = envFor({ db, userKeys, crossSigning: mockKv() });
    const [a, b] = await Promise.all([
      request(RESET_PATH, { method: 'POST' }, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    const pair = [a, b];
    const ok = pair.filter((r) => r.status === 200);
    const fail = pair.filter((r) => r.status === 500);
    expect(ok.length + fail.length).toBe(2);
    expect(fail.length).toBe(1);
    expect((fail[0].body as { errcode: string }).errcode).toBe('M_UNKNOWN');
  });

  it('stream bump fail — both M_UNKNOWN and no device_key_changes', async () => {
    const db = createOidcDb({ failStreamUpdate: true });
    const env = envFor({ db, userKeys: createUserKeysStub(), crossSigning: mockKv() });
    const [a, b] = await Promise.all([
      request(RESET_PATH, { method: 'POST' }, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(statusesOf([a, b])).toEqual([500, 500]);
    expect(db.inserts.filter((x) => x.sql.includes('device_key_changes')).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Providers list + auth_metadata coherency under Promise.all
// ---------------------------------------------------------------------------

describe('race oidc-auth providers + auth_metadata coherency after #222', () => {
  for (let i = 0; i < 10; i++) {
    it(`providers list parallel flood-${i} same enabled set`, async () => {
      const db = createOidcDb({
        providers: [
          seedProvider({ name: 'Google', display_order: 1 }),
          seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2, icon_url: null }),
        ],
      });
      const env = envFor({ db });
      const results = await Promise.all(
        [0, 1, 2].map(() => request('/auth/oidc/providers', {}, env))
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      for (const r of results) {
        const body = r.body as { providers: Array<{ id: string; login_url: string }> };
        expect(body.providers.map((p) => p.id)).toEqual([PROVIDER_ID, PROVIDER_B]);
        expect(body.providers[0].login_url).toBe(`/auth/oidc/${PROVIDER_ID}/login`);
        expect(JSON.stringify(body)).not.toContain('client_secret');
      }
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`auth_metadata GET∥GET flood-${i} identical issuer bind`, async () => {
      const env = envFor();
      const [a, b] = await Promise.all([
        request(META_PATH, {}, env),
        request(META_PATH, {}, env),
      ]);
      expect(statusesOf([a, b])).toEqual([200, 200]);
      expect(a.body).toEqual(b.body);
      const body = a.body as { issuer: string; authorization_endpoint: string };
      expect(body.issuer).toBe(`https://${SERVER}`);
      expect(body.authorization_endpoint).toBe(`https://${SERVER}/oauth/authorize`);
    });
  }

  it('providers∥login isolation — list does not consume login state', async () => {
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const [list, login] = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request(loginPath(PROVIDER_ID, '/from-list'), {}, env),
    ]);
    expect(list.status).toBe(200);
    expect(login.status).toBe(302);
    expect(sessions.puts.length).toBe(1);
    expect((list.body as { providers: unknown[] }).providers).toHaveLength(1);
  });

  it('auth_metadata∥identity-reset isolation — metadata ignores reset writes', async () => {
    const userKeys = createUserKeysStub();
    const db = createOidcDb({ streamPositions: { device_keys: 3 } });
    const env = envFor({ db, userKeys, crossSigning: mockKv({ [`user:${USER}`]: '1' }) });
    const [meta, reset] = await Promise.all([
      request(META_PATH, {}, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(meta.status).toBe(200);
    expect(reset.status).toBe(200);
    expect((meta.body as { issuer: string }).issuer).toBe(`https://${SERVER}`);
    expect(db.streamPositions.device_keys).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Login∥callback isolation + method / missing / IdP-error soft floods
// ---------------------------------------------------------------------------

describe('race oidc-auth login∥callback + soft floods after #222', () => {
  for (let i = 0; i < 8; i++) {
    it(`login∥callback distinct keys do not clobber flood-${i}`, async () => {
      const sessions = mockKv();
      const state = seedState(sessions, `cb-${i}`, { returnTo: `/keep-${i}` });
      const { env } = await linkedEnv({ sessions });
      const [login, cb] = await Promise.all([
        request(loginPath(PROVIDER_ID, `/new-${i}`), {}, env),
        request(callbackPath(state, `c-${i}`), {}, env),
      ]);
      expect(login.status).toBe(302);
      expect(cb.text).toContain('Login Successful');
      expect(cb.text).toContain(`href="/keep-${i}"`);
      const leftover = Object.entries(sessions.data).filter(([k]) => k.startsWith('oidc_state:'));
      expect(leftover).toHaveLength(1);
      expect(JSON.parse(leftover[0][1]).returnTo).toBe(`/new-${i}`);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`missing code+state parallel Invalid Request flood-${i}`, async () => {
      const { env, sessions } = await linkedEnv();
      const [a, b] = await Promise.all([
        request(`/auth/oidc/${PROVIDER_ID}/callback`, {}, env),
        request(`/auth/oidc/${PROVIDER_ID}/callback?code=`, {}, env),
      ]);
      expect(a.text).toContain('Invalid Request');
      expect(b.text).toContain('Invalid Request');
      expect(sessions.deletes.length).toBe(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`IdP error query wins over code+state under parallel flood-${i}`, async () => {
      const sessions = mockKv();
      seedState(sessions, `err-${i}`);
      const { env } = await linkedEnv({ sessions });
      const [a, b] = await Promise.all([
        request(
          `/auth/oidc/${PROVIDER_ID}/callback?error=access_denied&error_description=nope${i}&code=c&state=err-${i}`,
          {},
          env
        ),
        request(
          `/auth/oidc/${PROVIDER_ID}/callback?error=access_denied&code=c2&state=err-${i}`,
          {},
          env
        ),
      ]);
      expect(a.text).toContain('Authentication Failed');
      expect(b.text).toContain('Authentication Failed');
      expect(sessions.data[`oidc_state:err-${i}`]).toBeDefined();
      expect(sessions.deletes.length).toBe(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`expired/missing state parallel both expire flood-${i}`, async () => {
      const { env, sessions } = await linkedEnv();
      const [a, b] = await Promise.all([
        request(callbackPath(`gone-${i}`, 'c1'), {}, env),
        request(callbackPath(`gone-${i}`, 'c2'), {}, env),
      ]);
      expect(a.text).toContain('login session has expired');
      expect(b.text).toContain('login session has expired');
      expect(sessions.deletes.length).toBe(0);
    });
  }

  it('POST login / PUT callback / GET reset method isolation', async () => {
    const { env } = await linkedEnv();
    const [loginPost, cbPut, resetGet] = await Promise.all([
      request(loginPath(), { method: 'POST' }, env),
      request(callbackPath('nope'), { method: 'PUT' }, env),
      request(RESET_PATH, { method: 'GET' }, env),
    ]);
    expect([loginPost.status, cbPut.status, resetGet.status].every((s) => s === 404 || s === 405)).toBe(
      true
    );
  });

  for (let i = 0; i < 8; i++) {
    it(`empty state query treated as missing under parallel flood-${i}`, async () => {
      const { env } = await linkedEnv();
      const results = await Promise.all([
        request(`/auth/oidc/${PROVIDER_ID}/callback?code=c&state=`, {}, env),
        request(`/auth/oidc/${PROVIDER_ID}/callback?code=c2&state=`, {}, env),
      ]);
      expect(results.every((r) => r.text.includes('Invalid Request'))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Bind contracts: state TTL 600, redirect https, encrypt/decrypt isolation
// ---------------------------------------------------------------------------

describe('race oidc-auth bind contracts + encrypt isolation after #222', () => {
  for (let i = 0; i < 8; i++) {
    it(`login state TTL bind 600 under put barrier flood-${i}`, async () => {
      const sessions = mockKv(
        {},
        { putBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } }
      );
      const db = createOidcDb({ providers: [seedProvider()] });
      const env = envFor({ sessions, db });
      await Promise.all([request(loginPath(), {}, env), request(loginPath(), {}, env)]);
      expect(sessions.puts.every((p) => p.options?.expirationTtl === 600)).toBe(true);
      for (const p of sessions.puts) {
        const parsed = JSON.parse(p.value);
        expect(parsed.providerId).toBe(PROVIDER_ID);
        expect(parsed.redirectUri).toBe(`https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`);
        expect(parsed.nonce).toEqual(expect.any(String));
      }
    });
  }

  it('login forces https redirectUri even when request URL is http (parallel)', async () => {
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`http://${SERVER}/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request(`http://${SERVER}/auth/oidc/${PROVIDER_ID}/login?return_to=/x`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    for (const p of sessions.puts) {
      expect(JSON.parse(p.value).redirectUri.startsWith('https://')).toBe(true);
    }
  });

  it('Host header including port preserved in parallel logins', async () => {
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    await Promise.all([
      request(loginPath(), { headers: { Host: 'matrix.example.com:8448' } }, env),
      request(loginPath(), { headers: { Host: 'matrix.example.com:8448' } }, env),
    ]);
    for (const p of sessions.puts) {
      expect(JSON.parse(p.value).redirectUri).toContain('matrix.example.com:8448');
    }
  });

  it('encrypt∥decrypt concurrent isolation — distinct IVs, same plaintext', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    const [e1, e2] = await Promise.all([
      encryptSecret('parallel-secret', env),
      encryptSecret('parallel-secret', env),
    ]);
    expect(e1).not.toBe(e2);
    const [d1, d2] = await Promise.all([decryptSecret(e1, env), decryptSecret(e2, env)]);
    expect(d1).toBe('parallel-secret');
    expect(d2).toBe('parallel-secret');
  });

  it('callback passes state redirectUri into exchangeCodeForTokens under race', async () => {
    const sessions = mockKv();
    const sa = seedState(sessions, 'ex-a', {
      redirectUri: `https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`,
    });
    const sb = seedState(sessions, 'ex-b', {
      redirectUri: `https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`,
    });
    const { env } = await linkedEnv({ sessions });
    await Promise.all([
      request(callbackPath(sa, 'code-a'), {}, env),
      request(callbackPath(sb, 'code-b'), {}, env),
    ]);
    expect(exchangeCodeForTokens).toHaveBeenCalledTimes(2);
    const codes = exchangeCodeForTokens.mock.calls.map((c) => c[3]).sort();
    expect(codes).toEqual(['code-a', 'code-b']);
    for (const call of exchangeCodeForTokens.mock.calls) {
      expect(call[4]).toBe(`https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`);
    }
  });

  it('device display name includes provider name on both concurrent successes', async () => {
    const sessions = mockKv();
    seedState(sessions, 'dn-a');
    seedState(sessions, 'dn-b');
    const { env } = await linkedEnv({ sessions });
    await Promise.all([
      request(callbackPath('dn-a', 'c1'), {}, env),
      request(callbackPath('dn-b', 'c2'), {}, env),
    ]);
    expect(createDevice).toHaveBeenCalledTimes(2);
    for (const call of createDevice.mock.calls) {
      expect(call[2]).toMatch(/DEV\d+/);
      expect(call[3]).toContain('SSO Login (Google)');
    }
  });

  it('identity reset does not touch SESSIONS while login puts state (cross-path)', async () => {
    const sessions = mockKv();
    const userKeys = createUserKeysStub();
    const db = createOidcDb({
      providers: [seedProvider()],
      streamPositions: { device_keys: 1 },
    });
    const env = envFor({ sessions, db, userKeys, crossSigning: mockKv() });
    const [login, reset] = await Promise.all([
      request(loginPath(), {}, env),
      request(RESET_PATH, { method: 'POST' }, env),
    ]);
    expect(login.status).toBe(302);
    expect(reset.status).toBe(200);
    expect(sessions.puts.every((p) => p.key.startsWith('oidc_state:'))).toBe(true);
    expect(sessions.deletes.length).toBe(0);
  });
});
