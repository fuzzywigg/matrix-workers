import { describe, it, expect } from 'vitest';
import { extractAccessToken } from '../src/middleware/auth';

describe('extractAccessToken', () => {
  it('reads a Bearer token from Authorization', () => {
    const req = new Request('https://matrix.example.com/_matrix/client/v3/sync', {
      headers: { Authorization: 'Bearer syt_secret_token' },
    });
    expect(extractAccessToken(req)).toBe('syt_secret_token');
  });

  it('is case-insensitive on the Bearer scheme', () => {
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: 'bearer lowercase-token' },
    });
    expect(extractAccessToken(req)).toBe('lowercase-token');
  });

  it('falls back to the access_token query parameter', () => {
    const req = new Request(
      'https://matrix.example.com/_matrix/client/v3/sync?access_token=query_token'
    );
    expect(extractAccessToken(req)).toBe('query_token');
  });

  it('prefers the Authorization header over the query parameter', () => {
    const req = new Request(
      'https://matrix.example.com/_matrix/client/v3/sync?access_token=query_token',
      { headers: { Authorization: 'Bearer header_token' } }
    );
    expect(extractAccessToken(req)).toBe('header_token');
  });

  it('returns null when no token is present', () => {
    expect(extractAccessToken(new Request('https://matrix.example.com/'))).toBeNull();
  });

  it('returns null for malformed Authorization headers', () => {
    const basic = new Request('https://matrix.example.com/', {
      headers: { Authorization: 'Basic abc' },
    });
    const emptyBearer = new Request('https://matrix.example.com/', {
      headers: { Authorization: 'Bearer' },
    });
    expect(extractAccessToken(basic)).toBeNull();
    expect(extractAccessToken(emptyBearer)).toBeNull();
  });
});
