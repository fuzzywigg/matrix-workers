import { describe, it, expect } from 'vitest';
import {
  formatUserId,
  parseUserId,
  parseRoomId,
  formatRoomAlias,
  parseRoomAlias,
  isValidLocalpart,
  isValidServerName,
  isLocalServerName,
  getServerName,
  base64UrlEncode,
  base64UrlDecode,
  generateOpaqueId,
  generateAccessToken,
  generateRefreshToken,
  generateLoginToken,
  generateDeterministicEventId,
  generateEventId,
  generateRoomId,
  generateDeviceId,
  generateTransactionId,
  generateLegacyEventId,
} from '../src/utils/ids';

describe('format/parse Matrix IDs', () => {
  it('formats and parses user IDs', () => {
    const id = formatUserId('alice', 'matrix.example.com');
    expect(id).toBe('@alice:matrix.example.com');
    expect(parseUserId(id)).toEqual({ localpart: 'alice', serverName: 'matrix.example.com' });
  });

  it('rejects malformed user IDs', () => {
    expect(parseUserId('alice:example.com' as '@alice:example.com')).toBeNull();
    expect(parseUserId('@alice' as '@alice:example.com')).toBeNull();
  });

  it('parses room IDs', () => {
    expect(parseRoomId('!opaque:matrix.example.com')).toEqual({
      opaque: 'opaque',
      serverName: 'matrix.example.com',
    });
    expect(parseRoomId('@not-a-room:example.com' as '!x:example.com')).toBeNull();
  });

  it('formats and parses room aliases', () => {
    const alias = formatRoomAlias('general', 'matrix.example.com');
    expect(alias).toBe('#general:matrix.example.com');
    expect(parseRoomAlias(alias)).toEqual({
      localpart: 'general',
      serverName: 'matrix.example.com',
    });
  });

  it('extracts server names from Matrix IDs', () => {
    expect(getServerName('@alice:matrix.example.com')).toBe('matrix.example.com');
    expect(getServerName('!room:matrix.example.com')).toBe('matrix.example.com');
    expect(getServerName('no-colon')).toBeNull();
  });
});

describe('localpart and server name validation', () => {
  it('accepts valid localparts', () => {
    expect(isValidLocalpart('alice')).toBe(true);
    expect(isValidLocalpart('alice.bob_1=/-')).toBe(true);
  });

  it('rejects invalid localparts', () => {
    expect(isValidLocalpart('')).toBe(false);
    expect(isValidLocalpart('Alice')).toBe(false);
    expect(isValidLocalpart('alice!')).toBe(false);
    expect(isValidLocalpart('a'.repeat(256))).toBe(false);
  });

  it('accepts domains, ports, and IPs', () => {
    expect(isValidServerName('matrix.fuzzywigg.com')).toBe(true);
    expect(isValidServerName('localhost:8448')).toBe(true);
    expect(isValidServerName('127.0.0.1:8448')).toBe(true);
    expect(isValidServerName('[::1]:8448')).toBe(true);
  });

  it('rejects empty or oversized server names', () => {
    expect(isValidServerName('')).toBe(false);
    expect(isValidServerName('a'.repeat(256))).toBe(false);
  });

  it('compares local server names case-insensitively', () => {
    expect(isLocalServerName('Matrix.Example.COM', 'matrix.example.com')).toBe(true);
    expect(isLocalServerName('other.example.com', 'matrix.example.com')).toBe(false);
  });
});

describe('base64url and token generation', () => {
  it('round-trips bytes through base64url', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(encoded))).toEqual(Array.from(bytes));
  });

  it('generates opaque IDs of expected length', async () => {
    const id = await generateOpaqueId(18);
    expect(id.length).toBeGreaterThan(10);
    expect(id).not.toMatch(/[+/=]/);
  });

  it('prefixes access/refresh/login tokens', async () => {
    expect(await generateAccessToken()).toMatch(/^syt_/);
    expect(await generateRefreshToken()).toMatch(/^syr_/);
    expect(await generateLoginToken()).toMatch(/^mlt_/);
  });

  it('generates room and device IDs in Matrix shape', async () => {
    const roomId = await generateRoomId('matrix.example.com');
    expect(roomId).toMatch(/^![A-Za-z0-9_-]+:matrix\.example\.com$/);
    const deviceId = await generateDeviceId();
    expect(deviceId).toBe(deviceId.toUpperCase());
  });
});

