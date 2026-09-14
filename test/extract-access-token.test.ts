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

describe('extractAccessToken TOKENMAXX edge paths after #50', () => {
  it('accepts an all-caps BEARER scheme', () => {
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: 'BEARER tok' },
    });
    expect(extractAccessToken(req)).toBe('tok');
  });

  it('uses the first access_token when the query param is duplicated', () => {
    const req = new Request(
      'https://matrix.example.com/?access_token=first&access_token=second'
    );
    expect(extractAccessToken(req)).toBe('first');
  });
});

describe('extractAccessToken TOKENMAXX HEAVY leftovers after #226', () => {
  it('collapses multiple spaces between Bearer and token via \\s+', () => {
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: 'Bearer    spaced_token' },
    });
    expect(extractAccessToken(req)).toBe('spaced_token');
  });

  it('accepts a tab between Bearer and token (\\s includes tab)', () => {
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: 'Bearer\ttab_token' },
    });
    expect(extractAccessToken(req)).toBe('tab_token');
  });

  it('accepts mixed-case BeArEr scheme', () => {
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: 'BeArEr MixEdTok' },
    });
    expect(extractAccessToken(req)).toBe('MixEdTok');
  });

  it('Fetch Headers trim a leading space before Bearer so the regex still matches', () => {
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: ' Bearer leading_ok' },
    });
    expect(req.headers.get('Authorization')).toBe('Bearer leading_ok');
    expect(extractAccessToken(req)).toBe('leading_ok');
  });

  it('does not treat Bearerx (no separator) as Bearer; falls through to query', () => {
    const req = new Request('https://matrix.example.com/?access_token=from_query', {
      headers: { Authorization: 'Bearerx not_a_match' },
    });
    expect(extractAccessToken(req)).toBe('from_query');
  });

  it('does not treat NotBearer as Bearer; falls through to query', () => {
    const req = new Request('https://matrix.example.com/?access_token=qtok', {
      headers: { Authorization: 'NotBearer x' },
    });
    expect(extractAccessToken(req)).toBe('qtok');
  });

  it('decodes application/x-www-form-urlencoded + in access_token as a space', () => {
    const req = new Request('https://matrix.example.com/?access_token=a+b');
    expect(extractAccessToken(req)).toBe('a b');
  });

  it('treats percent-encoded space-only access_token ("%20") as a truthy token', () => {
    const req = new Request('https://matrix.example.com/?access_token=%20');
    expect(extractAccessToken(req)).toBe(' ');
  });

  it('treats access_token=0 as a truthy token string', () => {
    const req = new Request('https://matrix.example.com/?access_token=0');
    expect(extractAccessToken(req)).toBe('0');
  });

  it('is case-sensitive on the query parameter name (Access_Token ≠ access_token)', () => {
    const req = new Request('https://matrix.example.com/?Access_Token=cap');
    expect(extractAccessToken(req)).toBeNull();
  });

  it('decodes percent-encoded slash and question mark in access_token', () => {
    const req = new Request('https://matrix.example.com/?access_token=hello%2Fworld%3F');
    expect(extractAccessToken(req)).toBe('hello/world?');
  });

  it('prefers Bearer even when query has a whitespace-only token', () => {
    const req = new Request('https://matrix.example.com/?access_token=%20', {
      headers: { Authorization: 'Bearer header_wins' },
    });
    expect(extractAccessToken(req)).toBe('header_wins');
  });

  it('returns null when Authorization is empty and no query token exists', () => {
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: '' },
    });
    expect(extractAccessToken(req)).toBeNull();
  });

  it('returns the greedy capture for double Bearer (Bearer Bearer xyz → "Bearer xyz")', () => {
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: 'Bearer Bearer xyz' },
    });
    expect(extractAccessToken(req)).toBe('Bearer xyz');
  });

  it('preserves tokens that start with "=" or contain punctuation', () => {
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: 'Bearer =syt_punct.!@#$' },
    });
    expect(extractAccessToken(req)).toBe('=syt_punct.!@#$');
  });

  it('preserves Latin-1 Bearer tokens (Fetch Headers are ByteString, not UTF-16)', () => {
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: 'Bearer tok_ünîcode_ÿ' },
    });
    expect(extractAccessToken(req)).toBe('tok_ünîcode_ÿ');
  });

  it('preserves a very long Bearer token without truncation', () => {
    const long = `syt_${'a'.repeat(8192)}`;
    const req = new Request('https://matrix.example.com/', {
      headers: { Authorization: `Bearer ${long}` },
    });
    expect(extractAccessToken(req)).toBe(long);
    expect(extractAccessToken(req)!.length).toBe(8196);
  });

  it('reads access_token amid unrelated query params and keeps first duplicate', () => {
    const req = new Request(
      'https://matrix.example.com/_matrix/client/v3/sync?foo=1&access_token=keep&bar=2&access_token=drop'
    );
    expect(extractAccessToken(req)).toBe('keep');
  });

  it('Authorization header name is case-insensitive via Fetch Headers', () => {
    const headers = new Headers();
    headers.set('authorization', 'Bearer lower_key');
    const req = new Request('https://matrix.example.com/', { headers });
    expect(extractAccessToken(req)).toBe('lower_key');
  });

  it('falls through to query when Bearer scheme has no token capture group', () => {
    const bare = new Request('https://matrix.example.com/?access_token=q_only', {
      headers: { Authorization: 'Bearer' },
    });
    expect(extractAccessToken(bare)).toBe('q_only');

    const spaces = new Request('https://matrix.example.com/?access_token=q_spaces', {
      headers: { Authorization: 'Bearer   ' },
    });
    expect(extractAccessToken(spaces)).toBe('q_spaces');
  });

  it('ignores URL fragments (not part of request URL searchParams)', () => {
    const req = new Request('https://matrix.example.com/?access_token=real#access_token=frag');
    expect(extractAccessToken(req)).toBe('real');
  });

  it('is stable under Promise.all of identical Requests', async () => {
    const url = 'https://matrix.example.com/?access_token=stable';
    const headerReq = new Request('https://matrix.example.com/?access_token=q', {
      headers: { Authorization: 'Bearer hdr' },
    });
    const [a, b, c, d] = await Promise.all([
      Promise.resolve(extractAccessToken(new Request(url))),
      Promise.resolve(extractAccessToken(new Request(url))),
      Promise.resolve(extractAccessToken(headerReq)),
      Promise.resolve(extractAccessToken(headerReq)),
    ]);
    expect(a).toBe('stable');
    expect(b).toBe('stable');
    expect(c).toBe('hdr');
    expect(d).toBe('hdr');
  });

  it('Digest / Token / MAC schemes do not match; query wins when present', () => {
    for (const scheme of ['Digest abc', 'Token xyz', 'MAC id="1"']) {
      const req = new Request('https://matrix.example.com/?access_token=from_q', {
        headers: { Authorization: scheme },
      });
      expect(extractAccessToken(req)).toBe('from_q');
    }
  });

  it('returns null for Digest/Token/MAC when no query token exists', () => {
    for (const scheme of ['Digest abc', 'Token xyz', 'MAC id="1"']) {
      const req = new Request('https://matrix.example.com/', {
        headers: { Authorization: scheme },
      });
      expect(extractAccessToken(req)).toBeNull();
    }
  });

  it('decodes percent-encoded unicode in access_token query values', () => {
    // "café" as UTF-8 percent-encoding
    const req = new Request('https://matrix.example.com/?access_token=caf%C3%A9');
    expect(extractAccessToken(req)).toBe('café');
  });

  it('Bearer token may itself contain the substring access_token=', () => {
    const req = new Request('https://matrix.example.com/?access_token=query', {
      headers: { Authorization: 'Bearer prefix_access_token=embedded' },
    });
    expect(extractAccessToken(req)).toBe('prefix_access_token=embedded');
  });

  it('query-only path does not invent a token from path segments named access_token', () => {
    const req = new Request('https://matrix.example.com/access_token/syt_path_only');
    expect(extractAccessToken(req)).toBeNull();
  });

  it('mixed parallel header∥query∥missing resolutions stay isolated', async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => {
        const kind = i % 3;
        if (kind === 0) {
          return extractAccessToken(
            new Request('https://matrix.example.com/', {
              headers: { Authorization: `Bearer h_${i}` },
            })
          );
        }
        if (kind === 1) {
          return extractAccessToken(
            new Request(`https://matrix.example.com/?access_token=q_${i}`)
          );
        }
        return extractAccessToken(new Request('https://matrix.example.com/'));
      })
    );
    for (let i = 0; i < results.length; i++) {
      const kind = i % 3;
      if (kind === 0) expect(results[i]).toBe(`h_${i}`);
      else if (kind === 1) expect(results[i]).toBe(`q_${i}`);
      else expect(results[i]).toBeNull();
    }
  });
});
