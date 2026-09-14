import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
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
  generateSigningKeyPair,
  generateSigningKeyPairLegacy,
  signJson,
  verifySignature,
  base64UrlEncode,
  base64UrlDecode,
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


/** Remap Cloudflare's NODE-ED25519 algorithm name to Node's Ed25519 for unit tests. */
function installNodeEd25519Shim() {
  const subtle = crypto.subtle;
  const origGenerateKey = subtle.generateKey.bind(subtle);
  const origImportKey = subtle.importKey.bind(subtle);
  const origSign = subtle.sign.bind(subtle);
  const origVerify = subtle.verify.bind(subtle);

  const mapAlg = (alg: AlgorithmIdentifier | EcKeyGenParams | EcKeyImportParams | EcdsaParams | unknown): AlgorithmIdentifier => {
    if (typeof alg === 'string') {
      return alg === 'NODE-ED25519' ? 'Ed25519' : alg;
    }
    if (alg && typeof alg === 'object' && (alg as { name?: string }).name === 'NODE-ED25519') {
      return 'Ed25519';
    }
    return alg as AlgorithmIdentifier;
  };

  subtle.generateKey = ((alg: AlgorithmIdentifier, extractable: boolean, usages: KeyUsage[]) =>
    origGenerateKey(mapAlg(alg), extractable, usages)) as typeof subtle.generateKey;
  subtle.importKey = ((
    format: KeyFormat,
    keyData: BufferSource | JsonWebKey,
    alg: AlgorithmIdentifier,
    extractable: boolean,
    usages: KeyUsage[]
  ) => origImportKey(format, keyData, mapAlg(alg), extractable, usages)) as typeof subtle.importKey;
  subtle.sign = ((alg: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) =>
    origSign(mapAlg(alg), key, data)) as typeof subtle.sign;
  subtle.verify = ((
    alg: AlgorithmIdentifier,
    key: CryptoKey,
    signature: BufferSource,
    data: BufferSource
  ) => origVerify(mapAlg(alg), key, signature, data)) as typeof subtle.verify;

  return () => {
    subtle.generateKey = origGenerateKey;
    subtle.importKey = origImportKey;
    subtle.sign = origSign;
    subtle.verify = origVerify;
  };
}

describe('federation signing TOKENMAXX edge paths after #52', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('round-trips signJson → verifySignature and strips signatures/unsigned', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    expect(keyId).toMatch(/^ed25519:[0-9a-f]{8}$/);

    const obj = {
      type: 'm.room.message',
      content: { body: 'hi' },
      signatures: { 'other.example.com': { 'ed25519:old': 'keep-me' } },
      unsigned: { age: 1 },
    };
    const signed = await signJson(obj, 'matrix.example.com', keyId, privateKeyJwk);
    expect(signed.unsigned).toEqual({ age: 1 });
    expect((signed.signatures as Record<string, Record<string, string>>)['other.example.com']).toEqual({
      'ed25519:old': 'keep-me',
    });
    expect(await verifySignature(signed, 'matrix.example.com', keyId, publicKey)).toBe(true);
  });

  it('merges a second keyId under the same server without dropping the first', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const base = { type: 'm.test', content: {} };
    const once = await signJson(base, 'ex.com', a.keyId, a.privateKeyJwk);
    const twice = await signJson(once, 'ex.com', b.keyId, b.privateKeyJwk);
    const sigs = (twice.signatures as Record<string, Record<string, string>>)['ex.com'];
    expect(Object.keys(sigs).sort()).toEqual([a.keyId, b.keyId].sort());
    expect(await verifySignature(twice, 'ex.com', a.keyId, a.publicKey)).toBe(true);
    expect(await verifySignature(twice, 'ex.com', b.keyId, b.publicKey)).toBe(true);
  });

  it('accepts privateKeyJwk as a JSON string (legacy path)', async () => {
    const legacy = await generateSigningKeyPairLegacy();
    expect(() => JSON.parse(legacy.privateKey)).not.toThrow();
    const signed = await signJson({ type: 'm.test' }, 'ex.com', legacy.keyId, legacy.privateKey);
    expect(await verifySignature(signed, 'ex.com', legacy.keyId, legacy.publicKey)).toBe(true);
  });

  it('returns false for missing signature, wrong key, or tampered body', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson({ type: 'm.test', content: { n: 1 } }, 'ex.com', keyId, privateKeyJwk);
    expect(await verifySignature(signed, 'ex.com', 'ed25519:deadbeef', publicKey)).toBe(false);
    expect(await verifySignature({ type: 'm.test' }, 'ex.com', keyId, publicKey)).toBe(false);
    const tampered = { ...signed, content: { n: 2 } };
    expect(await verifySignature(tampered, 'ex.com', keyId, publicKey)).toBe(false);
  });
});

