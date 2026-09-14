/**
 * TOKENMAXX HEAVY leftovers after #283 quinary / tip past #277 — oidc-auth
 * *senary* concurrent-race niches: callback HTML soft-fails under
 * Promise.all that quaternary (#277) + quinary (#283) never claimed
 * (grep Provider mismatch / Provider Not Found / Account Not Found /
 * No account is linked in *oidc*quaternary* / *oidc*quinary* = 0).
 *
 * Soft/route leftovers bind these sequentially (oidc-auth-api-routes);
 * megaflood dual-fails exist but numbered waves never raced exact HTML
 * ∥ Login Successful sibling. Senary deepen:
 *   Provider mismatch (state burned) ∥ valid redeem success;
 *   Provider Not Found / disabled after state consume ∥ success;
 *   Account Not Found (auto_create=0) + exact `No account is linked`
 *   ∥ success sibling;
 *   catch Authentication Failed with exact String(err) from exchange /
 *   validateIDToken throw ∥ success (state burned on fail).
 *
 * Distinct from #283 oidc quinary (login 404 / expired state / IdP error
 * query), #277 quaternary (Failed to initiate/reset / Missing code),
 * #268 megaflood. Orthogonal to oauth senary (external IdP SSO).
 * New file. Tests-only. example.com fixtures only. Reversible by delete.
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
// Provider mismatch HTML ∥ Login Successful
// ---------------------------------------------------------------------------

describe('senary oidc Provider mismatch under race after #283 tip', () => {
  it('wrong provider path ∥ valid redeem — Provider mismatch; state burned; sibling success', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const mismatch = seedState(sessions, 'mm-a');
    const okState = seedState(sessions, 'mm-ok');
    const db = createOidcRaceDb({
      providers: [
        seedProvider({ client_secret_encrypted: secret }),
        seedProvider({
          id: PROVIDER_B,
          name: 'GitHub',
          issuer_url: ISSUER_B,
          client_secret_encrypted: secret,
          display_order: 2,
        }),
      ],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_B}/callback?code=x&state=${mismatch}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=y&state=${okState}`, {}, env),
    ]);
    const fail = results.find((r) => r.text.includes('Provider mismatch'))!;
    expect(fail.text).toContain('Invalid State');
    expect(fail.text).toContain('Provider mismatch');
    expect(results.some((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(sessions.data[`oidc_state:${mismatch}`]).toBeUndefined();
    expect(sessions.deletes).toEqual(
      expect.arrayContaining([`oidc_state:${mismatch}`, `oidc_state:${okState}`])
    );
  });

  it('dual Provider mismatch — both bind; createDevice never called', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'mm-d1');
    const s2 = seedState(sessions, 'mm-d2');
    const db = createOidcRaceDb({
      providers: [
        seedProvider({ client_secret_encrypted: secret }),
        seedProvider({
          id: PROVIDER_B,
          name: 'GitHub',
          issuer_url: ISSUER_B,
          client_secret_encrypted: secret,
        }),
      ],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_B}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_B}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Provider mismatch'))).toBe(true);
    expect(createDevice).not.toHaveBeenCalled();
    expect(sessions.data[`oidc_state:${s1}`]).toBeUndefined();
    expect(sessions.data[`oidc_state:${s2}`]).toBeUndefined();
  });

  for (let i = 0; i < 10; i++) {
    it(`Provider mismatch ∥ success flood-${i}`, async () => {
      const secret = await encryptClientSecret();
      const sessions = mockKv();
      const bad = seedState(sessions, `mm-f-${i}`);
      const ok = seedState(sessions, `mm-ok-${i}`);
      const db = createOidcRaceDb({
        providers: [
          seedProvider({ client_secret_encrypted: secret }),
          seedProvider({
            id: PROVIDER_B,
            name: 'GitHub',
            issuer_url: ISSUER_B,
            client_secret_encrypted: secret,
          }),
        ],
      });
      const env = envFor({ sessions, db });
      const results = await Promise.all([
        request(`/auth/oidc/${PROVIDER_B}/callback?code=bad&state=${bad}`, {}, env),
        request(`/auth/oidc/${PROVIDER_ID}/callback?code=ok&state=${ok}`, {}, env),
      ]);
      expect(results.some((r) => r.text.includes('Provider mismatch'))).toBe(true);
      expect(results.some((r) => r.text.includes('Login Successful'))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Provider Not Found (disabled) HTML ∥ Login Successful
// ---------------------------------------------------------------------------

describe('senary oidc Provider Not Found under race after #283 tip', () => {
  it('disabled provider callback ∥ enabled sibling — Provider Not Found + No account text path', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const bad = seedState(sessions, 'pnf-a');
    const ok = seedState(sessions, 'pnf-ok', { providerId: PROVIDER_B });
    const db = createOidcRaceDb({
      providers: [
        seedProvider({ client_secret_encrypted: secret, enabled: 0 }),
        seedProvider({
          id: PROVIDER_B,
          name: 'GitHub',
          issuer_url: ISSUER_B,
          client_secret_encrypted: secret,
          enabled: 1,
        }),
      ],
    });
    const env = envFor({ sessions, db });
    // sibling success needs discovery for PROVIDER_B issuer — override per call via mock
    fetchOIDCDiscovery.mockImplementation(async (issuer: string) => ({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    }));
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=x&state=${bad}`, {}, env),
      request(`/auth/oidc/${PROVIDER_B}/callback?code=y&state=${ok}`, {}, env),
    ]);
    const fail = results.find((r) => r.text.includes('Provider Not Found'))!;
    expect(fail.text).toContain('Identity provider not found or disabled');
    expect(results.some((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(sessions.data[`oidc_state:${bad}`]).toBeUndefined();
  });

  it('dual disabled Provider Not Found — both bind exact description; states burned', async () => {
    const sessions = mockKv();
    const s1 = seedState(sessions, 'pnf-d1');
    const s2 = seedState(sessions, 'pnf-d2');
    const db = createOidcRaceDb({
      providers: [seedProvider({ enabled: 0 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Provider Not Found'))).toBe(true);
    expect(
      results.every((r) => r.text.includes('Identity provider not found or disabled'))
    ).toBe(true);
    expect(createDevice).not.toHaveBeenCalled();
  });

  for (let i = 0; i < 8; i++) {
    it(`Provider Not Found ∥ success flood-${i}`, async () => {
      const secret = await encryptClientSecret();
      const sessions = mockKv();
      const bad = seedState(sessions, `pnf-f-${i}`);
      const ok = seedState(sessions, `pnf-ok-${i}`);
      const db = createOidcRaceDb({
        providers: [
          seedProvider({ id: 'disabled-x', enabled: 0, client_secret_encrypted: secret }),
          seedProvider({ client_secret_encrypted: secret }),
        ],
      });
      // bad state points at disabled provider id
      sessions.data[`oidc_state:${bad}`] = JSON.stringify({
        providerId: 'disabled-x',
        nonce: 'nonce-abc',
        redirectUri: `https://${SERVER}/auth/oidc/disabled-x/callback`,
        returnTo: '/',
      });
      const env = envFor({ sessions, db });
      const results = await Promise.all([
        request(`/auth/oidc/disabled-x/callback?code=bad&state=${bad}`, {}, env),
        request(`/auth/oidc/${PROVIDER_ID}/callback?code=ok&state=${ok}`, {}, env),
      ]);
      expect(results.some((r) => r.text.includes('Provider Not Found'))).toBe(true);
      expect(results.some((r) => r.text.includes('Login Successful'))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Account Not Found (auto_create=0) ∥ Login Successful
// ---------------------------------------------------------------------------

describe('senary oidc Account Not Found under race after #283 tip', () => {
  it('auto_create=0 ∥ auto_create=1 sibling — Account Not Found + No account is linked', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const bad = seedState(sessions, 'acf-a');
    const ok = seedState(sessions, 'acf-ok', { providerId: PROVIDER_B });
    validateIDToken.mockImplementation(async () => ({
      sub: 'orphan-sub',
      preferred_username: 'orphan',
      email: 'orphan@example.com',
    }));
    const db = createOidcRaceDb({
      providers: [
        seedProvider({ client_secret_encrypted: secret, auto_create_users: 0 }),
        seedProvider({
          id: PROVIDER_B,
          name: 'GitHub',
          issuer_url: ISSUER_B,
          client_secret_encrypted: secret,
          auto_create_users: 1,
        }),
      ],
    });
    fetchOIDCDiscovery.mockImplementation(async (issuer: string) => ({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    }));
    deriveUsername.mockReturnValue('newuser');
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=x&state=${bad}`, {}, env),
      request(`/auth/oidc/${PROVIDER_B}/callback?code=y&state=${ok}`, {}, env),
    ]);
    const fail = results.find((r) => r.text.includes('Account Not Found'))!;
    expect(fail.text).toContain('No account is linked to this identity');
    expect(results.some((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(sessions.data[`oidc_state:${bad}`]).toBeUndefined();
  });

  it('dual auto_create=0 — both Account Not Found; createUser never', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'acf-d1');
    const s2 = seedState(sessions, 'acf-d2');
    validateIDToken.mockResolvedValue({
      sub: 'orphan-dual',
      preferred_username: 'orphan2',
    });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 0 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Account Not Found'))).toBe(true);
    expect(results.every((r) => r.text.includes('No account is linked'))).toBe(true);
    expect(createUser).not.toHaveBeenCalled();
  });

  for (let i = 0; i < 8; i++) {
    it(`Account Not Found ∥ success flood-${i}`, async () => {
      const secret = await encryptClientSecret();
      const sessions = mockKv();
      const bad = seedState(sessions, `acf-f-${i}`);
      const ok = seedState(sessions, `acf-ok-${i}`, { providerId: PROVIDER_B });
      validateIDToken.mockResolvedValue({
        sub: `orphan-f-${i}`,
        preferred_username: `orphan${i}`,
      });
      deriveUsername.mockReturnValue(`user${i}`);
      const db = createOidcRaceDb({
        providers: [
          seedProvider({ client_secret_encrypted: secret, auto_create_users: 0 }),
          seedProvider({
            id: PROVIDER_B,
            name: 'GitHub',
            issuer_url: ISSUER_B,
            client_secret_encrypted: secret,
            auto_create_users: 1,
          }),
        ],
      });
      fetchOIDCDiscovery.mockImplementation(async (issuer: string) => ({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      }));
      const env = envFor({ sessions, db });
      const results = await Promise.all([
        request(`/auth/oidc/${PROVIDER_ID}/callback?code=bad&state=${bad}`, {}, env),
        request(`/auth/oidc/${PROVIDER_B}/callback?code=ok&state=${ok}`, {}, env),
      ]);
      expect(results.some((r) => r.text.includes('Account Not Found'))).toBe(true);
      expect(results.some((r) => r.text.includes('Login Successful'))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// catch Authentication Failed exact String(err) ∥ Login Successful
// ---------------------------------------------------------------------------

describe('senary oidc catch Authentication Failed String(err) under race after #283 tip', () => {
  it('exchange throw ∥ valid — Authentication Failed binds exact err message; state burned', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const bad = seedState(sessions, 'ex-fail');
    const ok = seedState(sessions, 'ex-ok');
    exchangeCodeForTokens.mockImplementation(async (_d, _c, _s, code: string) => {
      if (code === 'bad') throw new Error('exchange-fail-senary');
      return {
        access_token: 'idp-at',
        token_type: 'Bearer',
        id_token: 'fake.jwt.token',
      };
    });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=bad&state=${bad}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ok&state=${ok}`, {}, env),
    ]);
    const fail = results.find((r) => r.text.includes('Authentication Failed'))!;
    expect(fail.text).toContain('exchange-fail-senary');
    expect(results.some((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(sessions.data[`oidc_state:${bad}`]).toBeUndefined();
  });

  it('validateIDToken throw ∥ valid — Authentication Failed binds exact err', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    // Gate on nonce so concurrent siblings stay deterministic under Promise.all
    seedState(sessions, 'jwt-fail', { nonce: 'nonce-bad' });
    seedState(sessions, 'jwt-ok', { nonce: 'nonce-ok' });
    validateIDToken.mockImplementation(async (_tok, _iss, _aud, nonce: string) => {
      if (nonce === 'nonce-bad') throw new Error('bad-jwt-senary');
      return {
        sub: 'ext-sub-1',
        email: 'alice@example.com',
        name: 'Alice Example',
        preferred_username: 'alice',
      };
    });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=bad&state=jwt-fail`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ok&state=jwt-ok`, {}, env),
    ]);
    expect(results.some((r) => r.text.includes('bad-jwt-senary'))).toBe(true);
    expect(results.some((r) => r.text.includes('Authentication Failed'))).toBe(true);
    expect(results.some((r) => r.text.includes('Login Successful'))).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`catch Authentication Failed ∥ success flood-${i}`, async () => {
      const secret = await encryptClientSecret();
      const sessions = mockKv();
      const msg = `senary-fail-${i}`;
      if (i % 2 === 0) {
        seedState(sessions, `catch-f-${i}`);
        seedState(sessions, `catch-ok-${i}`);
        exchangeCodeForTokens.mockImplementation(async (_d, _c, _s, code: string) => {
          if (code === 'bad') throw new Error(msg);
          return {
            access_token: 'idp-at',
            token_type: 'Bearer',
            id_token: 'fake.jwt.token',
          };
        });
        validateIDToken.mockResolvedValue({
          sub: 'ext-sub-1',
          preferred_username: 'alice',
        });
      } else {
        seedState(sessions, `catch-f-${i}`, { nonce: `nonce-bad-${i}` });
        seedState(sessions, `catch-ok-${i}`, { nonce: `nonce-ok-${i}` });
        exchangeCodeForTokens.mockResolvedValue({
          access_token: 'idp-at',
          token_type: 'Bearer',
          id_token: 'fake.jwt.token',
        });
        validateIDToken.mockImplementation(async (_tok, _iss, _aud, nonce: string) => {
          if (nonce === `nonce-bad-${i}`) throw new Error(msg);
          return {
            sub: 'ext-sub-1',
            preferred_username: 'alice',
          };
        });
      }
      const db = createOidcRaceDb({
        providers: [seedProvider({ client_secret_encrypted: secret })],
      });
      const env = envFor({ sessions, db });
      const results = await Promise.all([
        request(
          `/auth/oidc/${PROVIDER_ID}/callback?code=bad&state=catch-f-${i}`,
          {},
          env
        ),
        request(
          `/auth/oidc/${PROVIDER_ID}/callback?code=ok&state=catch-ok-${i}`,
          {},
          env
        ),
      ]);
      expect(
        results.some((r) => r.text.includes('Authentication Failed') && r.text.includes(msg))
      ).toBe(true);
      expect(results.some((r) => r.text.includes('Login Successful'))).toBe(true);
    });
  }
});
