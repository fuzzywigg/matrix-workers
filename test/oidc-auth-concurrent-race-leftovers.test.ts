/**
 * TOKENMAXX HEAVY leftovers after #221 / deepen after #232 / residual after #238
 * — oidc-auth *concurrent race / TOCTOU* for `src/api/oidc-auth.ts`
 * (providers / login / callback / auth_metadata / MSC3861 identity reset).
 *
 * Soft/route leftovers for oidc-auth are deep (#113/#143/#147) but concurrent-
 * race coverage was near-zero: only a sequential "consumes state exactly once"
 * case in oidc-auth-api-routes (no Promise.all / SESSIONS get-barrier double-
 * spend / parallel login state mint / identity-reset races).
 *
 * Distinct from tip #241 (devices+keybackups residual), #240 (room-cache),
 * #239 (admin+federation), #238 (this slice's prior deepen), and saturated
 * keys/media/rooms/voip/sync/push/login-qr-identity concurrent-race files.
 * Orthogonal to oauth-concurrent-race — this slice is *external IdP* SSO,
 * not `/oauth/*` AS provider.
 *
 * Focus: parallel login distinct oidc_state mint; callback state double-
 * consume get-barrier TOCTOU; distinct-state parallel redeem; provider
 * disable mid-callback SELECT barrier; providers∥login coherency;
 * existing-link UPDATE∥UPDATE; auto-create dual INSERT race; identity
 * reset∥reset stream/KV/DO; auth_metadata soft floods; method/query/KV
 * fail soft under Promise.all; TTL bind contracts.
 * Residual after #238: claims.name display_name UPDATE, redirectUri exchange
 * bind, link email/name UPDATE, icon_url, KV user: wipe, dual-provider
 * state, success page device bind, deriveUsername claim, SSO device name,
 * signatures DELETE args.
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
const PROVIDER_B = 'github';
const ISSUER = 'https://accounts.example-idp.com';
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
  mutateProvidersAfterSelects?: { after: number; next: IdPProvider[] };
  mutateLinksAfterSelects?: { after: number; next: IdPUserLink[] };
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
            if (opts.mutateProvidersAfterSelects && selectCount === opts.mutateProvidersAfterSelects.after) {
              providers.splice(0, providers.length, ...opts.mutateProvidersAfterSelects.next);
            }
            return { results: rows as T[] };
          }
          if (opts.mutateProvidersAfterSelects && selectCount === opts.mutateProvidersAfterSelects.after) {
            providers.splice(0, providers.length, ...opts.mutateProvidersAfterSelects.next);
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
              if (opts.mutateProvidersAfterSelects && selectCount === opts.mutateProvidersAfterSelects.after) {
                providers.splice(0, providers.length, ...opts.mutateProvidersAfterSelects.next);
              }
              if (opts.mutateLinksAfterSelects && selectCount === opts.mutateLinksAfterSelects.after) {
                links.splice(0, links.length, ...opts.mutateLinksAfterSelects.next);
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
) {
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
  fetchJWKS.mockResolvedValue({ keys: [{ kty: 'RSA', kid: 'k1' }] });
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
// Parallel login — distinct oidc_state mint / SESSIONS put barriers
// ---------------------------------------------------------------------------

describe('race oidc login parallel state mint after #221', () => {
  it('dual login yields two distinct oidc_state puts with TTL 600', async () => {
    const sessions = mockKv();
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login?return_to=/a`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const statePuts = sessions.puts.filter((p) => p.key.startsWith('oidc_state:'));
    expect(statePuts).toHaveLength(2);
    expect(new Set(statePuts.map((p) => p.key)).size).toBe(2);
    for (const p of statePuts) {
      expect(p.options?.expirationTtl).toBe(600);
    }
    const locs = results.map((r) => r.headers.get('location') || '');
    expect(locs[0]).not.toBe(locs[1]);
  });

  it('quad login under put barrier still mints four distinct states', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 4, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=/q${i}`, {}, env)
      )
    );
    expect(statusesOf(results)).toEqual([302, 302, 302, 302]);
    expect(sessions.puts.filter((p) => p.key.startsWith('oidc_state:')).length).toBe(4);
    expect(new Set(Object.keys(sessions.data).filter((k) => k.startsWith('oidc_state:'))).size).toBe(
      4
    );
  });

  it('parallel login flood-0: 3 concurrent mints isolate return_to', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 3, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const returns = ['/x0', '/y0', '/z0'];
    const results = await Promise.all(
      returns.map((rt) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=${encodeURIComponent(rt)}`, {}, env)
      )
    );
    expect(statusesOf(results)).toEqual([302, 302, 302]);
    const stored = Object.values(sessions.data)
      .map((v) => JSON.parse(v).returnTo as string)
      .sort();
    expect(stored).toEqual([...returns].sort());
  });

  it('parallel login flood-1: 3 concurrent mints isolate return_to', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 3, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const returns = ['/x1', '/y1', '/z1'];
    const results = await Promise.all(
      returns.map((rt) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=${encodeURIComponent(rt)}`, {}, env)
      )
    );
    expect(statusesOf(results)).toEqual([302, 302, 302]);
    const stored = Object.values(sessions.data)
      .map((v) => JSON.parse(v).returnTo as string)
      .sort();
    expect(stored).toEqual([...returns].sort());
  });

  it('parallel login flood-2: 3 concurrent mints isolate return_to', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 3, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const returns = ['/x2', '/y2', '/z2'];
    const results = await Promise.all(
      returns.map((rt) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=${encodeURIComponent(rt)}`, {}, env)
      )
    );
    expect(statusesOf(results)).toEqual([302, 302, 302]);
    const stored = Object.values(sessions.data)
      .map((v) => JSON.parse(v).returnTo as string)
      .sort();
    expect(stored).toEqual([...returns].sort());
  });

  it('parallel login flood-3: 3 concurrent mints isolate return_to', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 3, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const returns = ['/x3', '/y3', '/z3'];
    const results = await Promise.all(
      returns.map((rt) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=${encodeURIComponent(rt)}`, {}, env)
      )
    );
    expect(statusesOf(results)).toEqual([302, 302, 302]);
    const stored = Object.values(sessions.data)
      .map((v) => JSON.parse(v).returnTo as string)
      .sort();
    expect(stored).toEqual([...returns].sort());
  });

  it('parallel login flood-4: 3 concurrent mints isolate return_to', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 3, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const returns = ['/x4', '/y4', '/z4'];
    const results = await Promise.all(
      returns.map((rt) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=${encodeURIComponent(rt)}`, {}, env)
      )
    );
    expect(statusesOf(results)).toEqual([302, 302, 302]);
    const stored = Object.values(sessions.data)
      .map((v) => JSON.parse(v).returnTo as string)
      .sort();
    expect(stored).toEqual([...returns].sort());
  });

  it('parallel login flood-5: 3 concurrent mints isolate return_to', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 3, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const returns = ['/x5', '/y5', '/z5'];
    const results = await Promise.all(
      returns.map((rt) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=${encodeURIComponent(rt)}`, {}, env)
      )
    );
    expect(statusesOf(results)).toEqual([302, 302, 302]);
    const stored = Object.values(sessions.data)
      .map((v) => JSON.parse(v).returnTo as string)
      .sort();
    expect(stored).toEqual([...returns].sort());
  });

  it('parallel login flood-6: 3 concurrent mints isolate return_to', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 3, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const returns = ['/x6', '/y6', '/z6'];
    const results = await Promise.all(
      returns.map((rt) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=${encodeURIComponent(rt)}`, {}, env)
      )
    );
    expect(statusesOf(results)).toEqual([302, 302, 302]);
    const stored = Object.values(sessions.data)
      .map((v) => JSON.parse(v).returnTo as string)
      .sort();
    expect(stored).toEqual([...returns].sort());
  });

  it('parallel login flood-7: 3 concurrent mints isolate return_to', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 3, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const returns = ['/x7', '/y7', '/z7'];
    const results = await Promise.all(
      returns.map((rt) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=${encodeURIComponent(rt)}`, {}, env)
      )
    );
    expect(statusesOf(results)).toEqual([302, 302, 302]);
    const stored = Object.values(sessions.data)
      .map((v) => JSON.parse(v).returnTo as string)
      .sort();
    expect(stored).toEqual([...returns].sort());
  });

  it('parallel login flood-8: 3 concurrent mints isolate return_to', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 3, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const returns = ['/x8', '/y8', '/z8'];
    const results = await Promise.all(
      returns.map((rt) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=${encodeURIComponent(rt)}`, {}, env)
      )
    );
    expect(statusesOf(results)).toEqual([302, 302, 302]);
    const stored = Object.values(sessions.data)
      .map((v) => JSON.parse(v).returnTo as string)
      .sort();
    expect(stored).toEqual([...returns].sort());
  });

  it('parallel login flood-9: 3 concurrent mints isolate return_to', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 3, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const returns = ['/x9', '/y9', '/z9'];
    const results = await Promise.all(
      returns.map((rt) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=${encodeURIComponent(rt)}`, {}, env)
      )
    );
    expect(statusesOf(results)).toEqual([302, 302, 302]);
    const stored = Object.values(sessions.data)
      .map((v) => JSON.parse(v).returnTo as string)
      .sort();
    expect(stored).toEqual([...returns].sort());
  });

  it('parallel login flood-10: 3 concurrent mints isolate return_to', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 3, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const returns = ['/x10', '/y10', '/z10'];
    const results = await Promise.all(
      returns.map((rt) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=${encodeURIComponent(rt)}`, {}, env)
      )
    );
    expect(statusesOf(results)).toEqual([302, 302, 302]);
    const stored = Object.values(sessions.data)
      .map((v) => JSON.parse(v).returnTo as string)
      .sort();
    expect(stored).toEqual([...returns].sort());
  });

  it('parallel login flood-11: 3 concurrent mints isolate return_to', async () => {
    const sessions = mockKv(
      {},
      { putBarrier: { count: 3, match: (k) => k.startsWith('oidc_state:') } }
    );
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const returns = ['/x11', '/y11', '/z11'];
    const results = await Promise.all(
      returns.map((rt) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=${encodeURIComponent(rt)}`, {}, env)
      )
    );
    expect(statusesOf(results)).toEqual([302, 302, 302]);
    const stored = Object.values(sessions.data)
      .map((v) => JSON.parse(v).returnTo as string)
      .sort();
    expect(stored).toEqual([...returns].sort());
  });

  it('eight-way login isolation — all redirect with unique states', async () => {
    const sessions = mockKv();
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=/e${i}`, {}, env)
      )
    );
    expect(results.every((r) => r.status === 302)).toBe(true);
    expect(new Set(Object.keys(sessions.data).filter((k) => k.startsWith('oidc_state:'))).size).toBe(
      8
    );
  });

  it('unknown provider parallel soft — both 404', async () => {
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ db });
    const results = await Promise.all([
      request('/auth/oidc/missing/login', {}, env),
      request('/auth/oidc/missing/login', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
    for (const r of results) {
      expect(r.body.errcode).toBe('M_NOT_FOUND');
    }
  });

  it('disabled provider parallel soft — both 404', async () => {
    const db = createOidcRaceDb({ providers: [seedProvider({ enabled: 0 })] });
    const env = envFor({ db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  it('discovery throw under parallel soft — both 500 M_UNKNOWN', async () => {
    fetchOIDCDiscovery.mockRejectedValue(new Error('disco-down'));
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
    for (const r of results) expect(r.body.errcode).toBe('M_UNKNOWN');
  });

  it('KV put fail mid parallel login — one may 500', async () => {
    const sessions = mockKv({}, { failPutAfter: 1 });
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
    ]);
    const oks = results.filter((r) => r.status === 302).length;
    const fails = results.filter((r) => r.status === 500).length;
    expect(oks + fails).toBe(2);
    expect(fails).toBeGreaterThanOrEqual(1);
  });

  it('login stores providerId matching path under parallel', async () => {
    const sessions = mockKv();
    const db = createOidcRaceDb({
      providers: [
        seedProvider(),
        seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 }),
      ],
    });
    const env = envFor({ sessions, db });
    await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request(`/auth/oidc/${PROVIDER_B}/login`, {}, env),
    ]);
    const byProvider = Object.values(sessions.data).map((v) => JSON.parse(v).providerId).sort();
    expect(byProvider).toEqual([PROVIDER_B, PROVIDER_ID].sort());
  });
});


// ---------------------------------------------------------------------------
// Callback state double-consume get-barrier TOCTOU
// ---------------------------------------------------------------------------

describe('race oidc callback state double-consume TOCTOU after #221', () => {
  it('dual callback same state under get barrier — both observe state (single-use race)', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oidc_state:') } }
    );
    const state = seedState(sessions, 'shared-state-1');
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=c1&state=${state}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=c2&state=${state}`, {}, env),
    ]);
    // Both passed the get barrier with state present — race documents double success possible
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.text.includes('Login Successful')).length).toBeGreaterThanOrEqual(1);
    expect(sessions.deletes.filter((k) => k === `oidc_state:${state}`).length).toBe(2);
    expect(createDevice.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('sequential double-callback — second Invalid State', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const state = seedState(sessions, 'seq-state');
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
    const first = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      env
    );
    const second = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      env
    );
    expect(first.text).toContain('Login Successful');
    expect(second.text).toContain('Invalid State');
  });

  it('distinct states parallel redeem flood-0', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'd0-a');
    const s2 = seedState(sessions, 'd0-b');
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ca0&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=cb0&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createDevice.mock.calls.length).toBe(2);
    expect(createAccessToken.mock.calls.length).toBe(2);
  });

  it('distinct states parallel redeem flood-1', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'd1-a');
    const s2 = seedState(sessions, 'd1-b');
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ca1&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=cb1&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createDevice.mock.calls.length).toBe(2);
    expect(createAccessToken.mock.calls.length).toBe(2);
  });

  it('distinct states parallel redeem flood-2', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'd2-a');
    const s2 = seedState(sessions, 'd2-b');
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ca2&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=cb2&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createDevice.mock.calls.length).toBe(2);
    expect(createAccessToken.mock.calls.length).toBe(2);
  });

  it('distinct states parallel redeem flood-3', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'd3-a');
    const s2 = seedState(sessions, 'd3-b');
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ca3&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=cb3&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createDevice.mock.calls.length).toBe(2);
    expect(createAccessToken.mock.calls.length).toBe(2);
  });

  it('distinct states parallel redeem flood-4', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'd4-a');
    const s2 = seedState(sessions, 'd4-b');
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ca4&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=cb4&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createDevice.mock.calls.length).toBe(2);
    expect(createAccessToken.mock.calls.length).toBe(2);
  });

  it('distinct states parallel redeem flood-5', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'd5-a');
    const s2 = seedState(sessions, 'd5-b');
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ca5&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=cb5&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createDevice.mock.calls.length).toBe(2);
    expect(createAccessToken.mock.calls.length).toBe(2);
  });

  it('distinct states parallel redeem flood-6', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'd6-a');
    const s2 = seedState(sessions, 'd6-b');
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ca6&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=cb6&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createDevice.mock.calls.length).toBe(2);
    expect(createAccessToken.mock.calls.length).toBe(2);
  });

  it('distinct states parallel redeem flood-7', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'd7-a');
    const s2 = seedState(sessions, 'd7-b');
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ca7&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=cb7&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createDevice.mock.calls.length).toBe(2);
    expect(createAccessToken.mock.calls.length).toBe(2);
  });

  it('distinct states parallel redeem flood-8', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'd8-a');
    const s2 = seedState(sessions, 'd8-b');
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ca8&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=cb8&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createDevice.mock.calls.length).toBe(2);
    expect(createAccessToken.mock.calls.length).toBe(2);
  });

  it('distinct states parallel redeem flood-9', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'd9-a');
    const s2 = seedState(sessions, 'd9-b');
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ca9&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=cb9&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createDevice.mock.calls.length).toBe(2);
    expect(createAccessToken.mock.calls.length).toBe(2);
  });

  it('distinct states parallel redeem flood-10', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'd10-a');
    const s2 = seedState(sessions, 'd10-b');
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ca10&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=cb10&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createDevice.mock.calls.length).toBe(2);
    expect(createAccessToken.mock.calls.length).toBe(2);
  });

  it('distinct states parallel redeem flood-11', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'd11-a');
    const s2 = seedState(sessions, 'd11-b');
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=ca11&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=cb11&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createDevice.mock.calls.length).toBe(2);
    expect(createAccessToken.mock.calls.length).toBe(2);
  });

  it('missing state parallel soft — both Invalid State', async () => {
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ db, sessions: mockKv() });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=c&state=gone`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=c&state=gone`, {}, env),
    ]);
    for (const r of results) expect(r.text).toContain('Invalid State');
  });

  it('mutate wipe state after first get — second Invalid State', async () => {
    const secret = await encryptClientSecret();
    const state = 'wipe-state';
    const sessions = mockKv(
      {
        [`oidc_state:${state}`]: JSON.stringify({
          providerId: PROVIDER_ID,
          nonce: 'nonce-abc',
          redirectUri: `https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`,
          returnTo: '/',
        }),
      },
      { mutateAfterGets: { after: 1, next: {} } }
    );
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
    const first = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c1&state=${state}`,
      {},
      env
    );
    const second = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c2&state=${state}`,
      {},
      env
    );
    expect(first.text).toContain('Login Successful');
    expect(second.text).toContain('Invalid State');
  });

  it('provider mismatch parallel soft after state delete', async () => {
    const sessions = mockKv();
    const state = seedState(sessions, 'mismatch', { providerId: 'other' });
    const db = createOidcRaceDb({ providers: [seedProvider()] });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`, {}, env),
    ]);
    // First consumes and mismatches; second missing state
    expect(results.some((r) => r.text.includes('Provider mismatch') || r.text.includes('Invalid State'))).toBe(
      true
    );
  });

  it('IdP error query parallel soft — no state consume', async () => {
    const sessions = mockKv();
    seedState(sessions, 'keep-me');
    const env = envFor({ sessions, db: createOidcRaceDb({ providers: [seedProvider()] }) });
    const results = await Promise.all([
      request(
        `/auth/oidc/${PROVIDER_ID}/callback?error=access_denied&error_description=nope`,
        {},
        env
      ),
      request(`/auth/oidc/${PROVIDER_ID}/callback?error=server_error`, {}, env),
    ]);
    for (const r of results) expect(r.text).toContain('Authentication Failed');
    expect(sessions.data['oidc_state:keep-me']).toBeTruthy();
  });

  it('missing code/state parallel soft', async () => {
    const env = envFor({ db: createOidcRaceDb({ providers: [seedProvider()] }) });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?state=x`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=y`, {}, env),
    ]);
    for (const r of results) expect(r.text).toContain('Invalid Request');
  });
});


// ---------------------------------------------------------------------------
// Provider disable mid-callback SELECT barrier / providers∥login
// ---------------------------------------------------------------------------

describe('race oidc provider disable mid-callback after #221', () => {
  it('provider disable between login and callback — Provider Not Found', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const state = seedState(sessions, 'dis-1');
    const provider = seedProvider({ client_secret_encrypted: secret });
    const db = createOidcRaceDb({ providers: [provider] });
    const env = envFor({ sessions, db });
    // Admin disables IdP after user already holds oidc_state (shared row object)
    provider.enabled = 0;
    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      env
    );
    expect(text).toContain('Provider Not Found');
  });

  it('dual callback under provider SELECT barrier — both observe enabled row', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'bar-a');
    const s2 = seedState(sessions, 'bar-b');
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM idp_providers WHERE id = ? AND enabled = 1'),
      },
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
  });

  it('callback after explicit disable — Provider Not Found under parallel soft', async () => {
    const sessions = mockKv();
    const s1 = seedState(sessions, 'dis-a');
    const s2 = seedState(sessions, 'dis-b');
    const db = createOidcRaceDb({
      providers: [seedProvider({ enabled: 0 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${s2}`, {}, env),
    ]);
    for (const r of results) expect(r.text).toContain('Provider Not Found');
  });

  it('providers∥login coherency flood-0', async () => {
    const sessions = mockKv();
    const db = createOidcRaceDb({
      providers: [
        seedProvider(),
        seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 }),
      ],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[2].status).toBe(200);
    expect(results[1].status).toBe(302);
    expect(results[0].body.providers.map((p: { id: string }) => p.id).sort()).toEqual(
      [PROVIDER_B, PROVIDER_ID].sort()
    );
    expect(results[0].body.providers.every((p: { login_url: string }) => p.login_url.includes('/login'))).toBe(
      true
    );
  });

  it('providers∥login coherency flood-1', async () => {
    const sessions = mockKv();
    const db = createOidcRaceDb({
      providers: [
        seedProvider(),
        seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 }),
      ],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[2].status).toBe(200);
    expect(results[1].status).toBe(302);
    expect(results[0].body.providers.map((p: { id: string }) => p.id).sort()).toEqual(
      [PROVIDER_B, PROVIDER_ID].sort()
    );
    expect(results[0].body.providers.every((p: { login_url: string }) => p.login_url.includes('/login'))).toBe(
      true
    );
  });

  it('providers∥login coherency flood-2', async () => {
    const sessions = mockKv();
    const db = createOidcRaceDb({
      providers: [
        seedProvider(),
        seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 }),
      ],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[2].status).toBe(200);
    expect(results[1].status).toBe(302);
    expect(results[0].body.providers.map((p: { id: string }) => p.id).sort()).toEqual(
      [PROVIDER_B, PROVIDER_ID].sort()
    );
    expect(results[0].body.providers.every((p: { login_url: string }) => p.login_url.includes('/login'))).toBe(
      true
    );
  });

  it('providers∥login coherency flood-3', async () => {
    const sessions = mockKv();
    const db = createOidcRaceDb({
      providers: [
        seedProvider(),
        seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 }),
      ],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[2].status).toBe(200);
    expect(results[1].status).toBe(302);
    expect(results[0].body.providers.map((p: { id: string }) => p.id).sort()).toEqual(
      [PROVIDER_B, PROVIDER_ID].sort()
    );
    expect(results[0].body.providers.every((p: { login_url: string }) => p.login_url.includes('/login'))).toBe(
      true
    );
  });

  it('providers∥login coherency flood-4', async () => {
    const sessions = mockKv();
    const db = createOidcRaceDb({
      providers: [
        seedProvider(),
        seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 }),
      ],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[2].status).toBe(200);
    expect(results[1].status).toBe(302);
    expect(results[0].body.providers.map((p: { id: string }) => p.id).sort()).toEqual(
      [PROVIDER_B, PROVIDER_ID].sort()
    );
    expect(results[0].body.providers.every((p: { login_url: string }) => p.login_url.includes('/login'))).toBe(
      true
    );
  });

  it('providers∥login coherency flood-5', async () => {
    const sessions = mockKv();
    const db = createOidcRaceDb({
      providers: [
        seedProvider(),
        seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 }),
      ],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[2].status).toBe(200);
    expect(results[1].status).toBe(302);
    expect(results[0].body.providers.map((p: { id: string }) => p.id).sort()).toEqual(
      [PROVIDER_B, PROVIDER_ID].sort()
    );
    expect(results[0].body.providers.every((p: { login_url: string }) => p.login_url.includes('/login'))).toBe(
      true
    );
  });

  it('providers∥login coherency flood-6', async () => {
    const sessions = mockKv();
    const db = createOidcRaceDb({
      providers: [
        seedProvider(),
        seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 }),
      ],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[2].status).toBe(200);
    expect(results[1].status).toBe(302);
    expect(results[0].body.providers.map((p: { id: string }) => p.id).sort()).toEqual(
      [PROVIDER_B, PROVIDER_ID].sort()
    );
    expect(results[0].body.providers.every((p: { login_url: string }) => p.login_url.includes('/login'))).toBe(
      true
    );
  });

  it('providers∥login coherency flood-7', async () => {
    const sessions = mockKv();
    const db = createOidcRaceDb({
      providers: [
        seedProvider(),
        seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 }),
      ],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[2].status).toBe(200);
    expect(results[1].status).toBe(302);
    expect(results[0].body.providers.map((p: { id: string }) => p.id).sort()).toEqual(
      [PROVIDER_B, PROVIDER_ID].sort()
    );
    expect(results[0].body.providers.every((p: { login_url: string }) => p.login_url.includes('/login'))).toBe(
      true
    );
  });

  it('providers list parallel soft flood empty', async () => {
    const env = envFor({ db: createOidcRaceDb({ providers: [] }) });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => request('/auth/oidc/providers', {}, env))
    );
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.providers).toEqual([]);
    }
  });

  it('providers omit secrets under parallel', async () => {
    const env = envFor({
      db: createOidcRaceDb({
        providers: [seedProvider({ client_secret_encrypted: 'secret-should-not-leak' })],
      }),
    });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    for (const r of results) {
      expect(JSON.stringify(r.body)).not.toContain('secret-should-not-leak');
      expect(JSON.stringify(r.body)).not.toContain('client_id');
    }
  });
});


// ---------------------------------------------------------------------------
// Existing-link UPDATE∥UPDATE / auto-create dual INSERT
// ---------------------------------------------------------------------------

describe('race oidc callback link update / auto-create after #221', () => {
  it('existing-link dual UPDATE last_login flood-0', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'lu0-a');
    const s2 = seedState(sessions, 'lu0-b');
    validateIDToken
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'a0@example.com',
        name: 'A0',
        preferred_username: 'alice',
      })
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'b0@example.com',
        name: 'B0',
        preferred_username: 'alice',
      });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 7,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE idp_user_links')).length).toBe(2);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('existing-link dual UPDATE last_login flood-1', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'lu1-a');
    const s2 = seedState(sessions, 'lu1-b');
    validateIDToken
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'a1@example.com',
        name: 'A1',
        preferred_username: 'alice',
      })
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'b1@example.com',
        name: 'B1',
        preferred_username: 'alice',
      });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 7,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE idp_user_links')).length).toBe(2);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('existing-link dual UPDATE last_login flood-2', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'lu2-a');
    const s2 = seedState(sessions, 'lu2-b');
    validateIDToken
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'a2@example.com',
        name: 'A2',
        preferred_username: 'alice',
      })
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'b2@example.com',
        name: 'B2',
        preferred_username: 'alice',
      });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 7,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE idp_user_links')).length).toBe(2);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('existing-link dual UPDATE last_login flood-3', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'lu3-a');
    const s2 = seedState(sessions, 'lu3-b');
    validateIDToken
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'a3@example.com',
        name: 'A3',
        preferred_username: 'alice',
      })
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'b3@example.com',
        name: 'B3',
        preferred_username: 'alice',
      });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 7,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE idp_user_links')).length).toBe(2);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('existing-link dual UPDATE last_login flood-4', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'lu4-a');
    const s2 = seedState(sessions, 'lu4-b');
    validateIDToken
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'a4@example.com',
        name: 'A4',
        preferred_username: 'alice',
      })
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'b4@example.com',
        name: 'B4',
        preferred_username: 'alice',
      });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 7,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE idp_user_links')).length).toBe(2);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('existing-link dual UPDATE last_login flood-5', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'lu5-a');
    const s2 = seedState(sessions, 'lu5-b');
    validateIDToken
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'a5@example.com',
        name: 'A5',
        preferred_username: 'alice',
      })
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'b5@example.com',
        name: 'B5',
        preferred_username: 'alice',
      });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 7,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE idp_user_links')).length).toBe(2);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('existing-link dual UPDATE last_login flood-6', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'lu6-a');
    const s2 = seedState(sessions, 'lu6-b');
    validateIDToken
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'a6@example.com',
        name: 'A6',
        preferred_username: 'alice',
      })
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'b6@example.com',
        name: 'B6',
        preferred_username: 'alice',
      });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 7,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE idp_user_links')).length).toBe(2);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('existing-link dual UPDATE last_login flood-7', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'lu7-a');
    const s2 = seedState(sessions, 'lu7-b');
    validateIDToken
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'a7@example.com',
        name: 'A7',
        preferred_username: 'alice',
      })
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'b7@example.com',
        name: 'B7',
        preferred_username: 'alice',
      });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 7,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE idp_user_links')).length).toBe(2);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('existing-link dual UPDATE last_login flood-8', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'lu8-a');
    const s2 = seedState(sessions, 'lu8-b');
    validateIDToken
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'a8@example.com',
        name: 'A8',
        preferred_username: 'alice',
      })
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'b8@example.com',
        name: 'B8',
        preferred_username: 'alice',
      });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 7,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE idp_user_links')).length).toBe(2);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('existing-link dual UPDATE last_login flood-9', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'lu9-a');
    const s2 = seedState(sessions, 'lu9-b');
    validateIDToken
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'a9@example.com',
        name: 'A9',
        preferred_username: 'alice',
      })
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'b9@example.com',
        name: 'B9',
        preferred_username: 'alice',
      });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 7,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE idp_user_links')).length).toBe(2);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('auto-create dual INSERT same sub race flood-0', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'ac0-a');
    const s2 = seedState(sessions, 'ac0-b');
    validateIDToken.mockResolvedValue({
      sub: 'new-sub-0',
      email: 'n0@example.com',
      name: 'New0',
      preferred_username: 'newuser0',
    });
    deriveUsername.mockReturnValue(`newuser0`);
    getUserById.mockResolvedValue(null);
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 1 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    // Race: both may createUser + insert links for same derived mxid
    expect(createUser.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO idp_user_links')).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('auto-create dual INSERT same sub race flood-1', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'ac1-a');
    const s2 = seedState(sessions, 'ac1-b');
    validateIDToken.mockResolvedValue({
      sub: 'new-sub-1',
      email: 'n1@example.com',
      name: 'New1',
      preferred_username: 'newuser1',
    });
    deriveUsername.mockReturnValue(`newuser1`);
    getUserById.mockResolvedValue(null);
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 1 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    // Race: both may createUser + insert links for same derived mxid
    expect(createUser.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO idp_user_links')).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('auto-create dual INSERT same sub race flood-2', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'ac2-a');
    const s2 = seedState(sessions, 'ac2-b');
    validateIDToken.mockResolvedValue({
      sub: 'new-sub-2',
      email: 'n2@example.com',
      name: 'New2',
      preferred_username: 'newuser2',
    });
    deriveUsername.mockReturnValue(`newuser2`);
    getUserById.mockResolvedValue(null);
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 1 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    // Race: both may createUser + insert links for same derived mxid
    expect(createUser.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO idp_user_links')).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('auto-create dual INSERT same sub race flood-3', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'ac3-a');
    const s2 = seedState(sessions, 'ac3-b');
    validateIDToken.mockResolvedValue({
      sub: 'new-sub-3',
      email: 'n3@example.com',
      name: 'New3',
      preferred_username: 'newuser3',
    });
    deriveUsername.mockReturnValue(`newuser3`);
    getUserById.mockResolvedValue(null);
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 1 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    // Race: both may createUser + insert links for same derived mxid
    expect(createUser.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO idp_user_links')).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('auto-create dual INSERT same sub race flood-4', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'ac4-a');
    const s2 = seedState(sessions, 'ac4-b');
    validateIDToken.mockResolvedValue({
      sub: 'new-sub-4',
      email: 'n4@example.com',
      name: 'New4',
      preferred_username: 'newuser4',
    });
    deriveUsername.mockReturnValue(`newuser4`);
    getUserById.mockResolvedValue(null);
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 1 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    // Race: both may createUser + insert links for same derived mxid
    expect(createUser.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO idp_user_links')).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('auto-create dual INSERT same sub race flood-5', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'ac5-a');
    const s2 = seedState(sessions, 'ac5-b');
    validateIDToken.mockResolvedValue({
      sub: 'new-sub-5',
      email: 'n5@example.com',
      name: 'New5',
      preferred_username: 'newuser5',
    });
    deriveUsername.mockReturnValue(`newuser5`);
    getUserById.mockResolvedValue(null);
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 1 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    // Race: both may createUser + insert links for same derived mxid
    expect(createUser.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO idp_user_links')).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('auto-create dual INSERT same sub race flood-6', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'ac6-a');
    const s2 = seedState(sessions, 'ac6-b');
    validateIDToken.mockResolvedValue({
      sub: 'new-sub-6',
      email: 'n6@example.com',
      name: 'New6',
      preferred_username: 'newuser6',
    });
    deriveUsername.mockReturnValue(`newuser6`);
    getUserById.mockResolvedValue(null);
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 1 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    // Race: both may createUser + insert links for same derived mxid
    expect(createUser.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO idp_user_links')).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('auto-create dual INSERT same sub race flood-7', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'ac7-a');
    const s2 = seedState(sessions, 'ac7-b');
    validateIDToken.mockResolvedValue({
      sub: 'new-sub-7',
      email: 'n7@example.com',
      name: 'New7',
      preferred_username: 'newuser7',
    });
    deriveUsername.mockReturnValue(`newuser7`);
    getUserById.mockResolvedValue(null);
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 1 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    // Race: both may createUser + insert links for same derived mxid
    expect(createUser.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO idp_user_links')).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('auto_create=0 parallel — both Account Not Found', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'nac-a');
    const s2 = seedState(sessions, 'nac-b');
    validateIDToken.mockResolvedValue({
      sub: 'orphan-sub',
      preferred_username: 'orphan',
    });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 0 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    for (const r of results) expect(r.text).toContain('Account Not Found');
    expect(createUser).not.toHaveBeenCalled();
  });

  it('auto-link existing Matrix user under parallel', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'al-a');
    const s2 = seedState(sessions, 'al-b');
    validateIDToken.mockResolvedValue({
      sub: 'link-sub',
      preferred_username: 'alice',
      name: 'Alice',
    });
    deriveUsername.mockReturnValue('alice');
    getUserById.mockResolvedValue({ user_id: USER });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createUser).not.toHaveBeenCalled();
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO idp_user_links')).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('token exchange throw parallel soft — Authentication Failed', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'ex-a');
    const s2 = seedState(sessions, 'ex-b');
    exchangeCodeForTokens.mockRejectedValue(new Error('exchange-fail'));
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    for (const r of results) expect(r.text).toContain('Authentication Failed');
  });

  it('id_token validate throw parallel soft', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'val-a');
    const s2 = seedState(sessions, 'val-b');
    validateIDToken.mockRejectedValue(new Error('bad-jwt'));
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    for (const r of results) expect(r.text).toContain('Authentication Failed');
  });
});


// ---------------------------------------------------------------------------
// MSC3861 identity reset∥reset concurrent
// ---------------------------------------------------------------------------

describe('race oidc MSC3861 identity reset concurrent after #221', () => {
  it('dual reset under DO fetch barrier — both 200, dual stream bumps', async () => {
    const userKeys = createUserKeysStub({ fetchBarrier: { count: 2 } });
    const crossSigning = mockKv({ [`user:${USER}`]: 'cached-keys' });
    const db = createOidcRaceDb({ streamPositions: { device_keys: 10 } });
    const env = envFor({ db, userKeys, crossSigning });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(userKeys.fetches.length).toBe(2);
    expect(db.streamPositions.device_keys).toBe(12);
    expect(db.inserts.filter((i) => i.sql.includes('device_key_changes')).length).toBe(2);
    expect(crossSigning.data[`user:${USER}`]).toBeUndefined();
  });

  it('identity reset parallel flood-0 coherent empty body', async () => {
    const userKeys = createUserKeysStub();
    const crossSigning = mockKv({ [`user:${USER}`]: 'k0' });
    const db = createOidcRaceDb({ streamPositions: { device_keys: 20 + 0 } });
    const env = envFor({ db, userKeys, crossSigning });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) expect(r.body).toEqual({});
    expect(db.streamPositions.device_keys).toBe(23 + 0);
  });

  it('identity reset parallel flood-1 coherent empty body', async () => {
    const userKeys = createUserKeysStub();
    const crossSigning = mockKv({ [`user:${USER}`]: 'k1' });
    const db = createOidcRaceDb({ streamPositions: { device_keys: 20 + 1 } });
    const env = envFor({ db, userKeys, crossSigning });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) expect(r.body).toEqual({});
    expect(db.streamPositions.device_keys).toBe(23 + 1);
  });

  it('identity reset parallel flood-2 coherent empty body', async () => {
    const userKeys = createUserKeysStub();
    const crossSigning = mockKv({ [`user:${USER}`]: 'k2' });
    const db = createOidcRaceDb({ streamPositions: { device_keys: 20 + 2 } });
    const env = envFor({ db, userKeys, crossSigning });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) expect(r.body).toEqual({});
    expect(db.streamPositions.device_keys).toBe(23 + 2);
  });

  it('identity reset parallel flood-3 coherent empty body', async () => {
    const userKeys = createUserKeysStub();
    const crossSigning = mockKv({ [`user:${USER}`]: 'k3' });
    const db = createOidcRaceDb({ streamPositions: { device_keys: 20 + 3 } });
    const env = envFor({ db, userKeys, crossSigning });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) expect(r.body).toEqual({});
    expect(db.streamPositions.device_keys).toBe(23 + 3);
  });

  it('identity reset parallel flood-4 coherent empty body', async () => {
    const userKeys = createUserKeysStub();
    const crossSigning = mockKv({ [`user:${USER}`]: 'k4' });
    const db = createOidcRaceDb({ streamPositions: { device_keys: 20 + 4 } });
    const env = envFor({ db, userKeys, crossSigning });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) expect(r.body).toEqual({});
    expect(db.streamPositions.device_keys).toBe(23 + 4);
  });

  it('identity reset parallel flood-5 coherent empty body', async () => {
    const userKeys = createUserKeysStub();
    const crossSigning = mockKv({ [`user:${USER}`]: 'k5' });
    const db = createOidcRaceDb({ streamPositions: { device_keys: 20 + 5 } });
    const env = envFor({ db, userKeys, crossSigning });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) expect(r.body).toEqual({});
    expect(db.streamPositions.device_keys).toBe(23 + 5);
  });

  it('identity reset parallel flood-6 coherent empty body', async () => {
    const userKeys = createUserKeysStub();
    const crossSigning = mockKv({ [`user:${USER}`]: 'k6' });
    const db = createOidcRaceDb({ streamPositions: { device_keys: 20 + 6 } });
    const env = envFor({ db, userKeys, crossSigning });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) expect(r.body).toEqual({});
    expect(db.streamPositions.device_keys).toBe(23 + 6);
  });

  it('identity reset parallel flood-7 coherent empty body', async () => {
    const userKeys = createUserKeysStub();
    const crossSigning = mockKv({ [`user:${USER}`]: 'k7' });
    const db = createOidcRaceDb({ streamPositions: { device_keys: 20 + 7 } });
    const env = envFor({ db, userKeys, crossSigning });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) expect(r.body).toEqual({});
    expect(db.streamPositions.device_keys).toBe(23 + 7);
  });

  it('identity reset parallel flood-8 coherent empty body', async () => {
    const userKeys = createUserKeysStub();
    const crossSigning = mockKv({ [`user:${USER}`]: 'k8' });
    const db = createOidcRaceDb({ streamPositions: { device_keys: 20 + 8 } });
    const env = envFor({ db, userKeys, crossSigning });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) expect(r.body).toEqual({});
    expect(db.streamPositions.device_keys).toBe(23 + 8);
  });

  it('identity reset parallel flood-9 coherent empty body', async () => {
    const userKeys = createUserKeysStub();
    const crossSigning = mockKv({ [`user:${USER}`]: 'k9' });
    const db = createOidcRaceDb({ streamPositions: { device_keys: 20 + 9 } });
    const env = envFor({ db, userKeys, crossSigning });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) expect(r.body).toEqual({});
    expect(db.streamPositions.device_keys).toBe(23 + 9);
  });

  it('reset∥reset KV delete idempotent under parallel', async () => {
    const crossSigning = mockKv({ [`user:${USER}`]: 'x' });
    const env = envFor({
      crossSigning,
      db: createOidcRaceDb({ streamPositions: { device_keys: 1 } }),
    });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(crossSigning.data[`user:${USER}`]).toBeUndefined();
    expect(crossSigning.deletes.filter((k) => k === `user:${USER}`).length).toBe(2);
  });

  it('DO throw under parallel — both 500 M_UNKNOWN', async () => {
    const userKeys = createUserKeysStub({ throwOnFetch: true });
    const env = envFor({
      userKeys,
      db: createOidcRaceDb({ streamPositions: { device_keys: 5 } }),
    });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
    for (const r of results) expect(r.body.errcode).toBe('M_UNKNOWN');
  });

  it('stream bump fail under parallel soft', async () => {
    const env = envFor({
      db: createOidcRaceDb({ streamPositions: { device_keys: 5 }, failStreamUpdate: true }),
    });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('GET method rejected under parallel soft', async () => {
    const env = envFor({ db: createOidcRaceDb() });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'GET' }, env),
      request(path, { method: 'GET' }, env),
    ]);
    for (const r of results) expect([404, 405]).toContain(r.status);
  });

  it('cross_signing_keys delete fail soft under parallel', async () => {
    const env = envFor({
      db: createOidcRaceDb({
        streamPositions: { device_keys: 5 },
        failCrossSigningDelete: true,
      }),
    });
    const path =
      '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });
});


// ---------------------------------------------------------------------------
// auth_metadata concurrent soft / method matrix
// ---------------------------------------------------------------------------

describe('race oidc auth_metadata concurrent after #221', () => {
  it('auth_metadata parallel flood-0 coherent issuer', async () => {
    const env = envFor();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request('/_matrix/client/v1/auth_metadata', {}, env))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.issuer).toBe(`https://${SERVER}`);
      expect(r.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(r.body.registration_endpoint).toContain('/oauth/register');
      expect(r.body.response_types_supported).toEqual(['code']);
    }
  });

  it('auth_metadata parallel flood-1 coherent issuer', async () => {
    const env = envFor();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request('/_matrix/client/v1/auth_metadata', {}, env))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.issuer).toBe(`https://${SERVER}`);
      expect(r.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(r.body.registration_endpoint).toContain('/oauth/register');
      expect(r.body.response_types_supported).toEqual(['code']);
    }
  });

  it('auth_metadata parallel flood-2 coherent issuer', async () => {
    const env = envFor();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request('/_matrix/client/v1/auth_metadata', {}, env))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.issuer).toBe(`https://${SERVER}`);
      expect(r.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(r.body.registration_endpoint).toContain('/oauth/register');
      expect(r.body.response_types_supported).toEqual(['code']);
    }
  });

  it('auth_metadata parallel flood-3 coherent issuer', async () => {
    const env = envFor();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request('/_matrix/client/v1/auth_metadata', {}, env))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.issuer).toBe(`https://${SERVER}`);
      expect(r.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(r.body.registration_endpoint).toContain('/oauth/register');
      expect(r.body.response_types_supported).toEqual(['code']);
    }
  });

  it('auth_metadata parallel flood-4 coherent issuer', async () => {
    const env = envFor();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request('/_matrix/client/v1/auth_metadata', {}, env))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.issuer).toBe(`https://${SERVER}`);
      expect(r.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(r.body.registration_endpoint).toContain('/oauth/register');
      expect(r.body.response_types_supported).toEqual(['code']);
    }
  });

  it('auth_metadata parallel flood-5 coherent issuer', async () => {
    const env = envFor();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request('/_matrix/client/v1/auth_metadata', {}, env))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.issuer).toBe(`https://${SERVER}`);
      expect(r.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(r.body.registration_endpoint).toContain('/oauth/register');
      expect(r.body.response_types_supported).toEqual(['code']);
    }
  });

  it('auth_metadata parallel flood-6 coherent issuer', async () => {
    const env = envFor();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request('/_matrix/client/v1/auth_metadata', {}, env))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.issuer).toBe(`https://${SERVER}`);
      expect(r.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(r.body.registration_endpoint).toContain('/oauth/register');
      expect(r.body.response_types_supported).toEqual(['code']);
    }
  });

  it('auth_metadata parallel flood-7 coherent issuer', async () => {
    const env = envFor();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request('/_matrix/client/v1/auth_metadata', {}, env))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.issuer).toBe(`https://${SERVER}`);
      expect(r.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(r.body.registration_endpoint).toContain('/oauth/register');
      expect(r.body.response_types_supported).toEqual(['code']);
    }
  });

  it('auth_metadata parallel flood-8 coherent issuer', async () => {
    const env = envFor();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request('/_matrix/client/v1/auth_metadata', {}, env))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.issuer).toBe(`https://${SERVER}`);
      expect(r.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(r.body.registration_endpoint).toContain('/oauth/register');
      expect(r.body.response_types_supported).toEqual(['code']);
    }
  });

  it('auth_metadata parallel flood-9 coherent issuer', async () => {
    const env = envFor();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request('/_matrix/client/v1/auth_metadata', {}, env))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.issuer).toBe(`https://${SERVER}`);
      expect(r.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(r.body.registration_endpoint).toContain('/oauth/register');
      expect(r.body.response_types_supported).toEqual(['code']);
    }
  });

  it('auth_metadata parallel flood-10 coherent issuer', async () => {
    const env = envFor();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request('/_matrix/client/v1/auth_metadata', {}, env))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.issuer).toBe(`https://${SERVER}`);
      expect(r.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(r.body.registration_endpoint).toContain('/oauth/register');
      expect(r.body.response_types_supported).toEqual(['code']);
    }
  });

  it('auth_metadata parallel flood-11 coherent issuer', async () => {
    const env = envFor();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request('/_matrix/client/v1/auth_metadata', {}, env))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.issuer).toBe(`https://${SERVER}`);
      expect(r.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(r.body.registration_endpoint).toContain('/oauth/register');
      expect(r.body.response_types_supported).toEqual(['code']);
    }
  });

  it('auth_metadata reflects SERVER_NAME under parallel', async () => {
    const env = envFor({ serverName: 'matrix.example.com' });
    const results = await Promise.all([
      request('/_matrix/client/v1/auth_metadata', {}, env),
      request('/_matrix/client/v1/auth_metadata', {}, env),
    ]);
    for (const r of results) {
      expect(r.body.issuer).toBe('https://matrix.example.com');
      expect(r.body.token_endpoint).toBe('https://matrix.example.com/oauth/token');
    }
  });

  it('auth_metadata scopes include openid under parallel', async () => {
    const env = envFor();
    const results = await Promise.all([
      request('/_matrix/client/v1/auth_metadata', {}, env),
      request('/_matrix/client/v1/auth_metadata', {}, env),
    ]);
    for (const r of results) {
      expect(r.body.scopes_supported[0]).toBe('openid');
      expect(r.body.account_management_actions_supported).toContain('org.matrix.profile');
    }
  });

  it('POST auth_metadata method soft under parallel', async () => {
    const env = envFor();
    const results = await Promise.all([
      request('/_matrix/client/v1/auth_metadata', { method: 'POST' }, env),
      request('/_matrix/client/v1/auth_metadata', { method: 'PUT' }, env),
    ]);
    for (const r of results) expect([404, 405]).toContain(r.status);
  });
});


// ---------------------------------------------------------------------------
// Lifecycle login→callback / encrypt helpers / method soft
// ---------------------------------------------------------------------------

describe('race oidc lifecycle + soft contracts after #221', () => {
  it('login→callback e2e under parallel distinct flows', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
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
    const logins = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/login?return_to=/one`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login?return_to=/two`, {}, env),
    ]);
    expect(statusesOf(logins)).toEqual([302, 302]);
    const states = Object.keys(sessions.data)
      .filter((k) => k.startsWith('oidc_state:'))
      .map((k) => k.slice('oidc_state:'.length));
    expect(states).toHaveLength(2);
    const callbacks = await Promise.all(
      states.map((st, i) =>
        request(`/auth/oidc/${PROVIDER_ID}/callback?code=lc${i}&state=${st}`, {}, env)
      )
    );
    expect(callbacks.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('oidc_state:'))).toHaveLength(0);
  });

  it('encryptSecret parallel distinct IV flood-0', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    const results = await Promise.all([
      encryptSecret('secret-0-a', env),
      encryptSecret('secret-0-a', env),
      encryptSecret('secret-0-b', env),
    ]);
    expect(new Set(results).size).toBe(3);
    for (const c of results) {
      const plain = await decryptSecret(c, env);
      expect(['secret-0-a', 'secret-0-b']).toContain(plain);
    }
  });

  it('encryptSecret parallel distinct IV flood-1', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    const results = await Promise.all([
      encryptSecret('secret-1-a', env),
      encryptSecret('secret-1-a', env),
      encryptSecret('secret-1-b', env),
    ]);
    expect(new Set(results).size).toBe(3);
    for (const c of results) {
      const plain = await decryptSecret(c, env);
      expect(['secret-1-a', 'secret-1-b']).toContain(plain);
    }
  });

  it('encryptSecret parallel distinct IV flood-2', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    const results = await Promise.all([
      encryptSecret('secret-2-a', env),
      encryptSecret('secret-2-a', env),
      encryptSecret('secret-2-b', env),
    ]);
    expect(new Set(results).size).toBe(3);
    for (const c of results) {
      const plain = await decryptSecret(c, env);
      expect(['secret-2-a', 'secret-2-b']).toContain(plain);
    }
  });

  it('encryptSecret parallel distinct IV flood-3', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    const results = await Promise.all([
      encryptSecret('secret-3-a', env),
      encryptSecret('secret-3-a', env),
      encryptSecret('secret-3-b', env),
    ]);
    expect(new Set(results).size).toBe(3);
    for (const c of results) {
      const plain = await decryptSecret(c, env);
      expect(['secret-3-a', 'secret-3-b']).toContain(plain);
    }
  });

  it('encryptSecret parallel distinct IV flood-4', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    const results = await Promise.all([
      encryptSecret('secret-4-a', env),
      encryptSecret('secret-4-a', env),
      encryptSecret('secret-4-b', env),
    ]);
    expect(new Set(results).size).toBe(3);
    for (const c of results) {
      const plain = await decryptSecret(c, env);
      expect(['secret-4-a', 'secret-4-b']).toContain(plain);
    }
  });

  it('encryptSecret parallel distinct IV flood-5', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    const results = await Promise.all([
      encryptSecret('secret-5-a', env),
      encryptSecret('secret-5-a', env),
      encryptSecret('secret-5-b', env),
    ]);
    expect(new Set(results).size).toBe(3);
    for (const c of results) {
      const plain = await decryptSecret(c, env);
      expect(['secret-5-a', 'secret-5-b']).toContain(plain);
    }
  });

  it('encrypt refuses without OIDC_ENCRYPTION_KEY under parallel soft', async () => {
    const env = { SERVER_NAME: SERVER };
    const results = await Promise.allSettled([
      encryptSecret('x', env),
      encryptSecret('y', env),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('login POST method soft under parallel', async () => {
    const env = envFor({ db: createOidcRaceDb({ providers: [seedProvider()] }) });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/login`, { method: 'POST' }, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, { method: 'DELETE' }, env),
    ]);
    for (const r of results) expect([404, 405]).toContain(r.status);
  });

  it('providers POST method soft under parallel', async () => {
    const env = envFor({ db: createOidcRaceDb({ providers: [seedProvider()] }) });
    const results = await Promise.all([
      request('/auth/oidc/providers', { method: 'POST' }, env),
      request('/auth/oidc/providers', { method: 'PUT' }, env),
    ]);
    for (const r of results) expect([404, 405]).toContain(r.status);
  });

  it('callback DELETE method soft under parallel', async () => {
    const env = envFor({ db: createOidcRaceDb({ providers: [seedProvider()] }) });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback`, { method: 'DELETE' }, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback`, { method: 'POST' }, env),
    ]);
    for (const r of results) expect([404, 405]).toContain(r.status);
  });

  it('login default return_to / under parallel', async () => {
    const sessions = mockKv();
    const env = envFor({
      sessions,
      db: createOidcRaceDb({ providers: [seedProvider()] }),
    });
    await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
    ]);
    for (const v of Object.values(sessions.data)) {
      expect(JSON.parse(v).returnTo).toBe('/');
    }
  });

  it('Host header shapes redirect_uri under parallel login', async () => {
    const sessions = mockKv();
    const env = envFor({
      sessions,
      db: createOidcRaceDb({ providers: [seedProvider()] }),
    });
    await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/login`, { headers: { Host: 'hs.example.com' } }, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, { headers: { Host: 'hs.example.com' } }, env),
    ]);
    for (const v of Object.values(sessions.data)) {
      expect(JSON.parse(v).redirectUri).toContain('hs.example.com');
    }
  });

  it('SQL select fail on providers under parallel soft', async () => {
    const db = createOidcRaceDb({
      providers: [seedProvider()],
      failSelectAfter: 0,
    });
    const env = envFor({ db });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });
});

// ---------------------------------------------------------------------------
// After #232: leftover callback binds / decrypt / JWKS / providers /
// auth_metadata fields / identity-reset fail isolation
// ---------------------------------------------------------------------------

describe('race leftover oidc callback nonce/code binds + decrypt after #232', () => {
  it('validateIDToken receives stored nonce; exchange receives callback code', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'bind-a', { nonce: 'nonce-a' });
    const s2 = seedState(sessions, 'bind-b', { nonce: 'nonce-b' });
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=code-a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=code-b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    const codes = exchangeCodeForTokens.mock.calls.map((c) => c[3] as string).sort();
    expect(codes).toEqual(['code-a', 'code-b'].sort());
    const nonces = validateIDToken.mock.calls.map((c) => c[3] as string).sort();
    expect(nonces).toEqual(['nonce-a', 'nonce-b'].sort());
  });

  it('claims without name skip display_name UPDATE under parallel auto-create', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'nn-a');
    const s2 = seedState(sessions, 'nn-b');
    validateIDToken.mockResolvedValue({
      sub: 'nameless-sub',
      preferred_username: 'nameless',
    });
    deriveUsername.mockReturnValue('nameless');
    getUserById.mockResolvedValue(null);
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 1 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE users SET display_name')).length).toBe(0);
    expect(createUser).toHaveBeenCalled();
  });

  it('success page embeds returnTo under parallel distinct states', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'rt-a', { returnTo: '/room/a' });
    const s2 = seedState(sessions, 'rt-b', { returnTo: '/room/b' });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 2,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.some((r) => r.text.includes('/room/a'))).toBe(true);
    expect(results.some((r) => r.text.includes('/room/b'))).toBe(true);
  });

  it('garbage client_secret_encrypted decrypt fail → Authentication Failed', async () => {
    const sessions = mockKv();
    const s1 = seedState(sessions, 'dec-a');
    const s2 = seedState(sessions, 'dec-b');
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: btoa('not-real-ciphertext') })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    for (const r of results) expect(r.text).toContain('Authentication Failed');
  });

  it('fetchJWKS throw parallel soft', async () => {
    const secret = await encryptClientSecret();
    fetchJWKS.mockRejectedValue(new Error('jwks-down'));
    const sessions = mockKv();
    const s1 = seedState(sessions, 'jw-a');
    const s2 = seedState(sessions, 'jw-b');
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    for (const r of results) expect(r.text).toContain('Authentication Failed');
  });

  it('corrupt oidc_state JSON surfaces error HTML under parallel', async () => {
    const sessions = mockKv();
    sessions.data['oidc_state:bad-json'] = '{not-json';
    const env = envFor({
      sessions,
      db: createOidcRaceDb({ providers: [seedProvider()] }),
    });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=bad-json`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=bad-json`, {}, env),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
    expect(
      results.some(
        (r) =>
          r.text.includes('Authentication Failed') ||
          r.text.includes('Invalid State') ||
          r.status === 500
      )
    ).toBe(true);
  });

  it('IdP error_description HTML echoed; state not consumed', async () => {
    const sessions = mockKv();
    seedState(sessions, 'keep-err');
    const env = envFor({ sessions, db: createOidcRaceDb({ providers: [seedProvider()] }) });
    const results = await Promise.all(
      ['access_denied', 'temporarily_unavailable', 'invalid_scope'].map((err) =>
        request(
          `/auth/oidc/${PROVIDER_ID}/callback?error=${err}&error_description=denied-${err}`,
          {},
          env
        )
      )
    );
    for (const r of results) {
      expect(r.text).toContain('Authentication Failed');
      expect(r.text).toContain('denied-');
    }
    expect(sessions.data['oidc_state:keep-err']).toBeTruthy();
  });

  it('login∥callback isolation: login mint does not consume callback state', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const existing = seedState(sessions, 'keep-login');
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 3,
          provider_id: PROVIDER_ID,
          external_id: 'ext-sub-1',
          user_id: USER,
          external_email: null,
          external_name: null,
        },
      ],
    });
    const env = envFor({ sessions, db });
    const [login, callback] = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/login?return_to=/iso`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=z&state=${existing}`, {}, env),
    ]);
    expect(login.status).toBe(302);
    expect(callback.text).toContain('Login Successful');
    expect(sessions.data[`oidc_state:${existing}`]).toBeUndefined();
    expect(
      Object.keys(sessions.data).filter((k) => k.startsWith('oidc_state:')).length
    ).toBeGreaterThanOrEqual(1);
  });

  it('buildAuthorizationUrl receives provider scopes under parallel login', async () => {
    const sessions = mockKv();
    const db = createOidcRaceDb({
      providers: [
        seedProvider({ scopes: 'openid email' }),
        seedProvider({
          id: PROVIDER_B,
          name: 'GitHub',
          scopes: 'openid read:user',
          display_order: 2,
        }),
      ],
    });
    const env = envFor({ sessions, db });
    await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request(`/auth/oidc/${PROVIDER_B}/login`, {}, env),
    ]);
    const scopeArgs = buildAuthorizationUrl.mock.calls.map((c) => c[3] as string).sort();
    expect(scopeArgs).toEqual(['openid email', 'openid read:user'].sort());
  });

  for (let i = 0; i < 8; i++) {
    it(`callback IdP error leftover flood-${i}`, async () => {
      const env = envFor({ db: createOidcRaceDb({ providers: [seedProvider()] }) });
      const results = await Promise.all([
        request(
          `/auth/oidc/${PROVIDER_ID}/callback?error=access_denied&error_description=e${i}a`,
          {},
          env
        ),
        request(
          `/auth/oidc/${PROVIDER_ID}/callback?error=server_error&error_description=e${i}b`,
          {},
          env
        ),
      ]);
      expect(results.every((r) => r.text.includes('Authentication Failed'))).toBe(true);
      expect(results[0].text).toContain(`e${i}a`);
      expect(results[1].text).toContain(`e${i}b`);
    });
  }
});

describe('race leftover oidc providers list + auth_metadata fields after #232', () => {
  it('providers list sorts by display_order then name under parallel', async () => {
    const db = createOidcRaceDb({
      providers: [
        seedProvider({ id: 'zeta', name: 'Zeta', display_order: 2, enabled: 1 }),
        seedProvider({ id: 'alpha', name: 'Alpha', display_order: 2, enabled: 1 }),
        seedProvider({ id: 'first', name: 'First', display_order: 1, enabled: 1 }),
        seedProvider({ id: 'off', name: 'Off', display_order: 0, enabled: 0 }),
      ],
    });
    const env = envFor({ db });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.providers.map((p: { id: string }) => p.id)).toEqual(['first', 'alpha', 'zeta']);
      expect(
        r.body.providers.every(
          (p: { login_url: string; id: string }) => p.login_url === `/auth/oidc/${p.id}/login`
        )
      ).toBe(true);
    }
  });

  it('empty enabled set returns empty providers array under parallel', async () => {
    const env = envFor({
      db: createOidcRaceDb({ providers: [seedProvider({ enabled: 0 })] }),
    });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(
      results.every(
        (r) => r.status === 200 && Array.isArray(r.body.providers) && r.body.providers.length === 0
      )
    ).toBe(true);
  });

  it('providers list mid-flight disable via mutate after first ALL', async () => {
    const db = createOidcRaceDb({
      providers: [
        seedProvider(),
        seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 }),
      ],
      mutateProvidersAfterSelects: {
        after: 1,
        next: [
          seedProvider({ enabled: 0 }),
          seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 }),
        ],
      },
    });
    const env = envFor({ db });
    const first = await request('/auth/oidc/providers', {}, env);
    const second = await request('/auth/oidc/providers', {}, env);
    expect(first.status).toBe(200);
    expect(first.body.providers.map((p: { id: string }) => p.id).sort()).toEqual(
      [PROVIDER_B, PROVIDER_ID].sort()
    );
    expect(second.body.providers.map((p: { id: string }) => p.id)).toEqual([PROVIDER_B]);
  });

  it('auth_metadata field bind matrix under parallel', async () => {
    const env = envFor();
    const results = await Promise.all(
      Array.from({ length: 3 }, () => request('/_matrix/client/v1/auth_metadata', {}, env))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.revocation_endpoint).toBe(`https://${SERVER}/oauth/revoke`);
      expect(r.body.code_challenge_methods_supported).toEqual(['S256', 'plain']);
      expect(r.body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(r.body.token_endpoint_auth_methods_supported).toContain('none');
      expect(r.body.device_authorization_endpoint).toBe(`https://${SERVER}/oauth/device`);
      expect(r.body.prompt_values_supported).toEqual(['create']);
      expect(r.body.account_management_uri).toBe(`https://${SERVER}/admin`);
      expect(r.body.account_management_actions_supported).toContain(
        'org.matrix.cross_signing_reset'
      );
    }
  });

  for (let i = 0; i < 8; i++) {
    it(`auth_metadata leftover field flood-${i}`, async () => {
      const env = envFor({ serverName: i % 2 === 0 ? SERVER : 'matrix.example.com' });
      const host = i % 2 === 0 ? SERVER : 'matrix.example.com';
      const results = await Promise.all([
        request('/_matrix/client/v1/auth_metadata', {}, env),
        request('/_matrix/client/v1/auth_metadata', {}, env),
      ]);
      for (const r of results) {
        expect(r.body.issuer).toBe(`https://${host}`);
        expect(r.body.authorization_endpoint).toBe(`https://${host}/oauth/authorize`);
        expect(r.body.response_types_supported).toEqual(['code']);
      }
    });
  }
});

describe('race leftover MSC3861 identity reset fail isolation after #232', () => {
  it('DO fetch throw and KV delete throw both 500 under isolation', async () => {
    const throwing = createUserKeysStub({ throwOnFetch: true });
    const kvFail = mockKv({ [`user:${USER}`]: 'cached' }, { failDeleteAfter: 0 });
    const okKeys = createUserKeysStub();
    const path = '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const envThrow = envFor({
      db: createOidcRaceDb({ streamPositions: { device_keys: 1 } }),
      userKeys: throwing,
    });
    const envKv = envFor({
      db: createOidcRaceDb({ streamPositions: { device_keys: 5 } }),
      userKeys: okKeys,
      crossSigning: kvFail,
    });
    const [threw, kv] = await Promise.all([
      request(path, { method: 'POST' }, envThrow),
      request(path, { method: 'POST' }, envKv),
    ]);
    expect(threw.status).toBe(500);
    expect(threw.body.errcode).toBe('M_UNKNOWN');
    expect(kv.status).toBe(500);
  });

  it('stream bump fail surfaces 500 under parallel', async () => {
    const env = envFor({
      db: createOidcRaceDb({ streamPositions: { device_keys: 3 }, failStreamUpdate: true }),
      userKeys: createUserKeysStub(),
    });
    const path = '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
    expect(results.every((r) => r.body.errcode === 'M_UNKNOWN')).toBe(true);
  });

  it('device_key_changes INSERT binds user_id + stream position under dual reset', async () => {
    const db = createOidcRaceDb({ streamPositions: { device_keys: 40 } });
    const env = envFor({ db, userKeys: createUserKeysStub() });
    const path = '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const changes = db.inserts.filter((i) => i.sql.includes('device_key_changes'));
    expect(changes).toHaveLength(2);
    for (const ins of changes) {
      expect(ins.args[0]).toBe(USER);
      expect(typeof ins.args[1]).toBe('number');
    }
    expect(db.deletes.some((d) => d.sql.includes('cross_signing_keys'))).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('cross_signing_signatures'))).toBe(true);
  });

  it('login discovery fail does not mint oidc_state', async () => {
    fetchOIDCDiscovery.mockRejectedValue(new Error('disco'));
    const sessions = mockKv();
    const env = envFor({
      sessions,
      db: createOidcRaceDb({ providers: [seedProvider()] }),
    });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/login`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('oidc_state:'))).toHaveLength(0);
    expect(sessions.puts).toHaveLength(0);
  });

  it('encryptSecret∥decryptSecret roundtrip flood leftover', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    const plains = ['alpha', 'beta', 'gamma', 'delta'];
    const ciphertexts = await Promise.all(plains.map((p) => encryptSecret(p, env)));
    expect(new Set(ciphertexts).size).toBe(4);
    const round = await Promise.all(ciphertexts.map((c) => decryptSecret(c, env)));
    expect(round.sort()).toEqual([...plains].sort());
  });

  for (let i = 0; i < 8; i++) {
    it(`identity reset leftover flood-${i} empty JSON`, async () => {
      const db = createOidcRaceDb({ streamPositions: { device_keys: 100 + i } });
      const env = envFor({ db, userKeys: createUserKeysStub() });
      const path = '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
      const results = await Promise.all([
        request(path, { method: 'POST' }, env),
        request(path, { method: 'POST' }, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results.every((r) => JSON.stringify(r.body) === '{}')).toBe(true);
      expect(db.streamPositions.device_keys).toBe(102 + i);
    });
  }
});

// ---------------------------------------------------------------------------
// After #238 / tip after #241: residual callback binds / providers icon /
// identity-reset KV+signatures / dual-provider state niches unsaturated by
// the #232 deepen.
// ---------------------------------------------------------------------------

describe('race residual oidc claims.name + redirectUri + link UPDATE after #238', () => {
  it('claims.name triggers display_name UPDATE under parallel auto-create', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'named-a');
    const s2 = seedState(sessions, 'named-b');
    validateIDToken
      .mockResolvedValueOnce({
        sub: 'named-sub-a',
        preferred_username: 'nameda',
        name: 'Named Alice',
      })
      .mockResolvedValueOnce({
        sub: 'named-sub-b',
        preferred_username: 'namedb',
        name: 'Named Bob',
      });
    deriveUsername.mockImplementation((claims: { preferred_username?: string }) =>
      claims.preferred_username || 'fallback'
    );
    getUserById.mockResolvedValue(null);
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 1 })],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    const nameUpdates = db.updates.filter((u) => u.sql.includes('UPDATE users SET display_name'));
    expect(nameUpdates.length).toBeGreaterThanOrEqual(2);
    const names = nameUpdates.map((u) => u.args[0] as string).sort();
    expect(names).toEqual(['Named Alice', 'Named Bob'].sort());
  });

  it('exchangeCodeForTokens receives redirectUri from state under parallel', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'ru-a', {
      redirectUri: `https://hs-a.example.com/auth/oidc/${PROVIDER_ID}/callback`,
    });
    const s2 = seedState(sessions, 'ru-b', {
      redirectUri: `https://hs-b.example.com/auth/oidc/${PROVIDER_ID}/callback`,
    });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 10,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=code-ru-a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=code-ru-b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    const redirectArgs = exchangeCodeForTokens.mock.calls.map((c) => c[4] as string).sort();
    expect(redirectArgs).toEqual(
      [
        `https://hs-a.example.com/auth/oidc/${PROVIDER_ID}/callback`,
        `https://hs-b.example.com/auth/oidc/${PROVIDER_ID}/callback`,
      ].sort()
    );
    const codes = exchangeCodeForTokens.mock.calls.map((c) => c[3] as string).sort();
    expect(codes).toEqual(['code-ru-a', 'code-ru-b'].sort());
  });

  it('existing-link UPDATE binds email/name from claims under parallel', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'em-a');
    const s2 = seedState(sessions, 'em-b');
    validateIDToken
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'a@example.com',
        name: 'Alice A',
        preferred_username: 'alice',
      })
      .mockResolvedValueOnce({
        sub: 'ext-sub-1',
        email: 'b@example.com',
        name: 'Alice B',
        preferred_username: 'alice',
      });
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 20,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    const linkUpdates = db.updates.filter((u) => u.sql.includes('UPDATE idp_user_links SET last_login_at'));
    expect(linkUpdates.length).toBeGreaterThanOrEqual(2);
    const emails = linkUpdates.map((u) => u.args[1] as string).sort();
    const names = linkUpdates.map((u) => u.args[2] as string).sort();
    expect(emails).toEqual(['a@example.com', 'b@example.com'].sort());
    expect(names).toEqual(['Alice A', 'Alice B'].sort());
  });

  it('deriveUsername receives provider username_claim under parallel', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'uc-a');
    const s2 = seedState(sessions, 'uc-b');
    validateIDToken
      .mockResolvedValueOnce({
        sub: 'uc-sub-a',
        preferred_username: 'pref-a',
        email: 'a@example.com',
      })
      .mockResolvedValueOnce({
        sub: 'uc-sub-b',
        preferred_username: 'pref-b',
        email: 'b@example.com',
      });
    deriveUsername.mockImplementation(
      (_claims: unknown, claim: string) => `derived-${claim}`
    );
    getUserById.mockResolvedValue(null);
    const db = createOidcRaceDb({
      providers: [
        seedProvider({
          client_secret_encrypted: secret,
          auto_create_users: 1,
          username_claim: 'preferred_username',
        }),
      ],
    });
    // Second callback uses a distinct provider id path but same seeded provider —
    // both hit the same provider.username_claim.
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(deriveUsername.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(deriveUsername.mock.calls.every((c) => c[1] === 'preferred_username')).toBe(true);
  });

  it('createDevice display_name embeds SSO Login (provider.name) under parallel', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'dev-a');
    const s2 = seedState(sessions, 'dev-b');
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret, name: 'Google Workspace' })],
      links: [
        {
          id: 30,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    expect(createDevice.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      createDevice.mock.calls.every((c) => c[3] === 'SSO Login (Google Workspace)')
    ).toBe(true);
  });

  it('success page embeds userId + distinct deviceId under parallel', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'sp-a');
    const s2 = seedState(sessions, 'sp-b');
    const db = createOidcRaceDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 40,
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
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`, {}, env),
      request(`/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`, {}, env),
    ]);
    expect(results.every((r) => r.text.includes(USER))).toBe(true);
    expect(results.every((r) => r.text.includes('Login Successful'))).toBe(true);
    const devices = results.map((r) => {
      const m = r.text.match(/Device ID<\/label>\s*<div class="value">([^<]+)/);
      return m?.[1];
    });
    expect(devices[0]).toBeTruthy();
    expect(devices[1]).toBeTruthy();
    expect(devices[0]).not.toBe(devices[1]);
  });
});

describe('race residual oidc providers icon + dual-provider state + reset KV after #238', () => {
  it('providers list surfaces icon_url under parallel', async () => {
    const db = createOidcRaceDb({
      providers: [
        seedProvider({ icon_url: 'https://cdn.example.com/google.svg' }),
        seedProvider({
          id: PROVIDER_B,
          name: 'GitHub',
          display_order: 2,
          icon_url: 'https://cdn.example.com/github.svg',
        }),
      ],
    });
    const env = envFor({ db });
    const results = await Promise.all([
      request('/auth/oidc/providers', {}, env),
      request('/auth/oidc/providers', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const byId = Object.fromEntries(
        r.body.providers.map((p: { id: string; icon_url: string }) => [p.id, p.icon_url])
      );
      expect(byId[PROVIDER_ID]).toBe('https://cdn.example.com/google.svg');
      expect(byId[PROVIDER_B]).toBe('https://cdn.example.com/github.svg');
    }
  });

  it('dual-provider login isolates providerId in oidc_state under parallel', async () => {
    const sessions = mockKv();
    const db = createOidcRaceDb({
      providers: [
        seedProvider(),
        seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 }),
      ],
    });
    const env = envFor({ sessions, db });
    const results = await Promise.all([
      request(`/auth/oidc/${PROVIDER_ID}/login?return_to=/g`, {}, env),
      request(`/auth/oidc/${PROVIDER_B}/login?return_to=/gh`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const stored = Object.values(sessions.data).map((v) => JSON.parse(v));
    const byReturn = Object.fromEntries(stored.map((s) => [s.returnTo, s.providerId]));
    expect(byReturn['/g']).toBe(PROVIDER_ID);
    expect(byReturn['/gh']).toBe(PROVIDER_B);
  });

  it('provider disable between sequential callbacks — second Provider Not Found', async () => {
    const secret = await encryptClientSecret();
    const sessions = mockKv();
    const s1 = seedState(sessions, 'dis-a');
    const s2 = seedState(sessions, 'dis-b');
    const provider = seedProvider({ client_secret_encrypted: secret });
    const db = createOidcRaceDb({
      providers: [provider],
      links: [
        {
          id: 50,
          provider_id: PROVIDER_ID,
          external_id: 'ext-sub-1',
          user_id: USER,
          external_email: null,
          external_name: null,
        },
      ],
    });
    const env = envFor({ sessions, db });
    const first = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=a&state=${s1}`,
      {},
      env
    );
    provider.enabled = 0;
    const second = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=b&state=${s2}`,
      {},
      env
    );
    expect(first.text).toContain('Login Successful');
    expect(second.text).toContain('Provider Not Found');
  });

  it('identity reset deletes CROSS_SIGNING_KEYS user: key under dual reset', async () => {
    const crossSigning = mockKv({ [`user:${USER}`]: 'cached-keys', [`user:@bob:${SERVER}`]: 'other' });
    const db = createOidcRaceDb({ streamPositions: { device_keys: 7 } });
    const env = envFor({ db, userKeys: createUserKeysStub(), crossSigning });
    const path = '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(crossSigning.data[`user:${USER}`]).toBeUndefined();
    expect(crossSigning.data[`user:@bob:${SERVER}`]).toBe('other');
    expect(crossSigning.deletes.filter((k) => k === `user:${USER}`).length).toBeGreaterThanOrEqual(2);
  });

  it('cross_signing_signatures DELETE binds user_id twice under dual reset', async () => {
    const db = createOidcRaceDb({ streamPositions: { device_keys: 11 } });
    const env = envFor({ db, userKeys: createUserKeysStub() });
    const path = '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
    const results = await Promise.all([
      request(path, { method: 'POST' }, env),
      request(path, { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const sigDeletes = db.deletes.filter((d) => d.sql.includes('cross_signing_signatures'));
    expect(sigDeletes).toHaveLength(2);
    for (const d of sigDeletes) {
      expect(d.args[0]).toBe(USER);
      expect(d.args[1]).toBe(USER);
    }
  });

  for (let i = 0; i < 6; i++) {
    it(`dual-provider state residual flood-${i}`, async () => {
      const sessions = mockKv();
      const db = createOidcRaceDb({
        providers: [
          seedProvider(),
          seedProvider({ id: PROVIDER_B, name: 'GitHub', display_order: 2 }),
        ],
      });
      const env = envFor({ sessions, db });
      const results = await Promise.all([
        request(`/auth/oidc/${PROVIDER_ID}/login?return_to=/f${i}a`, {}, env),
        request(`/auth/oidc/${PROVIDER_B}/login?return_to=/f${i}b`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([302, 302]);
      const stored = Object.values(sessions.data).map((v) => JSON.parse(v));
      expect(stored.map((s) => s.providerId).sort()).toEqual([PROVIDER_B, PROVIDER_ID].sort());
      expect(stored.every((s) => typeof s.nonce === 'string' && s.nonce.length > 0)).toBe(true);
    });
  }
});
