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

  it('returns null when Authorization is only Bearer with trailing spaces', () => {
    // Fetch Headers typically trim, leaving a bare "Bearer" that fails the regex
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: 'Bearer   ' },
    });
    expect(extractAccessToken(req)).toBeNull();
  });

  it('treats empty access_token query values as missing (falsy)', () => {
    const req = new Request('https://matrix.example.com/?access_token=');
    expect(extractAccessToken(req)).toBeNull();
  });

  it('allows tokens that contain spaces after the first non-space', () => {
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: 'Bearer tok with spaces' },
    });
    expect(extractAccessToken(req)).toBe('tok with spaces');
  });

  it('ignores non-Bearer schemes even when access_token query is present', () => {
    // Authorization is present but not Bearer → falls through to query
    const req = new Request('https://matrix.example.com/?access_token=from_query', {
      headers: { Authorization: 'Basic abc' },
    });
    expect(extractAccessToken(req)).toBe('from_query');
  });

  it('returns null for Bearer with only a scheme and tab/space noise after Header trim', () => {
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: 'Bearer\t' },
    });
    expect(extractAccessToken(req)).toBeNull();
  });
});


describe('extractAccessToken TOKENMAXX edge paths after #49', () => {
  it('falls back to query when Authorization is an empty string', () => {
    const req = new Request('https://matrix.example.com/?access_token=from_query', {
      headers: { Authorization: '' },
    });
    // Empty Authorization header is typically omitted by Fetch; if present as empty, no Bearer match
    expect(extractAccessToken(req)).toBe('from_query');
  });

  it('decodes percent-encoded access_token query values', () => {
    const req = new Request('https://matrix.example.com/?access_token=syt%5Fabc');
    expect(extractAccessToken(req)).toBe('syt_abc');
  });
});
