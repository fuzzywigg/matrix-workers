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

  it('returns empty string for zero length', () => {
    expect(generateRandomString(0)).toBe('');
  });
});

describe('canonicalJson arrays and nested sorting', () => {
  it('does not sort array element order', () => {
    expect(canonicalJson([{ b: 1, a: 2 }, { d: 3, c: 4 }])).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });

  it('encodes empty objects and arrays', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });
});

describe('sha256 bytes input', () => {
  it('hashes Uint8Array input', async () => {
    const fromString = await sha256('abc');
    const fromBytes = await sha256(new TextEncoder().encode('abc'));
    expect(fromBytes).toBe(fromString);
  });
});

describe('crypto failure / boundary edges', () => {
  it('treats empty strings as equal under timingSafeEqual', () => {
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('', 'a')).toBe(false);
  });

  it('rejects passwords that are only symbols without letters', () => {
    expect(validatePasswordStrength('!!!!!!!!')).toMatch(/letter/);
  });

  it('rejects content hash when signatures differ but body matches after strip', async () => {
    const a = {
      type: 'm.room.message',
      content: { body: 'hi' },
      signatures: { 'a.example.com': { 'ed25519:1': 'sig-a' } },
    };
    const hash = await calculateContentHash(a);
    const b = {
      ...a,
      signatures: { 'b.example.com': { 'ed25519:1': 'sig-b' } },
    };
    // signatures are ignored for content hash — should still verify
    expect(await verifyContentHash(b, hash)).toBe(true);
    expect(await verifyContentHash({ ...a, type: 'm.room.member' }, hash)).toBe(false);
  });
});


describe('crypto TOKENMAXX edge paths after #49', () => {
  it('rejects empty and overlong passwords', () => {
    expect(validatePasswordStrength('')).toMatch(/at least 8/);
    expect(validatePasswordStrength('a1' + 'x'.repeat(999))).toMatch(/at most 1000/);
    expect(validatePasswordStrength('a1' + 'x'.repeat(998))).toBeNull(); // length 1000
  });

  it('encodes undefined as null in canonicalJson', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('crypto TOKENMAXX edge paths after #50', () => {
  it('rejects verifyPassword when iterations exceed 2000000', async () => {
    // Format: $pbkdf2-sha256$iterations$salt$hash — iterations parse before crypto work
    expect(await verifyPassword('password1', '$pbkdf2-sha256$2000001$c2FsdA$hash')).toBe(false);
  });

  it('rejects malformed hashes with the wrong number of $-separated parts', async () => {
    expect(await verifyPassword('password1', '$pbkdf2-sha256$100000$onlythree')).toBe(false);
  });

  it('encodes nested null values in canonicalJson', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });
});
