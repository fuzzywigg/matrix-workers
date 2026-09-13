import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  timingSafeEqual,
  validatePasswordStrength,
  hashPassword,
  verifyPassword,
  sha256,
  hashToken,
  generateRandomString,
  calculateContentHash,
  verifyContentHash,
} from '../src/utils/crypto';

describe('canonicalJson', () => {
  it('sorts object keys and nests recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('encodes primitives and arrays', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });
});

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for unequal strings or lengths', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
  });
});

describe('validatePasswordStrength', () => {
  it('accepts passwords with letters and numbers/symbols', () => {
    expect(validatePasswordStrength('password1')).toBeNull();
    expect(validatePasswordStrength('Secret!!')).toBeNull();
  });

  it('rejects short, letter-only, or digit-only passwords', () => {
    expect(validatePasswordStrength('short1')).toMatch(/at least 8/);
    expect(validatePasswordStrength('password')).toMatch(/number or special/);
    expect(validatePasswordStrength('12345678')).toMatch(/letter/);
  });
});

describe('password hashing', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('correct-horse-1');
    expect(hash).toMatch(/^\$pbkdf2-sha256\$100000\$/);
    expect(await verifyPassword('correct-horse-1', hash)).toBe(true);
    expect(await verifyPassword('wrong-password-1', hash)).toBe(false);
  });

  it('rejects malformed or weakened stored hashes', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', '$pbkdf2-sha256$1000$c2FsdA==$aGFzaA==')).toBe(false);
  });
});

describe('sha256 / content hash', () => {
  it('hashes tokens deterministically', async () => {
    const a = await hashToken('syt_token');
    const b = await sha256('syt_token');
    expect(a).toBe(b);
    expect(a).not.toMatch(/[+/=]/);
  });

  it('calculates and verifies PDU content hashes ignoring signatures', async () => {
    const content = {
      type: 'm.room.message',
      content: { body: 'hi' },
      signatures: { 'example.com': { 'ed25519:1': 'sig' } },
      unsigned: { age: 1 },
    };
    const hash = await calculateContentHash(content);
    expect(await verifyContentHash(content, hash)).toBe(true);
    expect(await verifyContentHash({ ...content, content: { body: 'nope' } }, hash)).toBe(false);
  });
});

describe('generateRandomString', () => {
  it('returns the requested length from the alphabet', () => {
    const s = generateRandomString(48);
    expect(s).toHaveLength(48);
    expect(s).toMatch(/^[A-Za-z0-9]+$/);
  });
});
