/**
 * TOKENMAXX HEAVY deepen after #113 — different slice: OIDC auth API routes.
 * Avoids media (#109/#113), identity/federation (#111), oauth (#106), push (#107).
 * Covers src/api/oidc-auth.ts via Hono app.request(): providers, login redirect,
 * callback (link / auto-create / auto-link), auth_metadata, MSC3861 identity reset,
 * plus exported encryptSecret/decryptSecret helpers.
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

// ---------------------------------------------------------------------------
// encryptSecret / decryptSecret (exported helpers)
// ---------------------------------------------------------------------------

describe('encryptSecret / decryptSecret', () => {
  it('round-trips plaintext with version 0x02 prefix when OIDC_ENCRYPTION_KEY set', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    const enc = await encryptSecret('super-secret', env);
    expect(typeof enc).toBe('string');
    const raw = Uint8Array.from(atob(enc), (c) => c.charCodeAt(0));
    expect(raw[0]).toBe(0x02);
    expect(raw.length).toBeGreaterThan(1 + 12);
    await expect(decryptSecret(enc, env)).resolves.toBe('super-secret');
  });

  it('produces distinct ciphertexts for same plaintext (random IV)', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    const a = await encryptSecret('same', env);
    const b = await encryptSecret('same', env);
    expect(a).not.toBe(b);
    expect(await decryptSecret(a, env)).toBe('same');
    expect(await decryptSecret(b, env)).toBe('same');
  });

  it('refuses to encrypt when OIDC_ENCRYPTION_KEY missing', async () => {
    await expect(encryptSecret('x', { SERVER_NAME: SERVER })).rejects.toThrow(
      /OIDC_ENCRYPTION_KEY is required/
    );
  });

  it('rejects encrypt when OIDC_ENCRYPTION_KEY is wrong length', async () => {
    const short = btoa('too-short');
    await expect(
      encryptSecret('x', { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY: short })
    ).rejects.toThrow(/must be 32 bytes/);
  });

  it('decrypts legacy version 0x01 secrets with SERVER_NAME-derived key', async () => {
    const env = { SERVER_NAME: SERVER };
    // Manually encrypt with legacy key derivation (version byte 0x01)
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(SERVER.padEnd(32, '0').slice(0, 32)),
      'AES-GCM',
      false,
      ['encrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode('legacy-secret'))
    );
    const combined = new Uint8Array(1 + iv.length + encrypted.length);
    combined[0] = 0x01;
    combined.set(iv, 1);
    combined.set(encrypted, 13);
    const b64 = btoa(String.fromCharCode(...combined));

    await expect(decryptSecret(b64, env)).resolves.toBe('legacy-secret');
  });

  it('decrypts unversioned legacy blob (no version byte) via SERVER_NAME key', async () => {
    const env = { SERVER_NAME: SERVER };
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(SERVER.padEnd(32, '0').slice(0, 32)),
      'AES-GCM',
      false,
      ['encrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode('old-format'))
    );
    // Old format: IV || ciphertext (no version byte)
    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv, 0);
    combined.set(encrypted, 12);
    const b64 = btoa(String.fromCharCode(...combined));

    await expect(decryptSecret(b64, env)).resolves.toBe('old-format');
  });

  it('decrypts secure 0x02 secrets even when SERVER_NAME differs', async () => {
    const enc = await encryptSecret('portable', {
      SERVER_NAME: SERVER,
      OIDC_ENCRYPTION_KEY,
    });
    await expect(
      decryptSecret(enc, { SERVER_NAME: 'other.example', OIDC_ENCRYPTION_KEY })
    ).resolves.toBe('portable');
  });

  it('fails decrypt of 0x02 secret when OIDC_ENCRYPTION_KEY wrong', async () => {
    const enc = await encryptSecret('locked', {
      SERVER_NAME: SERVER,
      OIDC_ENCRYPTION_KEY,
    });
    const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    await expect(
      decryptSecret(enc, { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY: otherKey })
    ).rejects.toThrow();
  });

  it('round-trips empty string and unicode secrets', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    expect(await decryptSecret(await encryptSecret('', env), env)).toBe('');
    const unicode = 'パスワード🔐 café';
    expect(await decryptSecret(await encryptSecret(unicode, env), env)).toBe(unicode);
  });

  it('round-trips long secrets (>1KB)', async () => {
    const env = { SERVER_NAME: SERVER, OIDC_ENCRYPTION_KEY };
    const long = 'x'.repeat(2048);
    expect(await decryptSecret(await encryptSecret(long, env), env)).toBe(long);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/oidc/providers
// ---------------------------------------------------------------------------

describe('GET /auth/oidc/providers', () => {
  it('returns empty providers list when none enabled', async () => {
    const db = createOidcDb({ providers: [] });
    const { status, body } = await request('/auth/oidc/providers', {}, envFor({ db }));
    expect(status).toBe(200);
    expect(body).toEqual({ providers: [] });
  });

  it('maps enabled providers with login_url and omits secrets', async () => {
    const db = createOidcDb({
      providers: [
        seedProvider({ id: 'b', name: 'Beta', display_order: 2, icon_url: null }),
        seedProvider({ id: 'a', name: 'Alpha', display_order: 1 }),
        seedProvider({ id: 'off', name: 'Off', enabled: 0, display_order: 0 }),
      ],
    });
    const { status, body } = await request('/auth/oidc/providers', {}, envFor({ db }));
    expect(status).toBe(200);
    expect(body).toEqual({
      providers: [
        {
          id: 'a',
          name: 'Alpha',
          icon_url: 'https://cdn.example.com/google.svg',
          login_url: '/auth/oidc/a/login',
        },
        {
          id: 'b',
          name: 'Beta',
          icon_url: null,
          login_url: '/auth/oidc/b/login',
        },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(/client_secret|issuer_url/);
  });

  it('sorts by display_order then name when orders tie', async () => {
    const db = createOidcDb({
      providers: [
        seedProvider({ id: 'z', name: 'Zed', display_order: 1, icon_url: null }),
        seedProvider({ id: 'a', name: 'Able', display_order: 1, icon_url: null }),
      ],
    });
    const { body } = await request('/auth/oidc/providers', {}, envFor({ db }));
    const ids = (body as { providers: Array<{ id: string }> }).providers.map((p) => p.id);
    expect(ids).toEqual(['a', 'z']);
  });

  it('is public (no auth required) and returns JSON content-type', async () => {
    const { status, headers } = await request(
      '/auth/oidc/providers',
      {},
      envFor({ db: createOidcDb({ providers: [seedProvider()] }) })
    );
    expect(status).toBe(200);
    expect(headers.get('content-type')).toMatch(/application\/json/);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/oidc/:providerId/login
// ---------------------------------------------------------------------------

describe('GET /auth/oidc/:providerId/login', () => {
  it('returns M_NOT_FOUND when provider missing', async () => {
    const db = createOidcDb({ providers: [] });
    const { status, body } = await request('/auth/oidc/missing/login', {}, envFor({ db }));
    expect(status).toBe(404);
    expect(body).toEqual({ errcode: 'M_NOT_FOUND', error: 'Identity provider not found' });
  });

  it('returns M_NOT_FOUND when provider disabled', async () => {
    const db = createOidcDb({
      providers: [seedProvider({ enabled: 0 })],
    });
    const { status, body } = await request(`/auth/oidc/${PROVIDER_ID}/login`, {}, envFor({ db }));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('redirects to IdP authorize URL and stores state in SESSIONS', async () => {
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider()] });
    let stateCall = 0;
    generateRandomString.mockImplementation((n: number) => {
      stateCall += 1;
      return stateCall === 1 ? 'STATE32CHARS________________' : 'NONCE32CHARS________________';
    });
    buildAuthorizationUrl.mockReturnValue('https://idp.example/authorize?x=1');

    const { status, headers } = await request(
      `/auth/oidc/${PROVIDER_ID}/login?return_to=/rooms`,
      {},
      envFor({ db, sessions })
    );

    expect(status).toBe(302);
    expect(headers.get('location')).toBe('https://idp.example/authorize?x=1');
    expect(fetchOIDCDiscovery).toHaveBeenCalledWith(ISSUER);
    expect(buildAuthorizationUrl).toHaveBeenCalledWith(
      DISCOVERY,
      'client-abc',
      `https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`,
      'openid profile email',
      'STATE32CHARS________________',
      'NONCE32CHARS________________'
    );

    const put = sessions.puts.find((p) => p.key.startsWith('oidc_state:'));
    expect(put).toBeDefined();
    expect(put!.options?.expirationTtl).toBe(600);
    expect(JSON.parse(put!.value)).toEqual({
      providerId: PROVIDER_ID,
      nonce: 'NONCE32CHARS________________',
      redirectUri: `https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`,
      returnTo: '/rooms',
    });
  });

  it('defaults return_to to / when query omitted', async () => {
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider()] });
    generateRandomString
      .mockReturnValueOnce('STATEAAAAAAAAAAAAAAAAAAAAAAA')
      .mockReturnValueOnce('NONCEBBBBBBBBBBBBBBBBBBBBBBBB');

    await request(`/auth/oidc/${PROVIDER_ID}/login`, {}, envFor({ db, sessions }));
    const put = sessions.puts[0];
    expect(JSON.parse(put.value).returnTo).toBe('/');
  });

  it('uses Host header for redirect_uri when present', async () => {
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider()] });
    generateRandomString.mockReturnValue('X'.repeat(32));

    await request(
      `/auth/oidc/${PROVIDER_ID}/login`,
      { headers: { Host: 'matrix.example.com' } },
      envFor({ db, sessions })
    );

    expect(buildAuthorizationUrl.mock.calls[0][2]).toBe(
      `https://matrix.example.com/auth/oidc/${PROVIDER_ID}/callback`
    );
  });

  it('returns M_UNKNOWN 500 when discovery throws', async () => {
    const db = createOidcDb({ providers: [seedProvider()] });
    fetchOIDCDiscovery.mockRejectedValue(new Error('discovery down'));
    const { status, body } = await request(`/auth/oidc/${PROVIDER_ID}/login`, {}, envFor({ db }));
    expect(status).toBe(500);
    expect(body).toEqual({ errcode: 'M_UNKNOWN', error: 'Failed to initiate login' });
  });

  it('returns M_UNKNOWN 500 when buildAuthorizationUrl throws', async () => {
    const db = createOidcDb({ providers: [seedProvider()] });
    generateRandomString.mockReturnValue('Y'.repeat(32));
    buildAuthorizationUrl.mockImplementation(() => {
      throw new Error('bad scopes');
    });
    const { status, body } = await request(`/auth/oidc/${PROVIDER_ID}/login`, {}, envFor({ db }));
    expect(status).toBe(500);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('does not put state when discovery fails before state generation completes', async () => {
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider()] });
    fetchOIDCDiscovery.mockRejectedValue(new Error('nope'));
    await request(`/auth/oidc/${PROVIDER_ID}/login`, {}, envFor({ db, sessions }));
    expect(sessions.puts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/oidc/:providerId/callback
// ---------------------------------------------------------------------------

describe('GET /auth/oidc/:providerId/callback', () => {
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
    const state = 'callback-state-1';
    sessions.data[`oidc_state:${state}`] = JSON.stringify({
      providerId: PROVIDER_ID,
      nonce: 'nonce-abc',
      redirectUri: `https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`,
      returnTo: '/',
      ...partial,
    });
    return state;
  }

  it('renders error HTML when IdP returns error query', async () => {
    const { status, text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?error=access_denied&error_description=User%20denied`,
      {}
    );
    expect(status).toBe(200);
    expect(text).toContain('Authentication Failed');
    expect(text).toContain('User denied');
  });

  it('falls back to error code when error_description omitted', async () => {
    const { text } = await request(`/auth/oidc/${PROVIDER_ID}/callback?error=server_error`, {});
    expect(text).toContain('server_error');
  });

  it('renders Invalid Request when code missing', async () => {
    const { text } = await request(`/auth/oidc/${PROVIDER_ID}/callback?state=x`, {});
    expect(text).toContain('Invalid Request');
    expect(text).toContain('Missing code or state parameter');
  });

  it('renders Invalid Request when state missing', async () => {
    const { text } = await request(`/auth/oidc/${PROVIDER_ID}/callback?code=abc`, {});
    expect(text).toContain('Missing code or state parameter');
  });

  it('renders Invalid State when state KV entry missing/expired', async () => {
    const sessions = mockKv();
    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=gone`,
      {},
      envFor({ sessions, db: createOidcDb({ providers: [seedProvider()] }) })
    );
    expect(text).toContain('Invalid State');
    expect(text).toContain('login session has expired');
  });

  it('deletes state and rejects provider mismatch', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions, { providerId: 'other' });
    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db: createOidcDb({ providers: [seedProvider()] }) })
    );
    expect(text).toContain('Provider mismatch');
    expect(sessions.deletes).toContain(`oidc_state:${state}`);
    expect(sessions.data[`oidc_state:${state}`]).toBeUndefined();
  });

  it('renders Provider Not Found when provider disabled after login', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions);
    const db = createOidcDb({ providers: [seedProvider({ enabled: 0 })] });
    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );
    expect(text).toContain('Provider Not Found');
  });

  it('happy path: existing user link updates last_login and returns success HTML', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions, { returnTo: '/app' });
    const secret = await encryptClientSecret();
    const db = createOidcDb({
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

    const { status, text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=authcode&state=${state}`,
      {},
      envFor({ sessions, db })
    );

    expect(status).toBe(200);
    expect(text).toContain('Login Successful');
    expect(text).toContain(USER);
    expect(text).toContain('syt_token_1');
    expect(text).toContain('DEV1');
    expect(text).toContain('href="/app"');
    expect(exchangeCodeForTokens).toHaveBeenCalledWith(
      DISCOVERY,
      'client-abc',
      'idp-client-secret',
      'authcode',
      `https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`
    );
    expect(validateIDToken).toHaveBeenCalledWith(
      'fake.jwt.token',
      ISSUER,
      'client-abc',
      'nonce-abc',
      { keys: [{ kty: 'RSA', kid: 'k1' }] }
    );
    expect(createDevice).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      'DEV1',
      'SSO Login (Google)'
    );
    expect(createAccessToken).toHaveBeenCalled();
    expect(db.updates.some((u) => u.sql.includes('UPDATE idp_user_links'))).toBe(true);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('auto-creates new Matrix user when auto_create_users=1 and no link', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions);
    const secret = await encryptClientSecret();
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 1 })],
    });
    getUserById.mockResolvedValue(null);
    deriveUsername.mockReturnValue('alice');

    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );

    expect(text).toContain('Login Successful');
    expect(createUser).toHaveBeenCalledWith(expect.anything(), USER, 'alice', null, false);
    expect(db.inserts.some((i) => i.sql.includes('INSERT INTO idp_user_links'))).toBe(true);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET display_name'))).toBe(true);
  });

  it('skips display_name update when claims.name absent on create', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions);
    const secret = await encryptClientSecret();
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
    });
    validateIDToken.mockResolvedValue({
      sub: 'ext-sub-2',
      preferred_username: 'bob',
    });
    deriveUsername.mockReturnValue('bob');
    getUserById.mockResolvedValue(null);

    await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );

    expect(createUser).toHaveBeenCalledWith(
      expect.anything(),
      '@bob:example.com',
      'bob',
      null,
      false
    );
    expect(db.updates.filter((u) => u.sql.includes('display_name'))).toHaveLength(0);
  });

  it('auto-links existing Matrix user when username already taken', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions);
    const secret = await encryptClientSecret();
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
    });
    getUserById.mockResolvedValue({
      user_id: USER,
      localpart: 'alice',
      display_name: 'Alice',
      avatar_url: null,
      password_hash: null,
      is_guest: 0,
      is_deactivated: 0,
      admin: 0,
      created_at: NOW,
    });

    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );

    expect(text).toContain('Login Successful');
    expect(createUser).not.toHaveBeenCalled();
    expect(db.links).toHaveLength(1);
    expect(db.links[0]).toMatchObject({
      provider_id: PROVIDER_ID,
      external_id: 'ext-sub-1',
      user_id: USER,
    });
  });

  it('renders Account Not Found when auto_create_users=0 and no link', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions);
    const secret = await encryptClientSecret();
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: secret, auto_create_users: 0 })],
    });

    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );

    expect(text).toContain('Account Not Found');
    expect(text).toContain('No account is linked');
    expect(createUser).not.toHaveBeenCalled();
    expect(createAccessToken).not.toHaveBeenCalled();
  });

  it('renders Authentication Failed HTML when token exchange throws', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions);
    const secret = await encryptClientSecret();
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
    });
    exchangeCodeForTokens.mockRejectedValue(new Error('bad code'));

    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );

    expect(text).toContain('Authentication Failed');
    expect(text).toContain('bad code');
  });

  it('renders Authentication Failed when ID token validation throws', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions);
    const secret = await encryptClientSecret();
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
    });
    validateIDToken.mockRejectedValue(new Error('nonce mismatch'));

    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );

    expect(text).toContain('nonce mismatch');
  });

  it('renders Authentication Failed when client secret decrypt fails', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions);
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: 'not-valid-base64!!!' })],
    });

    const { text } = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );

    expect(text).toContain('Authentication Failed');
  });

  it('consumes state exactly once (second callback with same state fails)', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions);
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

    const first = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c1&state=${state}`,
      {},
      envFor({ sessions, db })
    );
    expect(first.text).toContain('Login Successful');

    const second = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c2&state=${state}`,
      {},
      envFor({ sessions, db })
    );
    expect(second.text).toContain('login session has expired');
  });

  it('passes null email/name to link update when claims omit them', async () => {
    const sessions = mockKv();
    const state = await seedState(sessions);
    const secret = await encryptClientSecret();
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
      links: [
        {
          id: 3,
          provider_id: PROVIDER_ID,
          external_id: 'ext-sub-1',
          user_id: USER,
          external_email: 'old@example.com',
          external_name: 'Old',
        },
      ],
    });
    validateIDToken.mockResolvedValue({ sub: 'ext-sub-1' });

    await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=c&state=${state}`,
      {},
      envFor({ sessions, db })
    );

    const upd = db.updates.find((u) => u.sql.includes('UPDATE idp_user_links'));
    expect(upd?.args[1]).toBeNull();
    expect(upd?.args[2]).toBeNull();
    expect(upd?.args[3]).toBe(3);
  });

  it('success page defaults Continue href to / when returnTo undefined', async () => {
    const sessions = mockKv();
    const state = 'st';
    // Omit returnTo field entirely
    sessions.data[`oidc_state:${state}`] = JSON.stringify({
      providerId: PROVIDER_ID,
      nonce: 'n',
      redirectUri: `https://${SERVER}/auth/oidc/${PROVIDER_ID}/callback`,
    });
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
    expect(text).toContain('href="/"');
  });
});

// ---------------------------------------------------------------------------
// GET /_matrix/client/v1/auth_metadata
// ---------------------------------------------------------------------------

describe('GET /_matrix/client/v1/auth_metadata', () => {
  it('returns MSC2965 OIDC metadata for the homeserver', async () => {
    const { status, body } = await request('/_matrix/client/v1/auth_metadata');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      issuer: `https://${SERVER}`,
      authorization_endpoint: `https://${SERVER}/oauth/authorize`,
      token_endpoint: `https://${SERVER}/oauth/token`,
      revocation_endpoint: `https://${SERVER}/oauth/revoke`,
      registration_endpoint: `https://${SERVER}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256', 'plain'],
      device_authorization_endpoint: `https://${SERVER}/oauth/device`,
      account_management_uri: `https://${SERVER}/admin`,
      prompt_values_supported: ['create'],
    });
  });

  it('includes Matrix client scopes and account management actions', async () => {
    const { body } = await request('/_matrix/client/v1/auth_metadata');
    const meta = body as {
      scopes_supported: string[];
      account_management_actions_supported: string[];
      token_endpoint_auth_methods_supported: string[];
    };
    expect(meta.scopes_supported).toEqual(
      expect.arrayContaining([
        'openid',
        'urn:matrix:org.matrix.msc2967.client:api:*',
        'urn:matrix:org.matrix.msc2967.client:device:*',
      ])
    );
    expect(meta.account_management_actions_supported).toEqual(
      expect.arrayContaining([
        'org.matrix.profile',
        'org.matrix.sessions_list',
        'org.matrix.session_view',
        'org.matrix.session_end',
        'org.matrix.cross_signing_reset',
      ])
    );
    expect(meta.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('reflects SERVER_NAME in all endpoint URLs', async () => {
    const { body } = await request(
      '/_matrix/client/v1/auth_metadata',
      {},
      envFor({ serverName: 'matrix.fuzzy.test' })
    );
    const meta = body as Record<string, unknown>;
    expect(meta.issuer).toBe('https://matrix.fuzzy.test');
    expect(String(meta.authorization_endpoint)).toContain('matrix.fuzzy.test');
    expect(String(meta.account_management_uri)).toBe('https://matrix.fuzzy.test/admin');
  });

  it('is public and does not touch DB', async () => {
    const db = createOidcDb({ providers: [] });
    const prepareSpy = vi.spyOn(db, 'prepare');
    const { status } = await request('/_matrix/client/v1/auth_metadata', {}, envFor({ db }));
    expect(status).toBe(200);
    expect(prepareSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST MSC3861 identity reset
// ---------------------------------------------------------------------------

const RESET_PATH = '/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset';

describe('POST MSC3861 account/identity/reset', () => {
  it('deletes DO + D1 + KV cross-signing and records device_key_changes', async () => {
    const userKeys = createUserKeysStub();
    const crossSigning = mockKv({ [`user:${USER}`]: '{"keys":true}' });
    const db = createOidcDb({ streamPositions: { device_keys: 41 } });

    const { status, body } = await request(
      RESET_PATH,
      { method: 'POST' },
      envFor({ db, userKeys, crossSigning })
    );

    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(userKeys.fetches).toEqual([
      { url: 'http://internal/cross-signing/delete', method: 'POST' },
    ]);
    expect(crossSigning.deletes).toContain(`user:${USER}`);
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM cross_signing_keys'))).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM cross_signing_signatures'))).toBe(
      true
    );
    expect(db.streamPositions.device_keys).toBe(42);
    const change = db.inserts.find((i) => i.sql.includes('INSERT INTO device_key_changes'));
    expect(change?.args).toEqual([USER, 42]);
  });

  it('uses stream position 1 when stream_positions row missing after bump', async () => {
    const db = createOidcDb({ streamPositions: {} });
    // After bump, first() returns null → position defaults to 1
    const { status, body } = await request(RESET_PATH, { method: 'POST' }, envFor({ db }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    const change = db.inserts.find((i) => i.sql.includes('device_key_changes'));
    expect(change?.args[1]).toBe(1);
  });

  it('returns M_UNKNOWN 500 when USER_KEYS DO fetch throws', async () => {
    const userKeys = createUserKeysStub({ throwOnFetch: true });
    const db = createOidcDb();
    const { status, body } = await request(
      RESET_PATH,
      { method: 'POST' },
      envFor({ db, userKeys })
    );
    expect(status).toBe(500);
    expect(body).toEqual({ errcode: 'M_UNKNOWN', error: 'Failed to reset identity' });
    expect(db.deletes).toHaveLength(0);
  });

  it('returns M_UNKNOWN 500 when D1 cross_signing_keys delete fails', async () => {
    const userKeys = createUserKeysStub();
    const db = createOidcDb({ failCrossSigningDelete: true });
    const { status, body } = await request(
      RESET_PATH,
      { method: 'POST' },
      envFor({ db, userKeys })
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('returns M_UNKNOWN 500 when stream position bump fails', async () => {
    const userKeys = createUserKeysStub();
    const db = createOidcDb({ failStreamUpdate: true });
    const { status, body } = await request(
      RESET_PATH,
      { method: 'POST' },
      envFor({ db, userKeys })
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('still succeeds when KV delete is a no-op (key already absent)', async () => {
    const crossSigning = mockKv();
    const { status, body } = await request(
      RESET_PATH,
      { method: 'POST' },
      envFor({ crossSigning, db: createOidcDb() })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(crossSigning.deletes).toContain(`user:${USER}`);
  });

  it('requires auth middleware (mocked principal is alice)', async () => {
    const db = createOidcDb();
    await request(RESET_PATH, { method: 'POST' }, envFor({ db }));
    const del = db.deletes.find((d) => d.sql.includes('cross_signing_keys'));
    expect(del?.args[0]).toBe(USER);
  });

  it('rejects GET on reset path (method not allowed / not found)', async () => {
    const { status } = await request(RESET_PATH, { method: 'GET' });
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// Cross-endpoint integration / leftover edges
// ---------------------------------------------------------------------------

describe('oidc-auth TOKENMAXX route leftovers after #113', () => {
  it('login → callback happy path end-to-end with shared KV state', async () => {
    const sessions = mockKv();
    const secret = await encryptSecret('e2e-secret', {
      SERVER_NAME: SERVER,
      OIDC_ENCRYPTION_KEY,
    });
    const db = createOidcDb({
      providers: [seedProvider({ client_secret_encrypted: secret })],
    });
    getUserById.mockResolvedValue(null);
    deriveUsername.mockReturnValue('alice');

    generateRandomString
      .mockReturnValueOnce('E2ESTATE______________________')
      .mockReturnValueOnce('E2ENONCE______________________');

    const login = await request(
      `/auth/oidc/${PROVIDER_ID}/login?return_to=/sync`,
      {},
      envFor({ db, sessions })
    );
    expect(login.status).toBe(302);

    const stateKey = sessions.puts[0].key.replace('oidc_state:', '');
    const cb = await request(
      `/auth/oidc/${PROVIDER_ID}/callback?code=e2e&state=${stateKey}`,
      {},
      envFor({ db, sessions })
    );
    expect(cb.text).toContain('Login Successful');
    expect(cb.text).toContain('href="/sync"');
    expect(exchangeCodeForTokens.mock.calls[0][2]).toBe('e2e-secret');
  });

  it('providers list login_url matches login route that 404s for unknown id', async () => {
    const db = createOidcDb({
      providers: [seedProvider({ id: 'only', name: 'Only' })],
    });
    const list = await request('/auth/oidc/providers', {}, envFor({ db }));
    const loginUrl = (list.body as { providers: Array<{ login_url: string }> }).providers[0]
      .login_url;
    expect(loginUrl).toBe('/auth/oidc/only/login');

    const miss = await request('/auth/oidc/other/login', {}, envFor({ db }));
    expect(miss.status).toBe(404);
  });

  it('auth_metadata scopes include openid before Matrix urn scopes', async () => {
    const { body } = await request('/_matrix/client/v1/auth_metadata');
    const scopes = (body as { scopes_supported: string[] }).scopes_supported;
    expect(scopes[0]).toBe('openid');
  });

  it('callback IdP error page includes Return to login link', async () => {
    const { text } = await request(`/auth/oidc/${PROVIDER_ID}/callback?error=oops`, {});
    expect(text).toContain('href="/"');
    expect(text).toContain('Return to login');
  });

  it('login stores exactly one oidc_state KV put per request', async () => {
    const sessions = mockKv();
    const db = createOidcDb({ providers: [seedProvider()] });
    generateRandomString.mockReturnValue('Z'.repeat(32));
    await request(`/auth/oidc/${PROVIDER_ID}/login`, {}, envFor({ db, sessions }));
    expect(sessions.puts.filter((p) => p.key.startsWith('oidc_state:'))).toHaveLength(1);
  });

  it('encryptSecret ciphertext is valid base64 without whitespace', async () => {
    const enc = await encryptSecret('tok', {
      SERVER_NAME: SERVER,
      OIDC_ENCRYPTION_KEY,
    });
    expect(enc).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('identity reset does not call createUser or OIDC discovery', async () => {
    await request(RESET_PATH, { method: 'POST' }, envFor({ db: createOidcDb() }));
    expect(createUser).not.toHaveBeenCalled();
    expect(fetchOIDCDiscovery).not.toHaveBeenCalled();
  });

  it('callback with empty string code treated as missing', async () => {
    // `?code=&state=x` → code is '' which is falsy
    const { text } = await request(`/auth/oidc/${PROVIDER_ID}/callback?code=&state=x`, {});
    expect(text).toContain('Missing code or state parameter');
  });

  it('multiple providers: login uses the path provider id not another enabled one', async () => {
    const sessions = mockKv();
    const db = createOidcDb({
      providers: [
        seedProvider({ id: 'a', name: 'A', client_id: 'cid-a' }),
        seedProvider({ id: 'b', name: 'B', client_id: 'cid-b' }),
      ],
    });
    generateRandomString.mockReturnValue('P'.repeat(32));
    await request('/auth/oidc/b/login', {}, envFor({ db, sessions }));
    expect(buildAuthorizationUrl.mock.calls[0][1]).toBe('cid-b');
    expect(JSON.parse(sessions.puts[0].value).providerId).toBe('b');
  });
});