describe('crypto TOKENMAXX edge paths after #52', () => {
  it('rejects verifyPassword below 100000 iterations and wrong scheme', async () => {
    expect(await verifyPassword('password1', '$pbkdf2-sha256$99999$c2FsdA$hash')).toBe(false);
    expect(await verifyPassword('password1', '$pbkdf2-sha1$100000$c2FsdA$hash')).toBe(false);
  });

  it('accepts the 100000 iteration lower bound via a real hash', async () => {
    const hash = await hashPassword('bound-check-1');
    expect(hash).toMatch(/^\$pbkdf2-sha256\$100000\$/);
    expect(await verifyPassword('bound-check-1', hash)).toBe(true);
  });

  it('produces distinct salts across hashPassword calls', async () => {
    const a = await hashPassword('same-password-1');
    const b = await hashPassword('same-password-1');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-1', a)).toBe(true);
    expect(await verifyPassword('same-password-1', b)).toBe(true);
  });

  it('defaults generateRandomString length to 32', () => {
    expect(generateRandomString()).toHaveLength(32);
  });

  it('encodes NaN, Infinity, and -0 via JSON.stringify number path', () => {
    expect(canonicalJson(Number.NaN)).toBe('null');
    expect(canonicalJson(Number.POSITIVE_INFINITY)).toBe('null');
    expect(canonicalJson(-0)).toBe('0');
  });

  it('escapes unicode in canonicalJson strings', () => {
    expect(canonicalJson('café')).toBe('"café"');
    expect(canonicalJson({ '🔑': 1 })).toBe('{"🔑":1}');
  });
});


describe('crypto TOKENMAXX edge paths after #55', () => {
  it('encodes bigint as null (falls through typeof branches)', () => {
    expect(canonicalJson(1n)).toBe('null');
  });
});


describe('crypto TOKENMAXX edge paths after #57', () => {
  it('encodes functions as null via the final typeof fallthrough', () => {
    expect(canonicalJson(() => 1)).toBe('null');
    expect(canonicalJson(Symbol('x'))).toBe('null');
  });
});


describe('crypto TOKENMAXX leftovers after #226', () => {
  it('rejects verifyPassword when iteration field is non-numeric (NaN)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await verifyPassword('password1', '$pbkdf2-sha256$abc$c2FsdA$hash')).toBe(false);
    expect(await verifyPassword('password1', '$pbkdf2-sha256$$c2FsdA$hash')).toBe(false);
    expect(console.error).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('rejects verifyPassword when stored hash bytes mismatch after PBKDF2', async () => {
    const real = await hashPassword('match-me-1');
    // Keep scheme/iterations/salt; corrupt only the trailing hash segment
    const parts = real.split('$');
    parts[4] = parts[4] === 'AAAA' ? 'BBBB' : 'AAAA';
    expect(await verifyPassword('match-me-1', parts.join('$'))).toBe(false);
  });

  it('accepts passwords using every documented special-character class', () => {
    const specials = `!@#$%^&*()_+-=[]{};':"\\|,.<>/?`;
    for (const ch of specials) {
      expect(validatePasswordStrength(`abcdefg${ch}`)).toBeNull();
    }
  });

  it('hashes empty string / empty bytes deterministically via sha256', async () => {
    const emptyStr = await sha256('');
    const emptyBytes = await sha256(new Uint8Array());
    expect(emptyStr).toBe(emptyBytes);
    expect(emptyStr).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await hashToken('')).toBe(emptyStr);
  });

  it('timingSafeEqual is false for same-length strings differing only at the last char', () => {
    expect(timingSafeEqual('password', 'passwore')).toBe(false);
    expect(timingSafeEqual('aaaaaaaa', 'aaaaaaab')).toBe(false);
  });

  it('canonicalJson deep-nests arrays of nulls and sorts sibling keys', () => {
    expect(canonicalJson({ z: [null, { b: 1, a: null }], m: true })).toBe(
      '{"m":true,"z":[null,{"a":null,"b":1}]}'
    );
  });

  it('calculateContentHash strips unsigned-only objects the same as signatures', async () => {
    const base = { type: 'm.test', content: { n: 1 } };
    const withUnsigned = { ...base, unsigned: { age: 9 } };
    expect(await calculateContentHash(base)).toBe(await calculateContentHash(withUnsigned));
    expect(await verifyContentHash(withUnsigned, await calculateContentHash(base))).toBe(true);
  });

  it('generateRandomString(1) stays in alphabet and length-64 samples stay unique', () => {
    expect(generateRandomString(1)).toMatch(/^[A-Za-z0-9]$/);
    const samples = new Set(Array.from({ length: 8 }, () => generateRandomString(64)));
    expect(samples.size).toBe(8);
  });

  it('re-exports base64UrlEncode/Decode and round-trips signing material bytes', () => {
    const bytes = new Uint8Array([0, 1, 255, 128, 64]);
    const enc = base64UrlEncode(bytes);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(bytes));
  });
});

