/**
 * TOKENMAXX HEAVY leftovers after #277 quaternary / tip past #276 — oidc-auth
 * *quinary* concurrent-race niches: soft exact error / HTML binds under
 * Promise.all that quaternary (#277) never claimed (grep Identity provider
 * not found / login session has expired in *oidc*concurrent* /
 * *oidc*quaternary* = 0).
 *
 * Soft/route leftovers bind these sequentially (oidc-auth-api-routes);
 * concurrent races never. Quinary deepen:
 *   unknown/disabled provider login → exact `Identity provider not found`
 *   ∥ sibling success 302;
 *   missing/expired oidc_state → HTML `The login session has expired` ∥
 *   valid redeem success;
 *   IdP `error` query → Authentication Failed title + error_description
 *   HTML bind ∥ sibling success (no state burn on IdP error).
 *
 * Distinct from #277 oidc quaternary (Failed to initiate/reset / Missing
 * code or state), #268 deleteBarrier tip, #276 appservice quaternary.
 * New file (not append to megaflood). Orthogonal to oauth quinary (external
 * IdP SSO, not /oauth/* AS provider). Tests-only. example.com fixtures only.
 * Reversible by deleting this file.
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

import oidcAuth, { encryptSecret } from '../src/api/oidc-auth';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const PROVIDER_ID = 'google';
const PROVIDER_B = 'github';
const ISSUER = 'https://accounts.example-idp.com';
const ISSUER_B = 'https://github.example-idp.com';
const NOW = 1_730_000_000_000;

const OIDC_KEY_BYTES = new Uint8Array(32).map((_, i) => (i * 7 + 13) & 0xff);
const OIDC_ENCRYPTION_KEY = btoa(String.fromCharCode(...OIDC_KEY_BYTES));

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type KvBarrier = { match: (key: string) => boolean; count: number };
type SqlBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type SqlCall = { sql: string; args: unknown[] };

async function withBarrier(
  barrier: { match: (...a: any[]) => boolean; count: number } | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  ...matchArgs: any[]
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

function createOidcRaceDb(opts: {
  providers?: IdPProvider[];
  links?: IdPUserLink[];
  streamPositions?: Record<string, number>;
  selectBarrier?: SqlBarrier;
  runBarrier?: SqlBarrier;
  failCrossSigningDelete?: boolean;
  failStreamUpdate?: boolean;
  failSelectAfter?: number;
  failRunAfter?: number;
} = {}) {
  const providers = opts.providers ? [...opts.providers] : [];
  const links = opts.links ? [...opts.links] : [];
  const streamPositions = { ...(opts.streamPositions ?? { device_keys: 10 }) };
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  let nextLinkId = links.reduce((m, l) => Math.max(m, l.id), 0) + 1;
  let selectBarrier = opts.selectBarrier;
  let runBarrier = opts.runBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const runWaiters = { list: [] as Array<() => void> };
  let selectCount = 0;
  let runCount = 0;

  const db = {
    providers,
    links,
    streamPositions,
    inserts,
    updates,
    deletes,
    get selectCount() {
      return selectCount;
    },
    get runCount() {
      return runCount;
    },
    prepare(sql: string) {
      const stmt = {
        async all<T>() {
          await withBarrier(selectBarrier, selectWaiters, () => {
            selectBarrier = undefined;
          }, sql, []);
          selectCount += 1;
          if (opts.failSelectAfter !== undefined && selectCount > opts.failSelectAfter) {
            throw new Error('sql-select-fail');
          }
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
              await withBarrier(selectBarrier, selectWaiters, () => {
                selectBarrier = undefined;
              }, sql, args);
              selectCount += 1;
              if (opts.failSelectAfter !== undefined && selectCount > opts.failSelectAfter) {
                throw new Error('sql-select-fail');
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
              await withBarrier(runBarrier, runWaiters, () => {
                runBarrier = undefined;
              }, sql, args);
              runCount += 1;
              if (opts.failRunAfter !== undefined && runCount > opts.failRunAfter) {
                throw new Error('sql-run-fail');
              }
              if (sql.includes('UPDATE idp_user_links SET last_login_at')) {
                updates.push({ sql, args });
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
  fetchBarrier?: { count: number };
  fetch: (req: Request) => Promise<Response>;
};

function createUserKeysStub(
  opts: { failDelete?: boolean; throwOnFetch?: boolean; fetchBarrier?: { count: number } } = {}
): UserKeysStub {
  const fetches: Array<{ url: string; method: string }> = [];
  let fetchBarrier = opts.fetchBarrier;
  const fetchWaiters = { list: [] as Array<() => void> };
  return {
    fetches,
    failDelete: opts.failDelete,
    throwOnFetch: opts.throwOnFetch,
    fetchBarrier: opts.fetchBarrier,
    async fetch(req: Request): Promise<Response> {
      await withBarrier(
        fetchBarrier
          ? { match: () => true, count: fetchBarrier.count }
          : undefined,
        fetchWaiters,
        () => {
          fetchBarrier = undefined;
        }
      );
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
  db?: ReturnType<typeof createOidcRaceDb>;
  sessions?: RaceKv;
  crossSigning?: RaceKv;
  userKeys?: UserKeysStub;
  oidcKey?: string | undefined;
  serverName?: string;
} = {}): Env & {
  _db: ReturnType<typeof createOidcRaceDb>;
  _sessions: RaceKv;
  _crossSigning: RaceKv;
  _userKeys: UserKeysStub;
} {
  const sessions = opts.sessions ?? mockKv();
  const crossSigning = opts.crossSigning ?? mockKv();
  const userKeys = opts.userKeys ?? createUserKeysStub();
  const db = opts.db ?? createOidcRaceDb();

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
    _db: db,
    _sessions: sessions,
    _crossSigning: crossSigning,
    _userKeys: userKeys,
  } as unknown as Env & {
    _db: ReturnType<typeof createOidcRaceDb>;
    _sessions: RaceKv;
    _crossSigning: RaceKv;
    _userKeys: UserKeysStub;
  };
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = envFor()
): Promise<{ status: number; body: any; text: string; headers: Headers; res: Response }> {
  const url = path.startsWith('http') ? path : `https://${SERVER}${path}`;
  const res = await oidcAuth.request(url, init, env);
  const ct = res.headers.get('content-type') || '';
  let body: any = null;
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

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

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
    nonce: 'nonce-abc',
    redirectUri: `https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`,
    returnTo: '/',
    ...partial,
  });
  return state;
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
  fetchJWKS.mockResolvedValue({ keys: [] });
  buildAuthorizationUrl.mockImplementation(
    (_d: unknown, _cid: string, _ru: string, _sc: string, state: string, nonce: string) =>
      `${ISSUER}/authorize?client_id=client-abc&state=${state}&nonce=${nonce}`
  );
  generateRandomString.mockImplementation((n: number) => {
    randSeq += 1;
    const base = `r${randSeq}x`;
    return base.padEnd(n, '0').slice(0, n);
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
// Identity provider not found (404 JSON) ∥ sibling success login
// ---------------------------------------------------------------------------

describe('quinary oidc Identity provider not found under race after #277/#276 tip', () => {
  it('unknown provider ∥ disabled ∥ sibling success — exact M_NOT_FOUND bind', async () => {
    const secret = await encryptClientSecret();
    const db = createOidcRaceDb({
      providers: [
        seedProvider({ client_secret_encrypted: secret }),
        seedProvider({
          id: PROVIDER_B,
          name: 'GitHub',
          issuer_url: ISSUER_B,
          enabled: 0,
          client_secret_encrypted: secret,
        }),
      ],
    });
    const sessions = mockKv();
    const env = envFor({ db, sessions });
    const results = await Promise.all([
      request(`/auth/oidc/ghost/login`, {}, env),
      request(`/auth/oidc/${PROVIDER_B}/login`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login?return_to=/rooms`, {}, env),
    ]);
    const notFound = results.filter((r) => r.status === 404);
    expect(notFound.length).toBe(2);
    expect(
      notFound.every(
        (r) =>
          r.body.errcode === 'M_NOT_FOUND' &&
          r.body.error === 'Identity provider not found'
      )
    ).toBe(true);
    expect(Object.keys(notFound[0].body).sort()).toEqual(['errcode', 'error']);
    const ok = results.find((r) => r.status === 302)!;
    expect(ok.headers.get('Location')).toContain('/authorize?');
    expect(sessions.puts.some((p) => p.key.startsWith('oidc_state:'))).toBe(true);
  });

  it('dual unknown provider — both bind Identity provider not found; zero state puts', async () => {
    const sessions = mockKv();
    const env = envFor({
      db: createOidcRaceDb({ providers: [] }),
      sessions,
    });
    const results = await Promise.all([
      request(`/auth/oidc/a/login`, {}, env),
      request(`/auth/oidc/b/login`, {}, env),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(
      results.every((r) => r.body.error === 'Identity provider not found')
    ).toBe(true);
    expect(sessions.puts.filter((p) => p.key.startsWith('oidc_state:')).length).toBe(0);
  });

  for (let i = 0; i < 12; i++) {
    it(`Identity provider not found ∥ success flood-${i}`, async () => {
      const secret = await encryptClientSecret();
      const db = createOidcRaceDb({
        providers: [seedProvider({ client_secret_encrypted: secret })],
      });
      const sessions = mockKv();
      const env = envFor({ db, sessions });
      const missId = i % 2 === 0 ? `ghost-${i}` : PROVIDER_B;
      const results = await Promise.all([
        request(`/auth/oidc/${missId}/login`, {}, env),
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=/r${i}`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([302, 404]);
      expect(results.find((r) => r.status === 404)!.body).toEqual({
        errcode: 'M_NOT_FOUND',
        error: 'Identity provider not found',
      });
      expect(results.find((r) => r.status === 302)!.headers.get('Location')).toContain(
        'state='
      );
    });
  }
});

// ---------------------------------------------------------------------------
// The login session has expired ∥ valid redeem
// ---------------------------------------------------------------------------

describe('quinary oidc login session has expired under race after #277/#276 tip', () => {
  it('missing state ∥ valid redeem — HTML binds login session has expired', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const state = seedState(sessions, 'cb-ok-q5');
    getUserById.mockResolvedValue({ user_id: USER });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 1,
          provider_id: PROVIDER_ID,
          external_id: 'ext-sub-1',
          user_id: USER,
          external_email: 'alice@example.com',
          external_name: 'Alice',
        },
      ],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=c&state=gone`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ok&state=${state}`, {}, env),
    ]);
    const expired = results.find((r) =>
      r.text.includes('The login session has expired. Please try again.')
    )!;
    expect(expired.text).toContain('Invalid State');
    expect(results.some((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(sessions.data[`oidc_state:${state}`]).toBeUndefined();
  });

  it('dual missing state — both bind expired HTML; no success', async () => {
    const secret = await encryptClientSecret();
    const env = envFor({
      sessions: mockKv(),
      db: createOidcRaceDb({
        providers: [seedProvider({ client_secret_encrypted: secret })],
      }),
    });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=miss-a`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=miss-b`, {}, env),
    ]);
    expect(
      results.every((r) =>
        r.text.includes('The login session has expired. Please try again.')
      )
    ).toBe(true);
    expect(results.every((r) => r.text.includes('Invalid State'))).toBe(true);
    expect(results.every((r) => !r.text.includes('Login Successful'))).toBe(true);
  });

  for (let i = 0; i < 12; i++) {
    it(`login session has expired ∥ valid flood-${i}`, async () => {
      const secret = await encryptClientSecret();
      const sessions = mockKv();
      const state = seedState(sessions, `cb-exp-f-${i}`);
      getUserById.mockResolvedValue({ user_id: USER });
      validateIDToken.mockResolvedValue({
        sub: `ext-sub-${i}`,
        preferred_username: 'alice',
        email: 'alice@example.com',
        name: 'Alice',
      });
      const db = createOidcRaceDb({
        providers: [seedProvider({ client_secret_encrypted: secret })],
        links: [
          {
            id: 1,
            provider_id: PROVIDER_ID,
            external_id: `ext-sub-${i}`,
            user_id: USER,
            external_email: null,
            external_name: null,
          },
        ],
      });
      const env = envFor({ sessions, db });
      const results = await Promise.all([
        request(`/auth/oidc/${PROVIDER_ID}/callback?code=c&state=gone-${i}`, {}, env),
        request(`/auth/oidc/${PROVIDER_ID}/callback?code=ok${i}&state=${state}`, {}, env),
      ]);
      expect(
        results.some((r) =>
          r.text.includes('The login session has expired. Please try again.')
        )
      ).toBe(true);
      expect(results.some((r) => r.text.includes('Login Successful'))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// IdP error query Authentication Failed + error_description HTML ∥ success
// ---------------------------------------------------------------------------

describe('quinary oidc IdP error_description HTML bind under race after #277/#276 tip', () => {
  it('IdP error ∥ valid redeem — Authentication Failed + description; state preserved on error', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const state = seedState(sessions, 'cb-idp-ok');
    const stateKeep = seedState(sessions, 'cb-idp-keep');
    getUserById.mockResolvedValue({ user_id: USER });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 1,
          provider_id: PROVIDER_ID,
          external_id: 'ext-sub-1',
          user_id: USER,
          external_email: null,
          external_name: null,
        },
      ],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(
        `/auth/oidc/${PROVIDER_ID}/callback?error=access_denied&error_description=${encodeURIComponent('User cancelled consent')}&state=${stateKeep}`,
        {},
        env
      ),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ok&state=${state}`, {}, env),
    ]);
    const fail = results.find((r) => r.text.includes('Authentication Failed'))!;
    expect(fail.text).toContain('User cancelled consent');
    expect(results.some((r) => r.text.includes('Login Successful'))).toBe(true);
    // IdP error path does not consume state
    expect(sessions.data[`oidc_state:${stateKeep}`]).toBeTruthy();
    expect(sessions.data[`oidc_state:${state}`]).toBeUndefined();
  });

  it('IdP error without description falls back to error code under parallel soft', async () => {
    const sessions = mockKv();
    seedState(sessions, 'keep-a');
    seedState(sessions, 'keep-b');
    const env = envFor({
      sessions,
      db: createOidcRaceDb({
        providers: [seedProvider({ client_secret_encrypted: await encryptClientSecret() })],
      }),
    });
    const results = await Promise.all([
      request(
        `/auth/oidc/${PROVIDER_ID}/callback?error=server_error&state=keep-a`,
        {},
        env
      ),
      request(
        `/auth/oidc/${PROVIDER_ID}/callback?error=temporarily_unavailable&state=keep-b`,
        {},
        env
      ),
    ]);
    expect(results.every((r) => r.text.includes('Authentication Failed'))).toBe(true);
    expect(results.some((r) => r.text.includes('server_error'))).toBe(true);
    expect(results.some((r) => r.text.includes('temporarily_unavailable'))).toBe(true);
    expect(sessions.data['oidc_state:keep-a']).toBeTruthy();
    expect(sessions.data['oidc_state:keep-b']).toBeTruthy();
  });

  for (let i = 0; i < 12; i++) {
    it(`IdP error_description ∥ valid flood-${i}`, async () => {
      const secret = await encryptClientSecret();
      const sessions = mockKv();
      const state = seedState(sessions, `cb-idp-f-${i}`);
      const keep = seedState(sessions, `cb-idp-keep-${i}`);
      getUserById.mockResolvedValue({ user_id: USER });
      validateIDToken.mockResolvedValue({
        sub: `ext-sub-${i}`,
        preferred_username: 'alice',
        email: 'alice@example.com',
        name: 'Alice',
      });
      const db = createOidcRaceDb({
        providers: [seedProvider({ client_secret_encrypted: secret })],
        links: [
          {
            id: 1,
            provider_id: PROVIDER_ID,
            external_id: `ext-sub-${i}`,
            user_id: USER,
            external_email: null,
            external_name: null,
          },
        ],
      });
      const env = envFor({ sessions, db });
      const desc = `Denied reason ${i}`;
      const results = await Promise.all([
        request(
          `/auth/oidc/${PROVIDER_ID}/callback?error=access_denied&error_description=${encodeURIComponent(desc)}&state=${keep}`,
          {},
          env
        ),
        request(`/auth/oidc/${PROVIDER_ID}/callback?code=c${i}&state=${state}`, {}, env),
      ]);
      expect(results.some((r) => r.text.includes('Authentication Failed') && r.text.includes(desc))).toBe(
        true
      );
      expect(results.some((r) => r.text.includes('Login Successful'))).toBe(true);
      expect(sessions.data[`oidc_state:${keep}`]).toBeTruthy();
    });
  }
});
