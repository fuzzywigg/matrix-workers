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
});