describe('federation signing TOKENMAXX leftovers after #226', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('signJson creates a signatures map when the object had none', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson({ type: 'm.test', content: {} }, 'ex.com', keyId, privateKeyJwk);
    expect(Object.keys(signed.signatures as object)).toEqual(['ex.com']);
    expect(await verifySignature(signed, 'ex.com', keyId, publicKey)).toBe(true);
  });

  it('verifySignature returns false for wrong serverName even with a valid key', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson({ type: 'm.test' }, 'a.example.com', keyId, privateKeyJwk);
    expect(await verifySignature(signed, 'b.example.com', keyId, publicKey)).toBe(false);
  });

  it('verifySignature catch path returns false for garbage public key material', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson({ type: 'm.test' }, 'ex.com', keyId, privateKeyJwk);
    expect(await verifySignature(signed, 'ex.com', keyId, '!!!not-base64!!!')).toBe(false);
    expect(console.error).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('verifySignature returns false for truncated/corrupt signature bytes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson({ type: 'm.test' }, 'ex.com', keyId, privateKeyJwk);
    const sigs = signed.signatures as Record<string, Record<string, string>>;
    sigs['ex.com'][keyId] = 'AA';
    expect(await verifySignature(signed, 'ex.com', keyId, publicKey)).toBe(false);
    vi.restoreAllMocks();
  });

  it('preserves unsigned through signJson while hashing omits it', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const obj = { type: 'm.test', content: { x: 1 }, unsigned: { age: 3 } };
    const signed = await signJson(obj, 'ex.com', keyId, privateKeyJwk);
    expect(signed.unsigned).toEqual({ age: 3 });
    expect(await verifySignature(signed, 'ex.com', keyId, publicKey)).toBe(true);
    // Tamper only unsigned — signature still valid (unsigned stripped before verify)
    const tamperedUnsigned = { ...signed, unsigned: { age: 99 } };
    expect(await verifySignature(tamperedUnsigned, 'ex.com', keyId, publicKey)).toBe(true);
  });
});

/** Craft a PBKDF2 stored hash at an arbitrary iteration count (for boundary checks). */
async function craftPbkdf2Hash(password: string, iterations: number): Promise<string> {
  const salt = new Uint8Array(16).fill(7);
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const saltB64 = btoa(String.fromCharCode(...salt));
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return `$pbkdf2-sha256$${iterations}$${saltB64}$${hashB64}`;
}

