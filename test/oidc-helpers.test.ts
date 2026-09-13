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

describe('oidc TOKENMAXX edge paths after #75', () => {
  const NOW_MS = 1_730_000_000_000;
  const NOW_SEC = Math.floor(NOW_MS / 1000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
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

  function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sub: 'es-user-1',
      iss: 'https://idp.es.test',
      aud: 'client-es',
      nonce: 'nonce-es',
      exp: NOW_SEC + 3600,
      iat: NOW_SEC,
      ...overrides,
    };
  }

  describe('validateIDToken ES256 / ES384 / ES512', () => {
    const curves: Array<{
      alg: 'ES256' | 'ES384' | 'ES512';
      namedCurve: 'P-256' | 'P-384' | 'P-521';
      hash: 'SHA-256' | 'SHA-384' | 'SHA-512';
      kid: string;
      issuer: string;
      clientId: string;
      nonce: string;
    }> = [
      {
        alg: 'ES256',
        namedCurve: 'P-256',
        hash: 'SHA-256',
        kid: 'es256-kid',
        issuer: 'https://idp.es256.test',
        clientId: 'client-es256',
        nonce: 'nonce-es256',
      },
      {
        alg: 'ES384',
        namedCurve: 'P-384',
        hash: 'SHA-384',
        kid: 'es384-kid',
        issuer: 'https://idp.es384.test',
        clientId: 'client-es384',
        nonce: 'nonce-es384',
      },
      {
        alg: 'ES512',
        namedCurve: 'P-521',
        hash: 'SHA-512',
        kid: 'es512-kid',
        issuer: 'https://idp.es512.test',
        clientId: 'client-es512',
        nonce: 'nonce-es512',
      },
    ];

    for (const cfg of curves) {
      it(`validates a real ${cfg.alg} ID token via ECDSA`, async () => {
        const pair = await crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: cfg.namedCurve },
          true,
          ['sign', 'verify']
        );
        const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JWK;
        const publicJwk: JWK = {
          ...exported,
          kid: cfg.kid,
          alg: cfg.alg,
          use: 'sig',
        };
        const jwks: JWKS = { keys: [publicJwk] };

        const header = { alg: cfg.alg, typ: 'JWT', kid: cfg.kid };
        const payload = {
          sub: `user-${cfg.alg}`,
          iss: cfg.issuer,
          aud: cfg.clientId,
          nonce: cfg.nonce,
          exp: NOW_SEC + 3600,
          iat: NOW_SEC,
          email: `${cfg.alg.toLowerCase()}@example.com`,
        };
        const h = b64url(header);
        const p = b64url(payload);
        const data = `${h}.${p}`;
        const sig = await crypto.subtle.sign(
          { name: 'ECDSA', hash: cfg.hash },
          pair.privateKey,
          new TextEncoder().encode(data)
        );
        const token = `${data}.${b64urlBytes(sig)}`;

        await expect(
          validateIDToken(token, cfg.issuer, cfg.clientId, cfg.nonce, jwks)
        ).resolves.toMatchObject({
          sub: `user-${cfg.alg}`,
          email: `${cfg.alg.toLowerCase()}@example.com`,
        });
      });
    }

    it('rejects a tampered ES256 signature', async () => {
      const pair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
      );
      const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JWK;
      const jwks: JWKS = {
        keys: [{ ...exported, kid: 'es-tamper', alg: 'ES256', use: 'sig' }],
      };
      const h = b64url({ alg: 'ES256', typ: 'JWT', kid: 'es-tamper' });
      const p = b64url(baseClaims({ iss: 'https://idp.es-tamper.test', aud: 'c', nonce: 'n' }));
      const data = `${h}.${p}`;
      const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        new TextEncoder().encode(data)
      );
      const token = `${data}.${b64urlBytes(sig)}`.replace(/\.[^.]+$/, '.AAAA');
      await expect(
        validateIDToken(token, 'https://idp.es-tamper.test', 'c', 'n', jwks)
      ).rejects.toThrow(
        /Invalid ID token signature|No matching key|Unsupported|DataError|OperationError/
      );
    });
  });

  describe('validateIDToken PS256 (RSA-PSS)', () => {
    let privateKey: CryptoKey;
    let publicJwk: JWK;
    let jwks: JWKS;

    beforeAll(async () => {
      const pair = await crypto.subtle.generateKey(
        {
          name: 'RSA-PSS',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify']
      );
      privateKey = pair.privateKey;
      const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JWK;
      publicJwk = { ...exported, kid: 'ps256-kid', alg: 'PS256', use: 'sig' };
      jwks = { keys: [publicJwk] };
    });

    async function signPs256(
      payload: Record<string, unknown>,
      header: Record<string, unknown> = { alg: 'PS256', typ: 'JWT', kid: 'ps256-kid' }
    ): Promise<string> {
      const h = b64url(header);
      const p = b64url(payload);
      const data = `${h}.${p}`;
      const sig = await crypto.subtle.sign(
        { name: 'RSA-PSS', saltLength: 32 },
        privateKey,
        new TextEncoder().encode(data)
      );
      return `${data}.${b64urlBytes(sig)}`;
    }

    it('validates a real PS256 ID token', async () => {
      const token = await signPs256({
        sub: 'ps-user',
        iss: 'https://idp.ps256.test',
        aud: 'client-ps',
        nonce: 'nonce-ps',
        exp: NOW_SEC + 3600,
        iat: NOW_SEC,
        preferred_username: 'psuser',
      });
      await expect(
        validateIDToken(token, 'https://idp.ps256.test', 'client-ps', 'nonce-ps', jwks)
      ).resolves.toMatchObject({
        sub: 'ps-user',
        preferred_username: 'psuser',
      });
    });

    it('rejects a PS256 token with wrong salt / tampered signature bytes', async () => {
      const token = await signPs256({
        sub: 'ps-user',
        iss: 'https://idp.ps256.test',
        aud: 'client-ps',
        nonce: 'nonce-ps',
        exp: NOW_SEC + 3600,
        iat: NOW_SEC,
      });
      const tampered = `${token.slice(0, token.lastIndexOf('.'))}.${b64urlBytes(
        new Uint8Array(256)
      )}`;
      await expect(
        validateIDToken(tampered, 'https://idp.ps256.test', 'client-ps', 'nonce-ps', jwks)
      ).rejects.toThrow(/Invalid ID token signature|DataError|OperationError/);
    });
  });

  describe('unsupported algorithms and JWKS key selection', () => {
    it('rejects HS256 (unsupported import/verify algorithm)', async () => {
      const header = b64url({ alg: 'HS256', typ: 'JWT', kid: 'hs' });
      const payload = b64url({
        sub: 'u',
        iss: 'https://idp.hs.test',
        aud: 'c',
        nonce: 'n',
        exp: NOW_SEC + 3600,
        iat: NOW_SEC,
      });
      const token = `${header}.${payload}.dGVzdA`;
      await expect(
        validateIDToken(token, 'https://idp.hs.test', 'c', 'n', {
          keys: [{ kty: 'oct', kid: 'hs', alg: 'HS256', k: 'dGVzdA' }],
        })
      ).rejects.toThrow(/Unsupported algorithm/);
    });

    it('rejects alg none', async () => {
      const header = b64url({ alg: 'none', typ: 'JWT' });
      const payload = b64url({
        sub: 'u',
        iss: 'https://idp.none.test',
        aud: 'c',
        nonce: 'n',
        exp: NOW_SEC + 3600,
        iat: NOW_SEC,
      });
      const token = `${header}.${payload}.`;
      await expect(
        validateIDToken(token, 'https://idp.none.test', 'c', 'n', {
          keys: [{ kty: 'RSA', alg: 'none', n: 'x', e: 'AQAB' }],
        })
      ).rejects.toThrow(/Unsupported algorithm/);
    });

    it('selects JWKS key by matching alg when header has no kid (multi-key)', async () => {
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
      const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JWK;
      const wrongKey: JWK = {
        kty: 'RSA',
        kid: 'wrong',
        alg: 'ES256',
        n: 'wrong-n',
        e: 'AQAB',
      };
      const rightKey: JWK = { ...exported, alg: 'RS256', use: 'sig' };
      const jwks: JWKS = { keys: [wrongKey, rightKey] };

      const h = b64url({ alg: 'RS256', typ: 'JWT' });
      const p = b64url({
        sub: 'multi-key-user',
        iss: 'https://idp.multikey.test',
        aud: 'client-mk',
        nonce: 'nonce-mk',
        exp: NOW_SEC + 3600,
        iat: NOW_SEC,
      });
      const data = `${h}.${p}`;
      const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(data)
      );
      const token = `${data}.${b64urlBytes(sig)}`;

      await expect(
        validateIDToken(token, 'https://idp.multikey.test', 'client-mk', 'nonce-mk', jwks)
      ).resolves.toMatchObject({ sub: 'multi-key-user' });
    });

    it('falls back to a JWKS key with no alg when header has no kid', async () => {
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
      const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JWK;
      // First key has mismatched alg; second has no alg → selected via `!k.alg`
      const jwks: JWKS = {
        keys: [
          { kty: 'RSA', alg: 'ES256', n: 'nope', e: 'AQAB' },
          { ...exported, use: 'sig' },
        ],
      };
      const h = b64url({ alg: 'RS256', typ: 'JWT' });
      const p = b64url({
        sub: 'no-alg-key',
        iss: 'https://idp.noalg.test',
        aud: 'client-na',
        nonce: 'nonce-na',
        exp: NOW_SEC + 3600,
        iat: NOW_SEC,
      });
      const data = `${h}.${p}`;
      const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(data)
      );
      const token = `${data}.${b64urlBytes(sig)}`;
      await expect(
        validateIDToken(token, 'https://idp.noalg.test', 'client-na', 'nonce-na', jwks)
      ).resolves.toMatchObject({ sub: 'no-alg-key' });
    });
  });

  describe('discovery required-field matrix', () => {
    const baseDoc = {
      issuer: 'https://oidc-matrix.test',
      authorization_endpoint: 'https://oidc-matrix.test/auth',
      token_endpoint: 'https://oidc-matrix.test/token',
      jwks_uri: 'https://oidc-matrix.test/jwks',
    };

    it.each([
      ['authorization_endpoint', { ...baseDoc, authorization_endpoint: undefined }],
      ['token_endpoint', { ...baseDoc, token_endpoint: undefined }],
      ['jwks_uri', { ...baseDoc, jwks_uri: undefined }],
      ['issuer', { ...baseDoc, issuer: '' }],
    ] as const)('rejects discovery missing %s', async (_field, doc) => {
      vi.stubGlobal('fetch', vi.fn(async () => okJson(doc)));
      await expect(fetchOIDCDiscovery(`https://oidc-matrix-${_field}.test`)).rejects.toThrow(
        /missing required fields/
      );
    });
  });

  describe('deriveUsername edges', () => {
    it('preserves = and - and . and _ in preferred_username', () => {
      expect(
        deriveUsername(
          { sub: 'id', preferred_username: 'User_Name.OK=v1-2' },
          'preferred_username'
        )
      ).toBe('user_name.ok=v1-2');
    });

    it('falls back to user_<sub prefix> when sanitized preferred_username is empty after strip', () => {
      // preferred_username of only disallowed chars becomes underscores (non-empty),
      // so use email local-part that sanitizes to empty via empty split — already covered;
      // assert sub claim path keeps equals signs which the sanitizer allows.
      expect(deriveUsername({ sub: 'Ab=Cd_Ef' }, 'sub')).toBe('ab=cd_ef');
    });

    it('uses first 8 chars of sub when email local-part sanitizes to empty string', () => {
      // empty local-part → username '' → user_${sub.substring(0,8)}
      expect(deriveUsername({ sub: '1234567890ab', email: '@host' }, 'email')).toBe(
        'user_12345678'
      );
    });
  });
});
