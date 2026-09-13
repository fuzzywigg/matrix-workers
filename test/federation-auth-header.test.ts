import { describe, it, expect } from 'vitest';
import { parseAuthHeader, buildSignedRequest } from '../src/middleware/federation-auth';

describe('parseAuthHeader', () => {
  it('parses quoted X-Matrix params', () => {
    expect(
      parseAuthHeader(
        'X-Matrix origin="matrix.example.com",key="ed25519:abc",sig="sigvalue"'
      )
    ).toEqual({
      origin: 'matrix.example.com',
      key: 'ed25519:abc',
      sig: 'sigvalue',
    });
  });

  it('parses destination when present', () => {
    expect(
      parseAuthHeader(
        'X-Matrix origin="a.example.com",destination="b.example.com",key="ed25519:k",sig="s"'
      )?.destination
    ).toBe('b.example.com');
  });

  it('parses unquoted params', () => {
    expect(parseAuthHeader('X-Matrix origin=a.example.com,key=ed25519:k,sig=abc123')).toEqual({
      origin: 'a.example.com',
      key: 'ed25519:k',
      sig: 'abc123',
    });
  });

  it('lets quoted values win over unquoted duplicates', () => {
    expect(
      parseAuthHeader(
        'X-Matrix origin="quoted.example.com",origin=unquoted.example.com,key="ed25519:k",sig="s"'
      )
    ).toEqual({
      origin: 'quoted.example.com',
      key: 'ed25519:k',
      sig: 's',
    });
  });

  it('parses mixed quoted and unquoted params', () => {
    expect(
      parseAuthHeader('X-Matrix origin="a.example.com",key=ed25519:k,sig="sigvalue"')
    ).toEqual({
      origin: 'a.example.com',
      key: 'ed25519:k',
      sig: 'sigvalue',
    });
  });

  it('returns null for missing scheme or required fields', () => {
    expect(parseAuthHeader('Bearer token')).toBeNull();
    expect(parseAuthHeader('X-Matrix origin="a",key="k"')).toBeNull();
    expect(parseAuthHeader('X-Matrix key="k",sig="s"')).toBeNull();
    expect(parseAuthHeader('X-Matrix ')).toBeNull();
  });

  it('ignores unknown keys and trailing commas', () => {
    const parsed = parseAuthHeader(
      'X-Matrix origin="a.example.com",key="ed25519:k",sig="s",extra="nope",'
    );
    expect(parsed).toEqual({
      origin: 'a.example.com',
      key: 'ed25519:k',
      sig: 's',
    });
  });
});

describe('buildSignedRequest', () => {
  it('omits content when null or undefined', () => {
    expect(buildSignedRequest('GET', '/_matrix/federation/v1/version', 'a', 'b')).toEqual({
      method: 'GET',
      uri: '/_matrix/federation/v1/version',
      origin: 'a',
      destination: 'b',
    });
    expect(buildSignedRequest('PUT', '/path', 'a', 'b', null)).not.toHaveProperty('content');
  });

  it('includes content when provided, including falsy JSON values', () => {
    expect(buildSignedRequest('PUT', '/path', 'a', 'b', { ok: true })).toEqual({
      method: 'PUT',
      uri: '/path',
      origin: 'a',
      destination: 'b',
      content: { ok: true },
    });
    expect(buildSignedRequest('PUT', '/path', 'a', 'b', 0).content).toBe(0);
    expect(buildSignedRequest('PUT', '/path', 'a', 'b', false).content).toBe(false);
    expect(buildSignedRequest('PUT', '/path', 'a', 'b', []).content).toEqual([]);
  });
});