describe('crypto TOKENMAXX leftovers after #232', () => {
  it(
    'accepts verifyPassword at the exact 2000000 iteration upper bound',
    async () => {
      const hash = await craftPbkdf2Hash('bound-hi-1', 2_000_000);
      expect(await verifyPassword('bound-hi-1', hash)).toBe(true);
      // Corrupt hash segment instead of re-deriving — avoids a third 2M-iteration PBKDF2
      const parts = hash.split('$');
      parts[4] = parts[4] === 'AAAA' ? 'BBBB' : 'AAAA';
      expect(await verifyPassword('bound-hi-1', parts.join('$'))).toBe(false);
    },
    60_000
  );

  it('rejects whitespace-only and letter+digit short-of-eight passwords', () => {
    expect(validatePasswordStrength('        ')).toMatch(/letter/);
    expect(validatePasswordStrength('abcdef7')).toMatch(/at least 8/);
    expect(validatePasswordStrength('abcdefg1')).toBeNull();
  });

  it('timingSafeEqual handles equal unicode strings and unequal code-unit lengths', () => {
    expect(timingSafeEqual('café', 'café')).toBe(true);
    expect(timingSafeEqual('café', 'cafe')).toBe(false);
    expect(timingSafeEqual('😀😀', '😀😀')).toBe(true);
    // JS string length is UTF-16 code units — emoji is length 2 each
    expect(timingSafeEqual('😀', 'ab')).toBe(false);
  });

  it('sha256 of multi-byte UTF-8 string matches encoding the same bytes', async () => {
    const s = '東京🔐';
    const fromString = await sha256(s);
    const fromBytes = await sha256(new TextEncoder().encode(s));
    expect(fromString).toBe(fromBytes);
    expect(await hashToken(s)).toBe(fromString);
  });

  it('canonicalJson maps undefined array elements to null', () => {
    expect(canonicalJson([1, undefined, null])).toBe('[1,null,null]');
  });

  it('calculateContentHash strips signatures and unsigned together', async () => {
    const bare = { type: 'm.test', content: { n: 2 } };
    const decorated = {
      ...bare,
      signatures: { 'example.com': { 'ed25519:1': 'sig' } },
      unsigned: { age: 1, redacted_because: { a: 1 } },
    };
    expect(await calculateContentHash(bare)).toBe(await calculateContentHash(decorated));
    expect(await verifyContentHash(decorated, await calculateContentHash(bare))).toBe(true);
  });

  it('base64UrlEncode/Decode round-trip empty and all-zero signing material', () => {
    expect(Array.from(base64UrlDecode(base64UrlEncode(new Uint8Array())))).toEqual([]);
    const zeros = new Uint8Array(32);
    expect(Array.from(base64UrlDecode(base64UrlEncode(zeros)))).toEqual(Array.from(zeros));
  });

  it('hashPassword / verifyPassword stay isolated under Promise.all', async () => {
    const [a, b, c] = await Promise.all([
      hashPassword('parallel-a-1'),
      hashPassword('parallel-b-1'),
      hashPassword('parallel-a-1'),
    ]);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    const [okA, okB, bad] = await Promise.all([
      verifyPassword('parallel-a-1', a),
      verifyPassword('parallel-b-1', b),
      verifyPassword('parallel-a-1', b),
    ]);
    expect(okA).toBe(true);
    expect(okB).toBe(true);
    expect(bad).toBe(false);
    expect(await verifyPassword('parallel-a-1', c)).toBe(true);
  });

  it('generateRandomString(128) stays in alphabet and differs across calls', () => {
    const a = generateRandomString(128);
    const b = generateRandomString(128);
    expect(a).toHaveLength(128);
    expect(b).toHaveLength(128);
    expect(a).toMatch(/^[A-Za-z0-9]+$/);
    expect(a).not.toBe(b);
  });
});

describe('federation signing TOKENMAXX leftovers after #232', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('signJson does not mutate the input object signatures map', async () => {
    const { privateKeyJwk, keyId } = await generateSigningKeyPair();
    const obj: Record<string, unknown> = {
      type: 'm.test',
      content: {},
      signatures: { 'other.example.com': { 'ed25519:old': 'keep' } },
    };
    const before = JSON.stringify(obj.signatures);
    const signed = await signJson(obj, 'ex.com', keyId, privateKeyJwk);
    expect(JSON.stringify(obj.signatures)).toBe(before);
    expect(signed).not.toBe(obj);
    expect((signed.signatures as Record<string, unknown>)['other.example.com']).toEqual({
      'ed25519:old': 'keep',
    });
  });

  it('verifySignature returns false for empty-string signature bytes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson({ type: 'm.test' }, 'ex.com', keyId, privateKeyJwk);
    const sigs = signed.signatures as Record<string, Record<string, string>>;
    sigs['ex.com'][keyId] = '';
    expect(await verifySignature(signed, 'ex.com', keyId, publicKey)).toBe(false);
    vi.restoreAllMocks();
  });

  it('verifySignature returns false when signatures map lacks the keyId under the server', async () => {
    const { publicKey, keyId } = await generateSigningKeyPair();
    const obj = {
      type: 'm.test',
      signatures: { 'ex.com': { 'ed25519:other': 'AA' } },
    };
    expect(await verifySignature(obj, 'ex.com', keyId, publicKey)).toBe(false);
  });

  it('generateSigningKeyPair produces distinct keyIds across calls', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it('parallel signJson on disjoint servers preserves both signatures', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const base = { type: 'm.test', content: { n: 1 } };
    const [signedA, signedB] = await Promise.all([
      signJson(base, 'a.example.com', a.keyId, a.privateKeyJwk),
      signJson(base, 'b.example.com', b.keyId, b.privateKeyJwk),
    ]);
    // Each call starts from the unsigned base — merge manually to verify both keys work
    const merged = {
      ...base,
      signatures: {
        ...(signedA.signatures as object),
        ...(signedB.signatures as object),
      },
    };
    expect(await verifySignature(merged, 'a.example.com', a.keyId, a.publicKey)).toBe(true);
    expect(await verifySignature(merged, 'b.example.com', b.keyId, b.publicKey)).toBe(true);
  });
});
