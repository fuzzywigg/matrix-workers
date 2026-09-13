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

  it('parses unquoted destination', () => {
    expect(
      parseAuthHeader(
        'X-Matrix origin=a.example.com,destination=b.example.com,key=ed25519:k,sig=abc'
      )
    ).toEqual({
      origin: 'a.example.com',
      destination: 'b.example.com',
      key: 'ed25519:k',
      sig: 'abc',
    });
  });

  it('parses empty quotes via the unquoted fallback as literal quote chars', () => {
    // Quoted regex requires [^"]+ so "" is skipped; unquoted then captures ""
    expect(parseAuthHeader('X-Matrix origin="",key="ed25519:k",sig="s"')).toEqual({
      origin: '""',
      key: 'ed25519:k',
      sig: 's',
    });
  });

  it('is scheme-prefix sensitive (exact X-Matrix )', () => {
    expect(parseAuthHeader('x-matrix origin="a",key="k",sig="s"')).toBeNull();
    expect(parseAuthHeader('X-Matrixorigin="a",key="k",sig="s"')).toBeNull();
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
    expect(buildSignedRequest('PUT', '/path', 'a', 'b', '').content).toBe('');
  });

  it('preserves method and uri verbatim', () => {
    const req = buildSignedRequest(
      'PUT',
      '/_matrix/federation/v1/send/txn1?foo=1',
      'origin.example.com',
      'dest.example.com',
      { pdus: [] }
    );
    expect(req.method).toBe('PUT');
    expect(req.uri).toBe('/_matrix/federation/v1/send/txn1?foo=1');
    expect(req.origin).toBe('origin.example.com');
    expect(req.destination).toBe('dest.example.com');
  });
});

describe('parseAuthHeader failure edges', () => {
  it('returns null when only destination is present among optional fields', () => {
    expect(
      parseAuthHeader('X-Matrix destination="b.example.com",key="ed25519:k",sig="s"')
    ).toBeNull();
  });

  it('returns null for empty header and whitespace-only after scheme', () => {
    expect(parseAuthHeader('')).toBeNull();
    expect(parseAuthHeader('X-Matrix')).toBeNull();
    expect(parseAuthHeader('X-Matrix   ')).toBeNull();
  });

  it('does not treat Authorization Bearer as X-Matrix', () => {
    expect(parseAuthHeader('Authorization: X-Matrix origin="a",key="k",sig="s"')).toBeNull();
  });

  it('parses destination with spaces stripped by unquoted regex boundaries', () => {
    const parsed = parseAuthHeader(
      'X-Matrix origin="a.example.com", destination="b.example.com",key="ed25519:k",sig="s"'
    );
    expect(parsed?.destination).toBe('b.example.com');
  });
});

describe('buildSignedRequest nested content', () => {
  it('preserves nested PDU-shaped content objects by reference identity', () => {
    const content = { pdus: [{ type: 'm.room.message' }], edus: [] };
    const req = buildSignedRequest('PUT', '/send/t1', 'a', 'b', content);
    expect(req.content).toBe(content);
  });
});

describe('parseAuthHeader duplicate quoted params', () => {
  it('lets the last quoted value win when the same key appears twice', () => {
    expect(
      parseAuthHeader(
        'X-Matrix origin="first",origin="second",key="ed25519:k",sig="s"'
      )
    ).toEqual({
      origin: 'second',
      key: 'ed25519:k',
      sig: 's',
    });
  });
});


describe('parseAuthHeader TOKENMAXX edge paths after #49', () => {
  it('ignores wrong-cased param keys (exact origin/key/sig required)', () => {
    expect(
      parseAuthHeader('X-Matrix Origin="a",key="k",sig="s"')
    ).toBeNull();
    expect(
      parseAuthHeader('X-Matrix origin="a",Key="k",sig="s"')
    ).toBeNull();
  });

  it('returns null for incomplete required-field matrices', () => {
    expect(parseAuthHeader('X-Matrix sig="s"')).toBeNull();
    expect(parseAuthHeader('X-Matrix origin="a",sig="s"')).toBeNull();
    expect(parseAuthHeader('X-Matrix key="k"')).toBeNull();
  });
});

describe('parseAuthHeader / buildSignedRequest TOKENMAXX edge paths after #50', () => {
  it('keeps commas inside quoted signature values intact', () => {
    expect(
      parseAuthHeader('X-Matrix origin="a.example.com",key="ed25519:k",sig="a,b,c"')
    ).toEqual({
      origin: 'a.example.com',
      key: 'ed25519:k',
      sig: 'a,b,c',
    });
  });

  it('truncates unquoted values at the first comma', () => {
    expect(
      parseAuthHeader('X-Matrix origin=a.example.com,key=ed25519:k,sig=a,b')
    ).toEqual({
      origin: 'a.example.com',
      key: 'ed25519:k',
      sig: 'a',
    });
  });

  it('omits content when buildSignedRequest receives explicit undefined', () => {
    expect(
      buildSignedRequest('GET', '/_matrix/federation/v1/version', 'a', 'b', undefined)
    ).toEqual({
      method: 'GET',
      uri: '/_matrix/federation/v1/version',
      origin: 'a',
      destination: 'b',
    });
  });
});
