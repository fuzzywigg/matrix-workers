/**
 * TOKENMAXX HEAVY deepen after #102/#103 — different slice: oauth helpers (+ HTML generators).
 * Orthogonal to merged #90 (oauth routes), #100 (devices/aliases), #93/#96 (key-backups), #94 (search).
 * Export-only src changes for testability; no product inventing / creds / DNS.
 */
import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  escapeHtml,
  generateLoginPage,
  generateRandomString,
  generateUiaApprovalPage,
  generateUiaCancelledPage,
  generateUiaErrorPage,
  generateUiaSuccessPage,
  hashClientSecret,
  verifyCodeChallenge,
} from '../src/api/oauth';

// ---------------------------------------------------------------------------
// generateRandomString
// ---------------------------------------------------------------------------

describe('generateRandomString', () => {
  it('defaults to 32 bytes → 64 hex chars', () => {
    const s = generateRandomString();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(s.length).toBe(64);
  });

  it('honors custom byte lengths (output length = 2× bytes)', () => {
    expect(generateRandomString(1)).toMatch(/^[0-9a-f]{2}$/);
    expect(generateRandomString(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(generateRandomString(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(generateRandomString(0)).toBe('');
  });

  it('pads single-nibble bytes to two hex digits', () => {
    // Statistical: many samples must only contain 0-9a-f and even length.
    for (let i = 0; i < 50; i++) {
      const s = generateRandomString(4);
      expect(s.length).toBe(8);
      expect(s).toMatch(/^[0-9a-f]+$/);
    }
  });

  it('produces unique values across calls (collision resistance smoke)', () => {
    const set = new Set(Array.from({ length: 40 }, () => generateRandomString(16)));
    expect(set.size).toBe(40);
  });

  it('never emits uppercase A-F or non-hex punctuation', () => {
    const joined = Array.from({ length: 20 }, () => generateRandomString(32)).join('');
    expect(joined).not.toMatch(/[^0-9a-f]/);
    expect(joined).not.toMatch(/[A-F]/);
  });
});

// ---------------------------------------------------------------------------
// base64UrlEncode / base64UrlDecode
// ---------------------------------------------------------------------------

describe('base64UrlEncode / base64UrlDecode', () => {
  it('round-trips empty and single-byte inputs', () => {
    expect(Array.from(base64UrlDecode(base64UrlEncode(new Uint8Array([]))))).toEqual([]);
    expect(Array.from(base64UrlDecode(base64UrlEncode(new Uint8Array([0]))))).toEqual([0]);
    expect(Array.from(base64UrlDecode(base64UrlEncode(new Uint8Array([255]))))).toEqual([255]);
  });

  it('round-trips arbitrary byte sequences including +/ prone values', () => {
    const samples = [
      new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]),
      new Uint8Array(Array.from({ length: 64 }, (_, i) => i)),
      new TextEncoder().encode('hello world'),
      new TextEncoder().encode('{"alg":"none","typ":"JWT"}'),
      new TextEncoder().encode('subjects with spaces & punctuation!'),
    ];
    for (const bytes of samples) {
      const enc = base64UrlEncode(bytes);
      expect(enc).not.toMatch(/[+/=]/);
      expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(bytes));
    }
  });

  it('uses URL-safe alphabet (- and _) instead of + and /', () => {
    // Bytes that commonly produce +/ in standard base64
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0xff, 0xfe]);
    const enc = base64UrlEncode(bytes);
    expect(enc).not.toContain('+');
    expect(enc).not.toContain('/');
    expect(enc).not.toContain('=');
    // Must still decode
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(bytes));
  });

  it('strips trailing = padding from encoded form', () => {
    // 1 byte → standard base64 has == padding; 2 bytes → =
    expect(base64UrlEncode(new Uint8Array([1]))).not.toMatch(/=/);
    expect(base64UrlEncode(new Uint8Array([1, 2]))).not.toMatch(/=/);
    expect(base64UrlEncode(new Uint8Array([1, 2, 3]))).not.toMatch(/=/);
  });

  it('accepts unpadded and padded decode inputs interchangeably', () => {
    const bytes = new TextEncoder().encode('abc');
    const unpadded = base64UrlEncode(bytes);
    // Reconstruct standard padded base64url by adding =
    const need = (4 - (unpadded.length % 4)) % 4;
    const padded = unpadded + '='.repeat(need);
    expect(Array.from(base64UrlDecode(unpadded))).toEqual(Array.from(bytes));
    expect(Array.from(base64UrlDecode(padded))).toEqual(Array.from(bytes));
  });

  it('maps -/_ back to +/ during decode', () => {
    // Manually craft a string that uses URL-safe chars
    const std = btoa(String.fromCharCode(0xfb, 0xff)); // typically contains + or /
    const url = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const decoded = base64UrlDecode(url);
    expect(decoded.length).toBeGreaterThan(0);
    expect(base64UrlEncode(decoded)).toBe(url);
  });

  it('round-trips UTF-8 multi-byte text via TextEncoder/Decoder', () => {
    const text = 'café 日本語 🔐 edge';
    const enc = base64UrlEncode(new TextEncoder().encode(text));
    expect(new TextDecoder().decode(base64UrlDecode(enc))).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// verifyCodeChallenge (PKCE)
// ---------------------------------------------------------------------------

describe('verifyCodeChallenge', () => {
  it('plain: exact string match succeeds', async () => {
    expect(await verifyCodeChallenge('abc', 'abc', 'plain')).toBe(true);
    expect(await verifyCodeChallenge('', '', 'plain')).toBe(true);
  });

  it('plain: mismatch / case / whitespace fails', async () => {
    expect(await verifyCodeChallenge('abc', 'ABC', 'plain')).toBe(false);
    expect(await verifyCodeChallenge('abc', 'abc ', 'plain')).toBe(false);
    expect(await verifyCodeChallenge('abc', 'abcd', 'plain')).toBe(false);
    expect(await verifyCodeChallenge('verifier', 'challenge', 'plain')).toBe(false);
  });

  it('S256: accepts SHA-256(base64url) of verifier', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(verifier, challenge, 'S256')).toBe(true);
  });

  it('S256: rejects wrong verifier or wrong challenge', async () => {
    const verifier = 'correct-verifier-value-0123456789abcdef';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge('wrong-verifier', challenge, 'S256')).toBe(false);
    expect(await verifyCodeChallenge(verifier, challenge + 'x', 'S256')).toBe(false);
    expect(await verifyCodeChallenge(verifier, challenge.toUpperCase(), 'S256')).toBe(false);
  });

  it('S256: does not treat plain equality as success', async () => {
    const v = 'same-string';
    expect(await verifyCodeChallenge(v, v, 'S256')).toBe(false);
  });

  it('unknown / empty / wrong-case methods return false', async () => {
    expect(await verifyCodeChallenge('a', 'a', 'PLAIN')).toBe(false);
    expect(await verifyCodeChallenge('a', 'a', 's256')).toBe(false);
    expect(await verifyCodeChallenge('a', 'a', '')).toBe(false);
    expect(await verifyCodeChallenge('a', 'a', 'S512')).toBe(false);
    expect(await verifyCodeChallenge('a', 'a', 'none')).toBe(false);
  });

  it('S256 challenge is stable for a fixed verifier', async () => {
    const verifier = 'stable-pkce-verifier-aaaaaaaaaaaaaaaa';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(verifier, challenge, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(verifier, challenge, 'S256')).toBe(true);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).not.toMatch(/[=+/]/);
  });
});