describe('event ID formats', () => {
  it('uses domain-suffixed IDs for room versions 1-2', async () => {
    const id = await generateEventId('matrix.example.com', '1');
    expect(id).toMatch(/^\$[^:]+:matrix\.example\.com$/);
  });

  it('uses bare $opaque IDs for room versions 3+', async () => {
    const id = await generateEventId('matrix.example.com', '10');
    expect(id).toMatch(/^\$[A-Za-z0-9_-]+$/);
    expect(id.includes(':')).toBe(false);
  });

  it('makes deterministic event IDs stable within a bucket', async () => {
    const ts = 1_700_000_000_000;
    const a = await generateDeterministicEventId(
      'matrix.example.com',
      '!room:matrix.example.com',
      '@alice:matrix.example.com',
      'join',
      ts,
      1,
      '10'
    );
    const b = await generateDeterministicEventId(
      'matrix.example.com',
      '!room:matrix.example.com',
      '@alice:matrix.example.com',
      'join',
      ts + 200,
      1,
      '10'
    );
    const c = await generateDeterministicEventId(
      'matrix.example.com',
      '!room:matrix.example.com',
      '@alice:matrix.example.com',
      'join',
      ts + 1500,
      1,
      '10'
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('generates legacy domain-suffixed event IDs and transaction IDs', async () => {
    const legacy = await generateLegacyEventId('matrix.example.com');
    expect(legacy).toMatch(/^\$[^:]+:matrix\.example\.com$/);
    const txn = await generateTransactionId();
    expect(txn.length).toBeGreaterThan(10);
    expect(txn).not.toMatch(/[+/=]/);
  });

  it('defaults generateEventId to modern bare $opaque format', async () => {
    const id = await generateEventId('matrix.example.com');
    expect(id).toMatch(/^\$[A-Za-z0-9_-]+$/);
  });
});

describe('getServerName edge cases', () => {
  it('handles aliases and event IDs', () => {
    expect(getServerName('#general:matrix.example.com')).toBe('matrix.example.com');
    expect(getServerName('$evt:matrix.example.com')).toBe('matrix.example.com');
  });

  it('returns only the final colon segment (port when present)', () => {
    // Current regex :([^:]+)$ — host:port IDs yield the port alone
    expect(getServerName('@user:matrix.example.com:8448')).toBe('8448');
  });
});

describe('ID parse failure edges', () => {
  it('rejects empty and prefix-only Matrix IDs', () => {
    expect(parseUserId('@:' as '@x:y')).toBeNull();
    expect(parseRoomId('!:' as '!x:y')).toBeNull();
    expect(parseRoomAlias('#:' as '#x:y')).toBeNull();
  });

  it('rejects localparts with uppercase or disallowed punctuation', () => {
    expect(isValidLocalpart('Alice-Bob')).toBe(false);
    expect(isValidLocalpart('alice+bob')).toBe(false);
  });

  it('rejects server names with spaces or scheme prefixes', () => {
    expect(isValidServerName('example .com')).toBe(false);
    expect(isValidServerName('https://example.com')).toBe(false);
  });
});


describe('ids TOKENMAXX edge paths after #49', () => {
  it('uses domain-suffixed deterministic IDs for room version 1', async () => {
    const id = await generateDeterministicEventId(
      'matrix.example.com',
      '!room:matrix.example.com',
      '@alice:matrix.example.com',
      'join',
      1_700_000_000_000,
      1,
      '1'
    );
    expect(id).toMatch(/^\$[^:]+:matrix\.example\.com$/);
  });

  it('accepts localparts at the 255-char upper boundary', () => {
    expect(isValidLocalpart('a'.repeat(255))).toBe(true);
    expect(isValidLocalpart('a'.repeat(256))).toBe(false);
  });

  it('parses user IDs whose server name includes a port', () => {
    expect(parseUserId('@alice:example.com:8448' as '@alice:example.com')).toEqual({
      localpart: 'alice',
      serverName: 'example.com:8448',
    });
  });
});

describe('ids TOKENMAXX edge paths after #50', () => {
  it('returns null from getServerName for modern opaque event IDs', () => {
    expect(getServerName('$opaqueOnly')).toBeNull();
  });

  it('uses bare deterministic IDs for unsupported room versions (v4 fallback)', async () => {
    const id = await generateDeterministicEventId(
      'matrix.example.com',
      '!room:matrix.example.com',
      '@alice:matrix.example.com',
      'join',
      1_700_000_000_000,
      1,
      '99'
    );
    expect(id).toMatch(/^\$[^:]+$/);
  });

  it('allows = and / in localparts', () => {
    expect(isValidLocalpart('alice=bob')).toBe(true);
    expect(isValidLocalpart('alice/bob')).toBe(true);
  });

  it('parses room IDs whose server name includes a port', () => {
    expect(parseRoomId('!opaque:host:8448' as '!opaque:host')).toEqual({
      opaque: 'opaque',
      serverName: 'host:8448',
    });
  });
});


describe('ids TOKENMAXX edge paths after #52', () => {
  it('accepts localhost / private IPs / single-label hosts (no SSRF — contrast federation)', () => {
    expect(isValidServerName('localhost')).toBe(true);
    expect(isValidServerName('10.0.0.1')).toBe(true);
    expect(isValidServerName('matrix')).toBe(true);
  });

  it('rejects trailing-hyphen labels and underscore hosts', () => {
    expect(isValidServerName('bad-.example.com')).toBe(false);
    expect(isValidServerName('-bad.example.com')).toBe(false);
    expect(isValidServerName('bad_host.example.com')).toBe(false);
  });

  it('parses room aliases whose server name includes a port', () => {
    expect(parseRoomAlias('#a:host:8448' as '#a:host')).toEqual({
      localpart: 'a',
      serverName: 'host:8448',
    });
  });

  it('round-trips empty Uint8Array and empty string through base64url', () => {
    expect(base64UrlEncode(new Uint8Array())).toBe('');
    expect(Array.from(base64UrlDecode(''))).toEqual([]);
  });

  it('defaults generateOpaqueId to ~24 chars for 18 random bytes', async () => {
    const id = await generateOpaqueId();
    expect(id.length).toBeGreaterThanOrEqual(20);
    expect(id.length).toBeLessThanOrEqual(28);
    expect(id).not.toMatch(/[+/=]/);
  });

  it('treats empty local server names as equal under isLocalServerName', () => {
    expect(isLocalServerName('', '')).toBe(true);
    expect(isLocalServerName('', 'example.com')).toBe(false);
  });
});
