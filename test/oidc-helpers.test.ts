import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizationUrl,
  decodeJWT,
  deriveUsername,
  exchangeCodeForTokens,
  fetchJWKS,
  fetchOIDCDiscovery,
  generateRandomString,
  validateIDToken,
  type JWK,
  type JWKS,
  type OIDCDiscovery,
} from '../src/services/oidc';

const discovery: OIDCDiscovery = {
  issuer: 'https://idp.example.com',
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  jwks_uri: 'https://idp.example.com/jwks',
  userinfo_endpoint: 'https://idp.example.com/userinfo',
  response_types_supported: ['code'],
  id_token_signing_alg_values_supported: ['RS256'],
};

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlBytes(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('buildAuthorizationUrl', () => {
  it('builds a URL with the required OAuth query params', () => {
    const url = new URL(
      buildAuthorizationUrl(
        discovery,
        'client-1',
        'https://matrix.example.com/callback',
        'openid profile',
        'state-xyz',
        'nonce-abc'
      )
    );
    expect(url.origin + url.pathname).toBe('https://idp.example.com/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://matrix.example.com/callback');
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(url.searchParams.get('state')).toBe('state-xyz');
    expect(url.searchParams.get('nonce')).toBe('nonce-abc');
  });
});

describe('decodeJWT', () => {
  it('decodes header, payload, and signature parts', () => {
    const token = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ sub: 'user-1', email: 'a@b.c' })}.sig`;
    const decoded = decodeJWT(token);
    expect(decoded.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decoded.payload).toEqual({ sub: 'user-1', email: 'a@b.c' });
    expect(decoded.signature).toBe('sig');
  });

  it('rejects tokens that are not three parts', () => {
    expect(() => decodeJWT('only.two')).toThrow(/Invalid JWT format/);
    expect(() => decodeJWT('a.b.c.d')).toThrow(/Invalid JWT format/);
  });
});

describe('deriveUsername', () => {
  it('derives from email local-part', () => {
    expect(deriveUsername({ sub: 'id', email: 'Alice.Smith@example.com' }, 'email')).toBe(
      'alice.smith'
    );
  });

  it('derives from preferred_username and sanitizes', () => {
    expect(
      deriveUsername({ sub: 'id', preferred_username: 'Cool User!' }, 'preferred_username')
    ).toBe('cool_user_');
  });

  it('derives from sub and falls back when the email local-part is empty', () => {
    expect(deriveUsername({ sub: 'abcdef12xxxx' }, 'sub')).toBe('abcdef12xxxx');
    expect(deriveUsername({ sub: 'abcdefghijkl', email: '@x.com' }, 'email')).toBe('user_abcdefgh');
  });

  it('throws when the requested claim is missing or unknown', () => {
    expect(() => deriveUsername({ sub: 'id' }, 'email')).toThrow(/Email claim/);
    expect(() => deriveUsername({ sub: 'id' }, 'preferred_username')).toThrow(
      /preferred_username/
    );
    expect(() => deriveUsername({ sub: 'id' }, 'nickname')).toThrow(/Unknown username claim/);
  });

  it('lowercases and sanitizes preferred_username punctuation', () => {
    expect(
      deriveUsername({ sub: 'id', preferred_username: 'User-Name.OK' }, 'preferred_username')
    ).toBe('user-name.ok');
    expect(
      deriveUsername({ sub: 'id', preferred_username: '!!!' }, 'preferred_username')
    ).toBe('___');
  });
});

describe('generateRandomString (oidc)', () => {
  it('returns hex of twice the requested byte length', () => {
    const s = generateRandomString(16);
    expect(s).toHaveLength(32);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
});

describe('oidc TOKENMAXX edge paths after #49', () => {
  it('throws when JWT payload is not JSON', () => {
    expect(() => decodeJWT('not-json.not-json.sig')).toThrow();
  });
});

describe('oidc TOKENMAXX edge paths after #50', () => {
  it('defaults generateRandomString to 32 bytes (64 hex chars)', () => {
    const s = generateRandomString();
    expect(s).toHaveLength(64);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });

  it('URL-encodes spaces and special characters in authorization params', () => {
    const url = new URL(
      buildAuthorizationUrl(
        discovery,
        'client-1',
        'https://matrix.example.com/cb?x=1',
        'openid',
        'state a',
        'nonce'
      )
    );
    expect(url.searchParams.get('state')).toBe('state a');
    expect(url.searchParams.get('redirect_uri')).toBe('https://matrix.example.com/cb?x=1');
  });

  it('sanitizes email local-parts that are only punctuation to underscores', () => {
    expect(deriveUsername({ sub: 'abcdefghijkl', email: '!!!@x.com' }, 'email')).toBe('___');
  });

  it('decodes base64url payloads that use - and _ alphabets', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'a>b?c' }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const token = `${b64url({ alg: 'none' })}.${payload}.sig`;
    expect(decodeJWT(token).payload).toEqual({ sub: 'a>b?c' });
  });
});

describe('fetchOIDCDiscovery / fetchJWKS (clock-pinned cache)', () => {
  const NOW = 1_710_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function okJson(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('normalizes trailing slash, caches discovery, and skips refetch within TTL', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const doc = {
      issuer: 'https://oidc-cache-a.test',
      authorization_endpoint: 'https://oidc-cache-a.test/auth',
      token_endpoint: 'https://oidc-cache-a.test/token',
      jwks_uri: 'https://oidc-cache-a.test/jwks',
    };
    fetchMock.mockResolvedValue(okJson(doc));

    const first = await fetchOIDCDiscovery('https://oidc-cache-a.test/');
    const second = await fetchOIDCDiscovery('https://oidc-cache-a.test');
    expect(first).toEqual(doc);
    expect(second).toEqual(doc);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://oidc-cache-a.test/.well-known/openid-configuration'
    );
  });

  it('refetches discovery after CACHE_TTL (1h)', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const doc = {
      issuer: 'https://oidc-cache-b.test',
      authorization_endpoint: 'https://oidc-cache-b.test/auth',
      token_endpoint: 'https://oidc-cache-b.test/token',
      jwks_uri: 'https://oidc-cache-b.test/jwks',
    };
    fetchMock.mockImplementation(async () => okJson(doc));

    await fetchOIDCDiscovery('https://oidc-cache-b.test');
    vi.setSystemTime(NOW + 3_600_000);
    await fetchOIDCDiscovery('https://oidc-cache-b.test');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on non-OK discovery response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('nope', { status: 503 })
    );
    await expect(fetchOIDCDiscovery('https://oidc-fail-status.test')).rejects.toThrow(
      /Failed to fetch OIDC discovery.*503/
    );
  });

  it('throws when required discovery fields are missing', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      okJson({ issuer: 'https://oidc-incomplete.test' })
    );
    await expect(fetchOIDCDiscovery('https://oidc-incomplete.test')).rejects.toThrow(
      /missing required fields/
    );
  });

  it('caches JWKS and refetches after TTL', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const jwks = { keys: [{ kty: 'RSA', kid: 'k1', n: 'n', e: 'AQAB' }] };
    fetchMock.mockImplementation(async () => okJson(jwks));

    const uri = 'https://oidc-jwks-cache.test/jwks';
    expect(await fetchJWKS(uri)).toEqual(jwks);
    expect(await fetchJWKS(uri)).toEqual(jwks);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 3_600_000);
    await fetchJWKS(uri);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on non-OK JWKS response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('bad', { status: 404 })
    );
    await expect(fetchJWKS('https://oidc-jwks-fail.test/jwks')).rejects.toThrow(
      /Failed to fetch JWKS.*404/
    );
  });
});

describe('exchangeCodeForTokens', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs form-encoded grant params and returns JSON on success', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      const body = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(body)).toEqual({
        grant_type: 'authorization_code',
        code: 'auth-code',
        redirect_uri: 'https://cb',
        client_id: 'cid',
        client_secret: 'csecret',
      });
      return new Response(
        JSON.stringify({
          access_token: 'at',
          token_type: 'Bearer',
          id_token: 'idt',
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await exchangeCodeForTokens(
      discovery,
      'cid',
      'csecret',
      'auth-code',
      'https://cb'
    );
    expect(result).toEqual({
      access_token: 'at',
      token_type: 'Bearer',
      id_token: 'idt',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(discovery.token_endpoint);
  });

  it('throws with status and body text on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('invalid_grant', { status: 400 }))
    );
    await expect(
      exchangeCodeForTokens(discovery, 'cid', 'sec', 'bad', 'https://cb')
    ).rejects.toThrow(/Token exchange failed: 400 - invalid_grant/);
  });
});

describe('validateIDToken (RS256 + clock-pinned)', () => {
  const NOW_MS = 1_720_000_000_000;
  const NOW_SEC = Math.floor(NOW_MS / 1000);

  let privateKey: CryptoKey;
  let publicJwk: JWK;
  let jwks: JWKS;

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    );
    privateKey = pair.privateKey;
    const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JWK;
    publicJwk = { ...exported, kid: 'test-kid', alg: 'RS256', use: 'sig' };
    jwks = { keys: [publicJwk] };
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function signIdToken(
    payload: Record<string, unknown>,
    header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT', kid: 'test-kid' }
  ): Promise<string> {
    const h = b64url(header);
    const p = b64url(payload);
    const data = `${h}.${p}`;
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      new TextEncoder().encode(data)
    );
    return `${data}.${b64urlBytes(sig)}`;
  }

  function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sub: 'user-42',
      iss: 'https://idp.validate.test',
      aud: 'client-validate',
      nonce: 'nonce-1',
      exp: NOW_SEC + 3600,
      iat: NOW_SEC,
      email: 'user@example.com',
      email_verified: true,
      name: 'User FortyTwo',
      preferred_username: 'user42',
      picture: 'https://pic',
      given_name: 'User',
      family_name: 'FortyTwo',
      ...overrides,
    };
  }

  it('returns claims for a valid ID token', async () => {
    const token = await signIdToken(baseClaims());
    const claims = await validateIDToken(
      token,
      'https://idp.validate.test',
      'client-validate',
      'nonce-1',
      jwks
    );
    expect(claims).toEqual({
      sub: 'user-42',
      email: 'user@example.com',
      email_verified: true,
      name: 'User FortyTwo',
      preferred_username: 'user42',
      picture: 'https://pic',
      given_name: 'User',
      family_name: 'FortyTwo',
    });
  });

  it('accepts issuer with trailing slash on either side', async () => {
    const token = await signIdToken(baseClaims({ iss: 'https://idp.validate.test/' }));
    await expect(
      validateIDToken(token, 'https://idp.validate.test', 'client-validate', 'nonce-1', jwks)
    ).resolves.toMatchObject({ sub: 'user-42' });

    const token2 = await signIdToken(baseClaims({ iss: 'https://idp.validate.test' }));
    await expect(
      validateIDToken(token2, 'https://idp.validate.test/', 'client-validate', 'nonce-1', jwks)
    ).resolves.toMatchObject({ sub: 'user-42' });
  });

  it('accepts aud as an array containing the client id', async () => {
    const token = await signIdToken(
      baseClaims({ aud: ['other', 'client-validate'] })
    );
    await expect(
      validateIDToken(token, 'https://idp.validate.test', 'client-validate', 'nonce-1', jwks)
    ).resolves.toMatchObject({ sub: 'user-42' });
  });

  it('rejects bad signature', async () => {
    const token = await signIdToken(baseClaims());
    const tampered = token.replace(/\.[^.]+$/, '.AAAA');
    await expect(
      validateIDToken(tampered, 'https://idp.validate.test', 'client-validate', 'nonce-1', jwks)
    ).rejects.toThrow(/Invalid ID token signature|No matching key|Unsupported|DataError|OperationError/);
  });

  it('rejects issuer mismatch', async () => {
    const token = await signIdToken(baseClaims({ iss: 'https://evil.test' }));
    await expect(
      validateIDToken(token, 'https://idp.validate.test', 'client-validate', 'nonce-1', jwks)
    ).rejects.toThrow(/Invalid issuer/);
  });

  it('rejects audience mismatch', async () => {
    const token = await signIdToken(baseClaims({ aud: 'other-client' }));
    await expect(
      validateIDToken(token, 'https://idp.validate.test', 'client-validate', 'nonce-1', jwks)
    ).rejects.toThrow(/Invalid audience/);
  });

  it('rejects wrong nonce', async () => {
    const token = await signIdToken(baseClaims());
    await expect(
      validateIDToken(token, 'https://idp.validate.test', 'client-validate', 'nonce-other', jwks)
    ).rejects.toThrow(/Invalid nonce/);
  });

  it('treats exp === now as still valid (strict <)', async () => {
    const token = await signIdToken(baseClaims({ exp: NOW_SEC }));
    await expect(
      validateIDToken(token, 'https://idp.validate.test', 'client-validate', 'nonce-1', jwks)
    ).resolves.toMatchObject({ sub: 'user-42' });
  });

  it('rejects expired tokens just after exp', async () => {
    const token = await signIdToken(baseClaims({ exp: NOW_SEC - 1 }));
    await expect(
      validateIDToken(token, 'https://idp.validate.test', 'client-validate', 'nonce-1', jwks)
    ).rejects.toThrow(/ID token has expired/);
  });

  it('allows iat within +300s clock skew', async () => {
    const token = await signIdToken(baseClaims({ iat: NOW_SEC + 300 }));
    await expect(
      validateIDToken(token, 'https://idp.validate.test', 'client-validate', 'nonce-1', jwks)
    ).resolves.toMatchObject({ sub: 'user-42' });
  });

  it('rejects iat beyond +300s skew', async () => {
    const token = await signIdToken(baseClaims({ iat: NOW_SEC + 301 }));
    await expect(
      validateIDToken(token, 'https://idp.validate.test', 'client-validate', 'nonce-1', jwks)
    ).rejects.toThrow(/issued in the future/);
  });

  it('skips exp/iat checks when claims are falsy/missing', async () => {
    const token = await signIdToken(
      baseClaims({ exp: 0, iat: undefined })
    );
    // JSON.stringify drops undefined; ensure iat absent
    const decoded = decodeJWT(token);
    expect(decoded.payload.iat).toBeUndefined();
    await expect(
      validateIDToken(token, 'https://idp.validate.test', 'client-validate', 'nonce-1', jwks)
    ).resolves.toMatchObject({ sub: 'user-42' });
  });

  it('falls back to first key without kid when header.kid is missing', async () => {
    const token = await signIdToken(baseClaims(), { alg: 'RS256', typ: 'JWT' });
    await expect(
      validateIDToken(token, 'https://idp.validate.test', 'client-validate', 'nonce-1', jwks)
    ).resolves.toMatchObject({ sub: 'user-42' });
  });

  it('throws when JWKS has no matching key', async () => {
    const token = await signIdToken(baseClaims(), {
      alg: 'RS256',
      typ: 'JWT',
      kid: 'unknown-kid',
    });
    await expect(
      validateIDToken(token, 'https://idp.validate.test', 'client-validate', 'nonce-1', {
        keys: [{ kty: 'RSA', kid: 'other', alg: 'ES256', n: publicJwk.n, e: publicJwk.e }],
      })
    ).rejects.toThrow(/No matching key found in JWKS/);
  });

  it('throws on empty JWKS', async () => {
    const token = await signIdToken(baseClaims());
    await expect(
      validateIDToken(token, 'https://idp.validate.test', 'client-validate', 'nonce-1', {
        keys: [],
      })
    ).rejects.toThrow(/No matching key found in JWKS/);
  });
});