// ---------------------------------------------------------------------------
// hashClientSecret
// ---------------------------------------------------------------------------

describe('hashClientSecret', () => {
  it('is deterministic for the same secret', async () => {
    const a = await hashClientSecret('super-secret');
    const b = await hashClientSecret('super-secret');
    expect(a).toBe(b);
  });

  it('differs across distinct secrets (including empty vs whitespace)', async () => {
    const a = await hashClientSecret('a');
    const b = await hashClientSecret('b');
    const empty = await hashClientSecret('');
    const space = await hashClientSecret(' ');
    expect(a).not.toBe(b);
    expect(empty).not.toBe(space);
    expect(empty).not.toBe(a);
  });

  it('returns unpadded base64url of SHA-256', async () => {
    const hashed = await hashClientSecret('client-secret-value');
    expect(hashed).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(hashed).not.toMatch(/[=+/]/);
    // Length of SHA-256 digest base64url is 43 chars (32 bytes → 43 unpadded)
    expect(hashed.length).toBe(43);

    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('client-secret-value')
    );
    expect(hashed).toBe(base64UrlEncode(new Uint8Array(digest)));
  });

  it('hashes unicode secrets without throwing', async () => {
    const h = await hashClientSecret('пароль-🔐');
    expect(h.length).toBe(43);
    expect(await hashClientSecret('пароль-🔐')).toBe(h);
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes the five HTML-sensitive characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#039;');
  });

  it('escapes ampersand first so existing entities are double-escaped', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves safe alphanumeric / punctuation unchanged', () => {
    expect(escapeHtml('Alice Device-1_ok.xyz')).toBe('Alice Device-1_ok.xyz');
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(' ')).toBe(' ');
  });

  it('neutralizes common XSS / attribute breakout payloads', () => {
    expect(escapeHtml(`<script>alert(1)</script>`)).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    );
    expect(escapeHtml(`" onmouseover="alert(1)`)).toBe(
      '&quot; onmouseover=&quot;alert(1)'
    );
    expect(escapeHtml(`' onfocus='alert(1)`)).toBe(`&#039; onfocus=&#039;alert(1)`);
    expect(escapeHtml(`foo & bar <baz>`)).toBe('foo &amp; bar &lt;baz&gt;');
  });

  it('escapes every occurrence (global replace)', () => {
    expect(escapeHtml('<<<<')).toBe('&lt;&lt;&lt;&lt;');
    expect(escapeHtml('&&&&')).toBe('&amp;&amp;&amp;&amp;');
    expect(escapeHtml(`""""`)).toBe('&quot;&quot;&quot;&quot;');
    expect(escapeHtml(`''''`)).toBe('&#039;&#039;&#039;&#039;');
  });

  it('handles mixed unicode + HTML metacharacters', () => {
    expect(escapeHtml('日本語 <tag> & "x"')).toBe(
      '日本語 &lt;tag&gt; &amp; &quot;x&quot;'
    );
  });
});

