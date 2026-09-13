import { describe, it, expect } from 'vitest';
import {
  buildAuthorizationUrl,
  decodeJWT,
  deriveUsername,
  generateRandomString,
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
