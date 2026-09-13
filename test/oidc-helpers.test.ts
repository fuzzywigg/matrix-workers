import { describe, it, expect } from 'vitest';
import {
  buildAuthorizationUrl,
  decodeJWT,
  deriveUsername,
  generateRandomString,
  validateIDToken,
  type OIDCDiscovery,
  type JWKS,
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
    // '@x.com' → empty local-part → sanitize empties → user_<sub prefix>
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
    // "!!!" → "___" which is non-empty, so no user_<sub> fallback
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
    // {"sub":"a>b"} uses characters that force base64url -/_ when encoded without padding
    const payload = Buffer.from(JSON.stringify({ sub: 'a>b?c' }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const token = `${b64url({ alg: 'none' })}.${payload}.sig`;
    expect(decodeJWT(token).payload).toEqual({ sub: 'a>b?c' });
  });
});

function b64urlBytes(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function makeRs256Token(
  payload: Record<string, unknown>,
  opts: { kid?: string; privateKey?: CryptoKey; publicJwk?: JsonWebKey } = {}
): Promise<{ token: string; jwks: JWKS; privateKey: CryptoKey }> {
  let privateKey = opts.privateKey;
  let publicJwk = opts.publicJwk;
  if (!privateKey || !publicJwk) {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    );
    privateKey = pair.privateKey;
    publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  }
  const kid = opts.kid ?? 'kid-1';
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const encHeader = b64url(header);
  const encPayload = b64url(payload);
  const signedData = `${encHeader}.${encPayload}`;
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signedData)
  );
  const token = `${signedData}.${b64urlBytes(sig)}`;
  const jwks: JWKS = {
    keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig', kty: 'RSA' }],
  };
  return { token, jwks, privateKey };
}

describe('validateIDToken', () => {
  const issuer = 'https://idp.example.com';
  const clientId = 'matrix-client';
  const nonce = 'nonce-abc';

  it('accepts a valid RS256 ID token and returns claim subset', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await makeRs256Token({
      iss: issuer,
      aud: clientId,
      sub: 'user-42',
      email: 'a@b.c',
      preferred_username: 'alice',
      name: 'Alice',
      nonce,
      iat: now,
      exp: now + 600,
    });
    await expect(validateIDToken(token, issuer, clientId, nonce, jwks)).resolves.toEqual({
      sub: 'user-42',
      email: 'a@b.c',
      email_verified: undefined,
      name: 'Alice',
      preferred_username: 'alice',
      picture: undefined,
      given_name: undefined,
      family_name: undefined,
    });
  });

  it('accepts issuer with trailing slash and aud as array', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await makeRs256Token({
      iss: `${issuer}/`,
      aud: ['other', clientId],
      sub: 'u',
      nonce,
      iat: now,
      exp: now + 600,
    });
    await expect(
      validateIDToken(token, `${issuer}/`, clientId, nonce, jwks)
    ).resolves.toMatchObject({ sub: 'u' });
  });

  it('rejects wrong signature, issuer, audience, nonce, expiry, and future iat', async () => {
    const now = Math.floor(Date.now() / 1000);
    const base = {
      iss: issuer,
      aud: clientId,
      sub: 'u',
      nonce,
      iat: now,
      exp: now + 600,
    };
    const good = await makeRs256Token(base);
    const other = await makeRs256Token(base); // different keypair

    // Same payload/header claims but signature from a different key vs good.jwks
    const parts = other.token.split('.');
    const forged = `${parts[0]}.${parts[1]}.${parts[2]}`;
    await expect(validateIDToken(forged, issuer, clientId, nonce, good.jwks)).rejects.toThrow(
      /Invalid ID token signature|No matching key/
    );

    const wrongIss = await makeRs256Token({ ...base, iss: 'https://evil.example.com' });
    await expect(
      validateIDToken(wrongIss.token, issuer, clientId, nonce, wrongIss.jwks)
    ).rejects.toThrow(/Invalid issuer/);

    const wrongAud = await makeRs256Token({ ...base, aud: 'other-client' });
    await expect(
      validateIDToken(wrongAud.token, issuer, clientId, nonce, wrongAud.jwks)
    ).rejects.toThrow(/Invalid audience/);

    const wrongNonce = await makeRs256Token({ ...base, nonce: 'nope' });
    await expect(
      validateIDToken(wrongNonce.token, issuer, clientId, nonce, wrongNonce.jwks)
    ).rejects.toThrow(/Invalid nonce/);

    const expired = await makeRs256Token({ ...base, exp: now - 10 });
    await expect(
      validateIDToken(expired.token, issuer, clientId, nonce, expired.jwks)
    ).rejects.toThrow(/expired/);

    const future = await makeRs256Token({ ...base, iat: now + 1000 });
    await expect(
      validateIDToken(future.token, issuer, clientId, nonce, future.jwks)
    ).rejects.toThrow(/issued in the future/);
  });

  it('allows missing exp and rejects empty JWKS', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await makeRs256Token({
      iss: issuer,
      aud: clientId,
      sub: 'u',
      nonce,
      iat: now,
      // no exp
    });
    await expect(validateIDToken(token, issuer, clientId, nonce, jwks)).resolves.toMatchObject({
      sub: 'u',
    });

    await expect(validateIDToken(token, issuer, clientId, nonce, { keys: [] })).rejects.toThrow(
      /No matching key/
    );
  });
});