// ---------------------------------------------------------------------------
// generateLoginPage
// ---------------------------------------------------------------------------

describe('generateLoginPage', () => {
  it('renders sign-in chrome with escaped client / server / request id', () => {
    const html = generateLoginPage('Element Web', 'req-abc', 'example.com');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Sign in');
    expect(html).toContain('to continue to');
    expect(html).toContain('<span class="client-name">Element Web</span>');
    expect(html).toContain('value="req-abc"');
    expect(html).toContain('<span class="server-name">example.com</span>');
    expect(html).toContain('action="/oauth/authorize"');
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
    expect(html).not.toContain('class="error"');
  });

  it('includes escaped error banner when error is provided', () => {
    const html = generateLoginPage('C', 'id', 'srv', 'Invalid credentials');
    expect(html).toContain('<div class="error">Invalid credentials</div>');
  });

  it('omits error banner when error is undefined / empty-ish path uses only truthy', () => {
    expect(generateLoginPage('C', 'id', 'srv')).not.toContain('class="error"');
    // Empty string is falsy → no error div
    expect(generateLoginPage('C', 'id', 'srv', '')).not.toContain('class="error"');
  });

  it('HTML-escapes XSS in clientName, authRequestId, serverName, and error', () => {
    const html = generateLoginPage(
      `<img src=x onerror=alert(1)>`,
      `"/><script>alert(2)</script>`,
      `evil.com"><script>`,
      `<b>bad</b> & "quoted"`
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;/&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(html).toContain('evil.com&quot;&gt;&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;bad&lt;/b&gt; &amp; &quot;quoted&quot;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(2)</script>');
  });

  it('keeps title using raw serverName interpolation (document existing behavior)', () => {
    // Product interpolates serverName into <title> without escapeHtml — lock current behavior.
    const html = generateLoginPage('C', 'id', 'matrix.example.com');
    expect(html).toContain('<title>Sign in - matrix.example.com</title>');
  });
});

// ---------------------------------------------------------------------------
// generateUiaApprovalPage
// ---------------------------------------------------------------------------

describe('generateUiaApprovalPage', () => {
  it('renders title, description, account, session, and localpart username default', () => {
    const html = generateUiaApprovalPage(
      'sess-1',
      '@alice:example.com',
      'Reset Encryption Keys',
      'Reset your identity.',
      'example.com'
    );
    expect(html).toContain('<h1>Reset Encryption Keys</h1>');
    expect(html).toContain('Reset your identity.');
    expect(html).toContain('Approving as: <strong>@alice:example.com</strong>');
    expect(html).toContain('value="sess-1"');
    expect(html).toContain('value="alice"'); // localpart from @alice:server
    expect(html).toContain('action="/oauth/authorize/uia"');
    expect(html).toContain('value="cancel"');
    expect(html).toContain('value="approve"');
    expect(html).not.toContain('class="error"');
  });

  it('extracts localpart via split/substring even for odd user ids', () => {
    const html = generateUiaApprovalPage(
      's',
      '@bob.with.dots:matrix.example.com',
      'T',
      'D',
      'matrix.example.com'
    );
    expect(html).toContain('value="bob.with.dots"');
  });

  it('includes escaped error when provided', () => {
    const html = generateUiaApprovalPage(
      's',
      '@a:ex.com',
      'T',
      'D',
      'ex.com',
      'Wrong password'
    );
    expect(html).toContain('<div class="error">Wrong password</div>');
  });

  it('escapes XSS across sessionId, userId, title, description, serverName, error', () => {
    const html = generateUiaApprovalPage(
      `<script>s</script>`,
      `@x<script>:evil.com`,
      `<img src=x>`,
      `desc<script>`,
      `srv"><b>`,
      `"onerror='x'`
    );
    expect(html).toContain('&lt;script&gt;s&lt;/script&gt;');
    expect(html).toContain('@x&lt;script&gt;:evil.com');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('desc&lt;script&gt;');
    expect(html).toContain('srv&quot;&gt;&lt;b&gt;');
    expect(html).toContain('&quot;onerror=&#039;x&#039;');
    expect(html).not.toMatch(/<script>s<\/script>/);
  });

  it('escapes title/serverName inside <title> as well as body', () => {
    const html = generateUiaApprovalPage('s', '@a:ex.com', 'A & B', 'D', 'ex.com');
    expect(html).toContain('<title>A &amp; B - ex.com</title>');
  });
});

// ---------------------------------------------------------------------------
// generateUiaSuccessPage / cancelled / error
// ---------------------------------------------------------------------------

describe('generateUiaSuccessPage', () => {
  it('renders approved chrome with escaped session and server', () => {
    const html = generateUiaSuccessPage('sess-xyz', 'example.com');
    expect(html).toContain('Request Approved');
    expect(html).toContain('Session: sess-xyz');
    expect(html).toContain('<title>Approved - example.com</title>');
    expect(html).toContain("type: 'uia_complete'");
    expect(html).toContain("session: 'sess-xyz'");
  });

  it('escapes XSS in sessionId and serverName (title + body + script literal)', () => {
    const html = generateUiaSuccessPage(`';alert(1)//`, `srv<script>`);
    expect(html).toContain('&#039;;alert(1)//');
    expect(html).toContain('srv&lt;script&gt;');
    expect(html).not.toContain(`';alert(1)//`);
  });
});

describe('generateUiaCancelledPage', () => {
  it('renders cancelled message and posts uia_cancelled', () => {
    const html = generateUiaCancelledPage('example.com');
    expect(html).toContain('Request Cancelled');
    expect(html).toContain('<title>Cancelled - example.com</title>');
    expect(html).toContain("type: 'uia_cancelled'");
  });

  it('escapes serverName in title', () => {
    const html = generateUiaCancelledPage(`x<script>`);
    expect(html).toContain('Cancelled - x&lt;script&gt;');
  });
});

describe('generateUiaErrorPage', () => {
  it('renders title and message with escaped fields', () => {
    const html = generateUiaErrorPage('Missing Session', 'No UIA session specified.', 'ex.com');
    expect(html).toContain('<h1>Missing Session</h1>');
    expect(html).toContain('<p>No UIA session specified.</p>');
    expect(html).toContain('<title>Missing Session - ex.com</title>');
  });

  it('escapes XSS in title, message, and serverName', () => {
    const html = generateUiaErrorPage(
      `<img src=x>`,
      `msg & <b>`,
      `"srv"`
    );
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('msg &amp; &lt;b&gt;');
    expect(html).toContain('&quot;srv&quot;');
    expect(html).toContain('<title>&lt;img src=x&gt; - &quot;srv&quot;</title>');
  });

  it('matches the missing/expired copy used by GET /oauth/authorize/uia', () => {
    expect(generateUiaErrorPage('Missing Session', 'No UIA session specified.', 's')).toContain(
      'No UIA session specified.'
    );
    expect(
      generateUiaErrorPage(
        'Session Expired',
        'This session has expired. Please try again.',
        's'
      )
    ).toContain('This session has expired. Please try again.');
  });
});

// ---------------------------------------------------------------------------
// Cross-helper invariants
// ---------------------------------------------------------------------------

describe('oauth helper invariants', () => {
  it('hashClientSecret output verifies as itself via timing-safe length parity', async () => {
    const h = await hashClientSecret('x');
    expect(h.length).toBe((await hashClientSecret('y')).length);
  });

  it('PKCE S256 challenge never equals plain verifier for long random verifiers', async () => {
    for (const v of [
      generateRandomString(32),
      generateRandomString(48),
      'a'.repeat(64),
    ]) {
      expect(await verifyCodeChallenge(v, v, 'S256')).toBe(false);
    }
  });

  it('login + UIA pages always POST to expected oauth paths', () => {
    expect(generateLoginPage('c', 'r', 's')).toContain('action="/oauth/authorize"');
    expect(generateUiaApprovalPage('sid', '@u:s', 't', 'd', 's')).toContain(
      'action="/oauth/authorize/uia"'
    );
  });

  it('escapeHtml is idempotent only after one pass for plain text, not for entities', () => {
    const plain = 'hello';
    expect(escapeHtml(escapeHtml(plain))).toBe(plain);
    const dirty = '<x>';
    expect(escapeHtml(escapeHtml(dirty))).toBe('&amp;lt;x&amp;gt;');
  });
});

// ---------------------------------------------------------------------------
// Additional HTML generator matrix (TOKENMAXX)
// ---------------------------------------------------------------------------

describe('generateLoginPage matrix', () => {
  it.each([
    ['Element', 'req1', 'a.example', undefined],
    ['C', 'r', 's', 'err'],
    ['', '', '', ''],
    ['Client & Co', 'id"x', 'srv', undefined],
  ] as const)('renders for client=%s request=%s server=%s', (client, req, srv, err) => {
    const html = generateLoginPage(client, req, srv, err);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
    expect(html).toContain('name="auth_request_id"');
    if (err) {
      expect(html).toContain('class="error"');
    }
  });

  it('embeds auth_request_id only inside the hidden input value attribute', () => {
    const html = generateLoginPage('C', 'unique-req-id-42', 's');
    expect(html).toMatch(/name="auth_request_id" value="unique-req-id-42"/);
  });
});

describe('generateUiaApprovalPage localpart extraction matrix', () => {
  it.each([
    ['@alice:example.com', 'alice'],
    ['@bob:matrix.org', 'bob'],
    ['@user_name:a.b.c', 'user_name'],
    ['@x:y', 'x'],
  ])('userId %s → username value %s', (userId, localpart) => {
    const html = generateUiaApprovalPage('s', userId, 'T', 'D', 'srv');
    expect(html).toContain(`value="${localpart}"`);
    expect(html).toContain(`<strong>${userId}</strong>`);
  });

  it('does not include error div when error argument is omitted', () => {
    const html = generateUiaApprovalPage('s', '@a:b', 'T', 'D', 'srv');
    expect(html).not.toMatch(/class="error"/);
  });

  it('includes both warning banner and optional error together', () => {
    const html = generateUiaApprovalPage('s', '@a:b', 'T', 'D', 'srv', 'Nope');
    expect(html).toContain('class="warning"');
    expect(html).toContain('<div class="error">Nope</div>');
  });
});

describe('generateUiaSuccessPage script payload', () => {
  it('embeds session into postMessage JSON-ish literal safely when session is alphanumeric', () => {
    const html = generateUiaSuccessPage('abc123', 'srv');
    expect(html).toContain("session: 'abc123'");
    expect(html).toContain("window.opener.postMessage");
    expect(html).toContain('window.close()');
  });

  it('escapes quote-bearing session ids inside the script string', () => {
    const html = generateUiaSuccessPage(`ab'cd`, 'srv');
    expect(html).toContain("session: 'ab&#039;cd'");
    expect(html).not.toContain("session: 'ab'cd'");
  });
});

describe('generateUiaCancelledPage / error page matrix', () => {
  it.each(['example.com', 'matrix.local', 'a&b', '<x>'])(
    'cancelled page titles include escaped server %s',
    (srv) => {
      const html = generateUiaCancelledPage(srv);
      expect(html).toContain(`Cancelled - ${escapeHtml(srv)}`);
      expect(html).toContain('uia_cancelled');
    }
  );

  it.each([
    ['Missing Session', 'No UIA session specified.'],
    ['Session Expired', 'This session has expired. Please try again.'],
    ['Invalid Request', 'Could not parse request.'],
  ])('error page %s / %s', (title, message) => {
    const html = generateUiaErrorPage(title, message, 'srv');
    expect(html).toContain(`<h1>${title}</h1>`);
    expect(html).toContain(`<p>${message}</p>`);
  });
});

describe('base64Url + PKCE RFC sample vector', () => {
  // RFC 7636 Appendix B
  it('matches RFC 7636 S256 example challenge for the documented verifier', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    expect(base64UrlEncode(new Uint8Array(hash))).toBe(expected);
    expect(await verifyCodeChallenge(verifier, expected, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(verifier + 'x', expected, 'S256')).toBe(false);
  });
});

describe('hashClientSecret avalanche', () => {
  it('single-bit-ish input changes flip the digest', async () => {
    const a = await hashClientSecret('secret0');
    const b = await hashClientSecret('secret1');
    expect(a).not.toBe(b);
    // Hamming distance over base64url alphabet should be high
    let diffs = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) diffs++;
    }
    expect(diffs).toBeGreaterThan(10);
  });
});

describe('generateRandomString statistical shape', () => {
  it('uses full hex alphabet over many samples', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      for (const ch of generateRandomString(32)) seen.add(ch);
    }
    for (const ch of '0123456789abcdef') {
      expect(seen.has(ch)).toBe(true);
    }
  });
});
