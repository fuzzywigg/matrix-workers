/**
 * TOKENMAXX HEAVY leftovers after #147 — oidc token issuance + auth/login reliability.
 * Orthogonal to oidc-auth-api-route-leftovers (#147): focuses on createDevice/createAccessToken
 * failure paths, providers list, buildAuthorizationUrl arg contracts, and auth-middleware edges.
 * Tests-only — no product inventing.
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

/** Fixed 32-byte key → base64 (OIDC_ENCRYPTION_KEY contract). */
const OIDC_KEY_BYTES = new Uint8Array(32).map((_, i) => (i * 7 + 13) & 0xff);
const OIDC_ENCRYPTION_KEY = btoa(String.fromCharCode(...OIDC_KEY_BYTES));

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  const kv = {
    data,
    puts,
    deletes,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      deletes.push(key);
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
    deletes: string[];
  };
}

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

function createOidcDb(opts: {
  providers?: IdPProvider[];
  links?: IdPUserLink[];
  streamPositions?: Record<string, number>;
  failCrossSigningDelete?: boolean;
  failStreamUpdate?: boolean;
} = {}) {
  const providers = opts.providers ? [...opts.providers] : [];
  const links = opts.links ? [...opts.links] : [];
  const streamPositions = { ...(opts.streamPositions ?? { device_keys: 10 }) };
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  let nextLinkId = links.reduce((m, l) => Math.max(m, l.id), 0) + 1;

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
  sessions?: ReturnType<typeof mockKv>;
  crossSigning?: ReturnType<typeof mockKv>;
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

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

beforeEach(() => {
  deviceSeq = 0;
  tokenSeq = 0;
  opaqueSeq = 0;
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
  generateRandomString.mockImplementation((n: number) => `rand${n}x`.padEnd(n, '0').slice(0, n));
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
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});


const RESET_PATH = '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';
const META_PATH = '/_matrix/client/v1/auth_metadata';

async function encryptClientSecret(secret = 'idp-client-secret'): Promise<string> {
  return encryptSecret(secret, { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY });
}

async function seedState(
  sessions: ReturnType<typeof mockKv>,
  partial: Partial<{
    providerId: string;
    nonce: string;
    redirectUri: string;
    returnTo: string;
  }> = {}
): Promise<string> {
  const state = 'leftover-state-1';
  sessions.data[`oidc_state:${state}`] = JSON.stringify({
    providerId: PROVIDER_ID,
    nonce: 'nonce-leftover',
    redirectUri: `https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`,
    returnTo: '/',
    ...partial,
  });
  return state;
}


// ---------------------------------------------------------------------------
// Providers list leftovers after #147
// ---------------------------------------------------------------------------

describe('oidc leftovers providers list after #147', () => {
  it('omits disabled providers and keeps enabled', async () => {
    const db = createOidcDb({
      providers: [
        seedProvider({ id: 'on', name: 'On', enabled: 1, display_order: 2 }),
        seedProvider({ id: 'off', name: 'Off', enabled: 0, display_order: 1 }),
      ],
    });
    const { status, body } = await request('/auth/oidc/providers', {}, envFor({ db }));
    expect(status).toBe(200);
    const providers = (body as { providers: Array<{ id: string }> }).providers;
    expect(providers.map((p) => p.id)).toEqual(['on']);
  });

  it('sorts by display_order then name', async () => {
    const db = createOidcDb({
      providers: [
        seedProvider({ id: 'b', name: 'Bravo', display_order: 1 }),
        seedProvider({ id: 'a', name: 'Alpha', display_order: 1 }),
        seedProvider({ id: 'c', name: 'Charlie', display_order: 0 }),
      ],
    });
    const { body } = await request('/auth/oidc/providers', {}, envFor({ db }));
    expect((body as { providers: Array<{ id: string }> }).providers.map((p) => p.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('login_url is /auth/oidc/:id/login and omits secrets', async () => {
    const db = createOidcDb({ providers: [seedProvider()] });
    const { body } = await request('/auth/oidc/providers', {}, envFor({ db }));
    const p = (body as { providers: Array<Record<string, unknown>> }).providers[0];
    expect(p.login_url).toBe(`/auth/oidc/${PROVIDER_ID}/login`);
    expect(p).not.toHaveProperty('client_secret_encrypted');
    expect(p).not.toHaveProperty('client_id');
  });

  it('preserves null icon_url', async () => {
    const db = createOidcDb({ providers: [seedProvider({ icon_url: null })] });
    const { body } = await request('/auth/oidc/providers', {}, envFor({ db }));
    expect((body as { providers: Array<{ icon_url: unknown }> }).providers[0].icon_url).toBeNull();
  });

  it('empty enabled set returns empty providers array', async () => {
    const { body } = await request('/auth/oidc/providers', {}, envFor({ db: createOidcDb() }));
    expect(body).toEqual({ providers: [] });
  });
});

// ---------------------------------------------------------------------------
// Login buildAuthorizationUrl arg contracts after #147
// ---------------------------------------------------------------------------

describe('oidc leftovers login authorization arg contracts after #147', () => {
  it('forwards provider.scopes string verbatim', async () => {
    const scopes = 'openid offline_access custom';
    const db = createOidcDb({ providers: [seedProvider({ scopes })] });
    generateRandomString.mockReturnValue('A'.repeat(32));
    await request(`/auth/oidc/${PROVIDER_ID}/login`, {}, envFor({ db }));
    expect(buildAuthorizationUrl.mock.calls[0][3]).toBe(scopes);
  });

  it('empty scopes string still reaches buildAuthorizationUrl', async () => {
    const db = createOidcDb({ providers: [seedProvider({ scopes: '' })] });
    generateRandomString.mockReturnValue('B'.repeat(32));
    await request(`/auth/oidc/${PROVIDER_ID}/login`, {}, envFor({ db }));
    expect(buildAuthorizationUrl.mock.calls[0][3]).toBe('');
  });

  it('arg order is discovery, client_id, redirectUri, scopes, state, nonce', async () => {
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider({ client_id: 'cid-z' })] });
    let n = 0;
    generateRandomString.mockImplementation(() => {
      n += 1;
      return n === 1 ? 'STATE________________________' : 'NONCE________________________';
    });
    await request(`/auth/oidc/${PROVIDER_ID}/login`, {}, envFor({ db, sessions }));
    expect(buildAuthorizationUrl.mock.calls[0]).toEqual([
      DISCOVERY,
      'cid-z',
      `https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`,
      'openid profile email',
      'STATE________________________',
      'NONCE________________________',
    ]);
  });

  it('two sequential logins create two distinct oidc_state keys', async () => {
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider()] });
    let i = 0;
    generateRandomString.mockImplementation(() => {
      i += 1;
      return `S${i}`.padEnd(32, '0').slice(0, 32);
    });
    await request(`/auth/oidc/${PROVIDER_ID}/login`, {}, envFor({ db, sessions }));
    await request(`/auth/oidc/${PROVIDER_ID}/login`, {}, envFor({ db, sessions }));
    const keys = sessions.puts.filter((p) => p.key.startsWith('oidc_state:')).map((p) => p.key);
    expect(new Set(keys).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Callback token issuance failures after #147
// ---------------------------------------------------------------------------

describe('oidc leftovers token issuance failures after #147', () => {
  async function readyCallback(opts: {
    createDeviceReject?: boolean;
    createAccessTokenReject?: boolean;
    createUserReject?: boolean;
    linkInsertFail?: boolean;
    existingLink?: boolean;
  } = {}) {
    const sessions = mockKv();
    const state = await seedState(sessions);
    const secret = await encryptClientSecret();
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: opts.existingLink
        ? [
            {
              id: 1,
              provider_id: PROVIDER_ID,
              external_id: 'ext-sub-1',
              user_id: USER,
              external_email: null,
              external_name: null,
            },
          ]
        : [],
      failLinkInsert: opts.linkInsertFail,
    });
    if (opts.createDeviceReject) createDevice.mockRejectedValue(new Error('device boom'));
    if (opts.createAccessTokenReject)
      createAccessToken.mockRejectedValue(new Error('token boom'));
    if (opts.createUserReject) createUser.mockRejectedValue(new Error('user boom'));
    return { sessions, state, db };
  }

  it('createDevice reject → Authentication Failed; no createAccessToken', async () => {
    const { sessions, state, db } = await readyCallback({
      existingLink: true,
      createDeviceReject: true,
    });
    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );
    expect(text).toContain('Authentication Failed');
    expect(text).toContain('device boom');
    expect(createAccessToken).not.toHaveBeenCalled();
  });

  it('createAccessToken reject → Authentication Failed after createDevice', async () => {
    const { sessions, state, db } = await readyCallback({
      existingLink: true,
      createAccessTokenReject: true,
    });
    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );
    expect(text).toContain('Authentication Failed');
    expect(createDevice).toHaveBeenCalled();
    expect(text).toContain('token boom');
  });

  it('createUser reject → Authentication Failed; no createDevice', async () => {
    const { sessions, state, db } = await readyCallback({ createUserReject: true });
    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );
    expect(text).toContain('Authentication Failed');
    expect(createDevice).not.toHaveBeenCalled();
  });

  it('success: createDevice display name is SSO Login (provider.name)', async () => {
    const { sessions, state, db } = await readyCallback({ existingLink: true });
    await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );
    expect(createDevice.mock.calls[0][3]).toBe('SSO Login (Google)');
  });

  it('success HTML embeds raw access token and device id', async () => {
    const { sessions, state, db } = await readyCallback({ existingLink: true });
    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );
    expect(text).toContain('Login Successful');
    expect(text).toContain('syt_token_1');
    expect(text).toContain('DEV1');
    expect(text).toContain(USER);
  });

  it('createAccessToken receives hashed token not raw syt_ token', async () => {
    const { sessions, state, db } = await readyCallback({ existingLink: true });
    await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );
    const [, tokenHash] = createAccessToken.mock.calls[0] as [unknown, string, ...unknown[]];
    // hash is first after db; signature createAccessToken(db, tokenId, tokenHash, userId, deviceId)
    const args = createAccessToken.mock.calls[0];
    expect(args).not.toContain('syt_token_1');
    expect(typeof args[2]).toBe('string');
    expect(args[2]).not.toBe('syt_token_1');
    expect(args[3]).toBe(USER);
    expect(args[4]).toBe('DEV1');
    void tokenHash;
  });

  it('existing-link success still issues a new device+token session', async () => {
    const { sessions, state, db } = await readyCallback({ existingLink: true });
    await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );
    expect(createDevice).toHaveBeenCalledTimes(1);
    expect(createAccessToken).toHaveBeenCalledTimes(1);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('provider name with HTML chars reflected into success device name path via createDevice', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions);
    const secret = await encryptClientSecret();
    const db = createOidcDb({
      providers: [
        seedProvider({
          client_secret_encrypted: secret,
          name: '<b>Evil</b>',
        }),
      ],
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
    await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );
    expect(createDevice.mock.calls[0][3]).toBe('SSO Login (<b>Evil</b>)');
  });

  it('exchangeCodeForTokens receives state redirectUri', async () => {
    const sessions = mockKv();
    const redirectUri = 'https://alt.example/auth/oidc/google/callback';
    const state = await seedState(sessions, { redirectUri });
    const secret = await encryptClientSecret();
    const db = createOidcDb({
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
    await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=authcode&state=${state}`,
      {},
      envFor({ sessions, db })
    );
    expect(exchangeCodeForTokens.mock.calls[0]).toEqual(
      expect.arrayContaining(['authcode', redirectUri])
    );
  });

  it('Continue href uses returnTo from state', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions, { returnTo: '/app/home' });
    const secret = await encryptClientSecret();
    const db = createOidcDb({
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
    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );
    expect(text).toContain('href="/app/home"');
  });
});

// ---------------------------------------------------------------------------
// Login soft reliability after #147 (auth-adjacent)
// ---------------------------------------------------------------------------

describe('oidc leftovers login soft reliability after #147', () => {
  it('unknown provider id → M_NOT_FOUND JSON', async () => {
    const { status, body } = await request(
      '/auth/oidc/missing/login',
      {},
      envFor({ db: createOidcDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('disabled provider → M_NOT_FOUND', async () => {
    const db = createOidcDb({ providers: [seedProvider({ enabled: 0 })] });
    const { status, body } = await request(
      `/auth/oidc/${PROVIDER_ID}/login`,
      {},
      envFor({ db })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('discovery throw → M_UNKNOWN 500', async () => {
    const db = createOidcDb({ providers: [seedProvider()] });
    fetchOIDCDiscovery.mockRejectedValue(new Error('disco down'));
    const { status, body } = await request(
      `/auth/oidc/${PROVIDER_ID}/login`,
      {},
      envFor({ db })
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('buildAuthorizationUrl throw → M_UNKNOWN 500', async () => {
    const db = createOidcDb({ providers: [seedProvider()] });
    generateRandomString.mockReturnValue('Z'.repeat(32));
    buildAuthorizationUrl.mockImplementation(() => {
      throw new Error('url build fail');
    });
    const { status, body } = await request(
      `/auth/oidc/${PROVIDER_ID}/login`,
      {},
      envFor({ db })
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('percent-encoded provider id path matches provider row id', async () => {
    const id = 'okta-prod';
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider({ id })] });
    generateRandomString.mockReturnValue('Q'.repeat(32));
    const { status } = await request(`/auth/oidc/${id}/login`, {}, envFor({ db, sessions }));
    expect(status).toBe(302);
    expect(JSON.parse(sessions.puts[0].value).providerId).toBe(id);
  });
});
