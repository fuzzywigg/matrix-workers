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

describe('crypto TOKENMAXX leftovers after #241', () => {
  it('rejects verifyPassword when stored hash is truncated (length mismatch)', async () => {
    const real = await hashPassword('trunc-me-1');
    const parts = real.split('$');
    parts[4] = parts[4].slice(0, 8);
    expect(await verifyPassword('trunc-me-1', parts.join('$'))).toBe(false);
  });

  it('rejects verifyPassword when the $-separated part count exceeds 5', async () => {
    expect(
      await verifyPassword('password1', '$pbkdf2-sha256$100000$c2FsdA==$aGFzaA==$extra')
    ).toBe(false);
  });

  it('rejects verifyPassword when salt base64 is invalid (atob throws)', async () => {
    await expect(
      verifyPassword('password1', '$pbkdf2-sha256$100000$!!!not-b64!!!$aGFzaA==')
    ).rejects.toThrow();
  });

  it('generateRandomString rejection-samples bytes >= 248 then still fills length', () => {
    const orig = crypto.getRandomValues.bind(crypto);
    let calls = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((arr: Uint8Array) => {
      calls += 1;
      if (calls === 1) {
        arr.fill(255); // all rejected (256 % 62 = 8 → maxValid 248)
        return arr;
      }
      return orig(arr);
    }) as typeof crypto.getRandomValues);
    const s = generateRandomString(16);
    expect(calls).toBeGreaterThan(1);
    expect(s).toHaveLength(16);
    expect(s).toMatch(/^[A-Za-z0-9]+$/);
    vi.restoreAllMocks();
  });

  it('encodes object values that are undefined as null in canonicalJson', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"a":null,"b":1}');
  });

  it('rejects passwords that use only a trailing space as the non-letter class', () => {
    expect(validatePasswordStrength('abcdefgh ')).toMatch(/number or special/);
  });

  it('calculateContentHash does not mutate the input signatures/unsigned maps', async () => {
    const content = {
      type: 'm.test',
      content: { n: 1 },
      signatures: { 'example.com': { 'ed25519:1': 'sig' } },
      unsigned: { age: 2 },
    };
    const before = JSON.stringify(content);
    await calculateContentHash(content);
    expect(JSON.stringify(content)).toBe(before);
  });
});

describe('federation signing TOKENMAXX leftovers after #241', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('signJson overwrites the same serverName+keyId on re-sign', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const base = { type: 'm.test', content: { n: 1 } };
    const once = await signJson(base, 'ex.com', keyId, privateKeyJwk);
    const firstSig = (once.signatures as Record<string, Record<string, string>>)['ex.com'][keyId];
    const twice = await signJson(
      { ...once, content: { n: 2 } },
      'ex.com',
      keyId,
      privateKeyJwk
    );
    const secondSig = (twice.signatures as Record<string, Record<string, string>>)['ex.com'][keyId];
    expect(secondSig).not.toBe(firstSig);
    expect(Object.keys((twice.signatures as Record<string, Record<string, string>>)['ex.com'])).toEqual([
      keyId,
    ]);
    expect(await verifySignature(twice, 'ex.com', keyId, publicKey)).toBe(true);
    expect(await verifySignature({ ...twice, content: { n: 1 } }, 'ex.com', keyId, publicKey)).toBe(
      false
    );
  });

  it('verifySignature returns false when the server map exists but the keyId slot is empty', async () => {
    const { publicKey, keyId } = await generateSigningKeyPair();
    const obj = { type: 'm.test', signatures: { 'ex.com': {} as Record<string, string> } };
    expect(await verifySignature(obj, 'ex.com', keyId, publicKey)).toBe(false);
  });
});

describe('crypto TOKENMAXX residual leftovers after #252', () => {
  it('sorts object keys lexicographically (string "10" before "2")', () => {
    expect(canonicalJson({ '10': 1, '2': 2, a: 3 })).toBe('{"10":1,"2":2,"a":3}');
  });

  it('encodes an empty-string object key', () => {
    expect(canonicalJson({ '': 1, b: 2 })).toBe('{"":1,"b":2}');
  });

  it('encodes nested bigint object values as null', () => {
    expect(canonicalJson({ a: 1n, b: [2n] })).toBe('{"a":null,"b":[null]}');
  });

  it('rejects unicode-letter-only passwords (ASCII [a-zA-Z] check)', () => {
    // "é" is a letter in Unicode but does not match /[a-zA-Z]/
    expect(validatePasswordStrength('ééééééé1')).toMatch(/letter/);
    expect(validatePasswordStrength('abcdefg1')).toBeNull();
  });

  it('accepts digit-first / letter-last and letter-first / symbol-last at length 8', () => {
    expect(validatePasswordStrength('1abcdefg')).toBeNull();
    expect(validatePasswordStrength('abcdefg!')).toBeNull();
  });

  it('hashPassword emits exactly five $-separated parts with decodable salt/hash', async () => {
    const hash = await hashPassword('format-check-1');
    const parts = hash.split('$');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('');
    expect(parts[1]).toBe('pbkdf2-sha256');
    expect(parts[2]).toBe('100000');
    expect(() => atob(parts[3])).not.toThrow();
    expect(() => atob(parts[4])).not.toThrow();
    expect(await verifyPassword('format-check-1', hash)).toBe(true);
  });

  it('hashes and verifies an empty-string password', async () => {
    const hash = await hashPassword('');
    expect(await verifyPassword('', hash)).toBe(true);
    expect(await verifyPassword('x', hash)).toBe(false);
  });

  it('verifyContentHash rejects an empty expected hash string', async () => {
    const content = { type: 'm.test', content: { n: 1 } };
    expect(await verifyContentHash(content, '')).toBe(false);
  });

  it('generateRandomString keeps partial fills when some bytes are rejected', () => {
    const orig = crypto.getRandomValues.bind(crypto);
    let calls = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((arr: Uint8Array) => {
      calls += 1;
      if (calls === 1) {
        // Mix: 247 valid, 255 rejected — should keep one char then need another draw
        arr[0] = 247;
        for (let i = 1; i < arr.length; i++) arr[i] = 255;
        return arr;
      }
      return orig(arr);
    }) as typeof crypto.getRandomValues);
    const s = generateRandomString(8);
    expect(calls).toBeGreaterThan(1);
    expect(s).toHaveLength(8);
    expect(s).toMatch(/^[A-Za-z0-9]+$/);
    // First kept byte 247 % 62 indexes the alphabet
    expect(s[0]).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[247 % 62]);
    vi.restoreAllMocks();
  });
});

describe('federation signing TOKENMAXX residual leftovers after #252', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('verifySignature returns false for a wrong but valid-length public key', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const signed = await signJson({ type: 'm.test', content: { n: 1 } }, 'ex.com', a.keyId, a.privateKeyJwk);
    expect(await verifySignature(signed, 'ex.com', a.keyId, a.publicKey)).toBe(true);
    expect(await verifySignature(signed, 'ex.com', a.keyId, b.publicKey)).toBe(false);
  });

  it('verifySignature returns false when signatures is null', async () => {
    const { publicKey, keyId } = await generateSigningKeyPair();
    const obj = { type: 'm.test', signatures: null as unknown as Record<string, Record<string, string>> };
    expect(await verifySignature(obj, 'ex.com', keyId, publicKey)).toBe(false);
  });

  it('signJson throws when privateKeyJwk string is not valid JSON', async () => {
    await expect(signJson({ type: 'm.test' }, 'ex.com', 'ed25519:deadbeef', '{not-json')).rejects.toThrow();
  });

  it('signJson preserves unrelated top-level fields alongside signatures', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const obj = {
      type: 'm.test',
      content: { body: 'hi' },
      room_id: '!r:example.com',
      sender: '@alice:example.com',
      origin_server_ts: 1,
    };
    const signed = await signJson(obj, 'ex.com', keyId, privateKeyJwk);
    expect(signed.room_id).toBe('!r:example.com');
    expect(signed.sender).toBe('@alice:example.com');
    expect(signed.origin_server_ts).toBe(1);
    expect(await verifySignature(signed, 'ex.com', keyId, publicKey)).toBe(true);
  });
});

describe('crypto TOKENMAXX residual leftovers after #264', () => {
  it('hashPassword / verifyPassword / sha256 stay isolated under concurrent Promise.all', async () => {
    const [ha, hb, sa, sb] = await Promise.all([
      hashPassword('conc-a-1'),
      hashPassword('conc-b-1'),
      sha256('token-a'),
      sha256('token-b'),
    ]);
    expect(ha).not.toBe(hb);
    expect(sa).not.toBe(sb);
    const [okA, okB, badCross, tokA] = await Promise.all([
      verifyPassword('conc-a-1', ha),
      verifyPassword('conc-b-1', hb),
      verifyPassword('conc-a-1', hb),
      hashToken('token-a'),
    ]);
    expect(okA).toBe(true);
    expect(okB).toBe(true);
    expect(badCross).toBe(false);
    expect(tokA).toBe(sa);
  });

  it('calculateContentHash / verifyContentHash race on disjoint PDUs stays correct', async () => {
    const a = { type: 'm.test', content: { n: 1 } };
    const b = { type: 'm.test', content: { n: 2 } };
    const [ha, hb] = await Promise.all([calculateContentHash(a), calculateContentHash(b)]);
    expect(ha).not.toBe(hb);
    const [okA, badB, okB] = await Promise.all([
      verifyContentHash(a, ha),
      verifyContentHash(b, ha),
      verifyContentHash(b, hb),
    ]);
    expect(okA).toBe(true);
    expect(badB).toBe(false);
    expect(okB).toBe(true);
  });

  it('timingSafeEqual empty strings and generateRandomString race stay consistent', async () => {
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('', 'a')).toBe(false);
    const samples = await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve(generateRandomString(24)))
    );
    expect(new Set(samples).size).toBe(8);
    for (const s of samples) {
      expect(s).toHaveLength(24);
      expect(s).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it('rejects verifyPassword when scheme is wrong even at valid iteration bounds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await verifyPassword('password1', '$pbkdf2-sha512$100000$c2FsdA==$aGFzaA==')).toBe(
      false
    );
    expect(await verifyPassword('password1', '$argon2id$100000$c2FsdA==$aGFzaA==')).toBe(false);
    // Wrong scheme returns false before iteration console.error
    expect(console.error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('canonicalJson encodes nested empty objects and sparse-like undefined holes under race', () => {
    const [a, b] = [canonicalJson({ a: {}, b: [] }), canonicalJson([undefined, {}])];
    expect(a).toBe('{"a":{},"b":[]}');
    expect(b).toBe('[null,{}]');
  });
});

describe('federation signing TOKENMAXX residual leftovers after #264', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('signJson accepts a JSON-string privateKeyJwk and verifies under concurrent calls', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const base = { type: 'm.test', content: { n: 1 } };
    const [signedA, signedB] = await Promise.all([
      signJson(base, 'a.example.com', a.keyId, JSON.stringify(a.privateKeyJwk)),
      signJson(base, 'b.example.com', b.keyId, JSON.stringify(b.privateKeyJwk)),
    ]);
    const [okA, okB, badCross] = await Promise.all([
      verifySignature(signedA, 'a.example.com', a.keyId, a.publicKey),
      verifySignature(signedB, 'b.example.com', b.keyId, b.publicKey),
      verifySignature(signedA, 'a.example.com', a.keyId, b.publicKey),
    ]);
    expect(okA).toBe(true);
    expect(okB).toBe(true);
    expect(badCross).toBe(false);
  });

  it('verifySignature returns false when server map is missing (signatures present)', async () => {
    const { publicKey, keyId } = await generateSigningKeyPair();
    const obj = {
      type: 'm.test',
      signatures: { 'other.example.com': { [keyId]: 'AA' } },
    };
    expect(await verifySignature(obj, 'ex.com', keyId, publicKey)).toBe(false);
  });

  it('parallel re-sign on the same server+keyId yields independent verifiable objects', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const [s1, s2] = await Promise.all([
      signJson({ type: 'm.test', content: { n: 1 } }, 'ex.com', keyId, privateKeyJwk),
      signJson({ type: 'm.test', content: { n: 2 } }, 'ex.com', keyId, privateKeyJwk),
    ]);
    expect(await verifySignature(s1, 'ex.com', keyId, publicKey)).toBe(true);
    expect(await verifySignature(s2, 'ex.com', keyId, publicKey)).toBe(true);
    expect(
      (s1.signatures as Record<string, Record<string, string>>)['ex.com'][keyId]
    ).not.toBe((s2.signatures as Record<string, Record<string, string>>)['ex.com'][keyId]);
  });
});

describe('crypto TOKENMAXX residual leftovers after #272', () => {
  it('concurrent verifyPassword pins iteration-reject console.error messages', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [lo, hi] = await Promise.all([
      verifyPassword('password1', '$pbkdf2-sha256$99999$c2FsdA==$aGFzaA=='),
      verifyPassword('password1', '$pbkdf2-sha256$2000001$c2FsdA==$aGFzaA=='),
    ]);
    expect(lo).toBe(false);
    expect(hi).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    const messages = spy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('invalid iteration count: 99999'))).toBe(true);
    expect(messages.some((m) => m.includes('invalid iteration count: 2000001'))).toBe(true);
    expect(messages.every((m) => m.startsWith('[crypto] Rejecting stored hash with invalid iteration count:'))).toBe(
      true
    );
    spy.mockRestore();
  });

  it('calculateContentHash concurrent strip leaves signatures/unsigned maps intact', async () => {
    const a: Record<string, unknown> = {
      type: 'm.test',
      content: { n: 1 },
      signatures: { 'a.example.com': { 'ed25519:1': 'sig-a' } },
      unsigned: { age: 1 },
    };
    const b: Record<string, unknown> = {
      type: 'm.test',
      content: { n: 2 },
      signatures: { 'b.example.com': { 'ed25519:1': 'sig-b' } },
      unsigned: { age: 2 },
    };
    const beforeA = JSON.stringify(a);
    const beforeB = JSON.stringify(b);
    const [ha, hb] = await Promise.all([calculateContentHash(a), calculateContentHash(b)]);
    expect(ha).not.toBe(hb);
    const [okA, badCross, okB] = await Promise.all([
      verifyContentHash(a, ha),
      verifyContentHash(b, ha),
      verifyContentHash(b, hb),
    ]);
    expect(okA).toBe(true);
    expect(badCross).toBe(false);
    expect(okB).toBe(true);
    expect(JSON.stringify(a)).toBe(beforeA);
    expect(JSON.stringify(b)).toBe(beforeB);
  });
});

describe('federation signing TOKENMAXX residual leftovers after #272', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('concurrent verifySignature catch paths log independently of a valid verify', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson({ type: 'm.test', content: { n: 1 } }, 'ex.com', keyId, privateKeyJwk);
    const garbageKey = '!!!not-valid-base64url!!!';
    const truncated = {
      ...signed,
      signatures: {
        'ex.com': {
          [keyId]: 'AA',
        },
      },
    };
    const [ok, badKey, badSig] = await Promise.all([
      verifySignature(signed, 'ex.com', keyId, publicKey),
      verifySignature(signed, 'ex.com', keyId, garbageKey),
      verifySignature(truncated, 'ex.com', keyId, publicKey),
    ]);
    expect(ok).toBe(true);
    expect(badKey).toBe(false);
    expect(badSig).toBe(false);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(
      spy.mock.calls.every((c) => String(c[0]) === 'Signature verification failed:')
    ).toBe(true);
    spy.mockRestore();
  });

  it('concurrent dual-keyId signJson from a shared signed base merges without clobber', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const once = await signJson({ type: 'm.test', content: { n: 0 } }, 'ex.com', a.keyId, a.privateKeyJwk);
    const [signedA, signedB] = await Promise.all([
      signJson(once, 'ex.com', a.keyId, a.privateKeyJwk),
      signJson(once, 'ex.com', b.keyId, b.privateKeyJwk),
    ]);
    // Merge both independent results the way a caller would combine concurrent keyIds
    const merged = {
      ...once,
      signatures: {
        'ex.com': {
          ...(signedA.signatures as Record<string, Record<string, string>>)['ex.com'],
          ...(signedB.signatures as Record<string, Record<string, string>>)['ex.com'],
        },
      },
    };
    expect(Object.keys((merged.signatures as Record<string, Record<string, string>>)['ex.com']).sort()).toEqual(
      [a.keyId, b.keyId].sort()
    );
    expect(await verifySignature(merged, 'ex.com', a.keyId, a.publicKey)).toBe(true);
    expect(await verifySignature(merged, 'ex.com', b.keyId, b.publicKey)).toBe(true);
  });

  it('concurrent generateSigningKeyPairLegacy pairs sign/verify in isolation', async () => {
    const [legacyA, legacyB] = await Promise.all([
      generateSigningKeyPairLegacy(),
      generateSigningKeyPairLegacy(),
    ]);
    expect(legacyA.keyId).not.toBe(legacyB.keyId);
    const [signedA, signedB] = await Promise.all([
      signJson({ type: 'm.test', content: { side: 'a' } }, 'a.example.com', legacyA.keyId, legacyA.privateKey),
      signJson({ type: 'm.test', content: { side: 'b' } }, 'b.example.com', legacyB.keyId, legacyB.privateKey),
    ]);
    const [okA, okB, badCross] = await Promise.all([
      verifySignature(signedA, 'a.example.com', legacyA.keyId, legacyA.publicKey),
      verifySignature(signedB, 'b.example.com', legacyB.keyId, legacyB.publicKey),
      verifySignature(signedA, 'a.example.com', legacyA.keyId, legacyB.publicKey),
    ]);
    expect(okA).toBe(true);
    expect(okB).toBe(true);
    expect(badCross).toBe(false);
  });
});

describe('federation signing TOKENMAXX residual second-wave leftovers after #282', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('concurrent local re-sign from foreign-server base preserves foreign sig', async () => {
    const foreign = await generateSigningKeyPair();
    const localA = await generateSigningKeyPair();
    const localB = await generateSigningKeyPair();
    const base = await signJson(
      { type: 'm.test', content: { n: 1 }, unsigned: { age: 9 } },
      'foreign.example.com',
      foreign.keyId,
      foreign.privateKeyJwk
    );
    const foreignSnap = {
      ...(base.signatures as Record<string, Record<string, string>>)['foreign.example.com'],
    };
    const [signedA, signedB] = await Promise.all([
      signJson(base, 'local.example.com', localA.keyId, localA.privateKeyJwk),
      signJson(base, 'local.example.com', localB.keyId, localB.privateKeyJwk),
    ]);
    for (const signed of [signedA, signedB]) {
      expect((signed.signatures as Record<string, Record<string, string>>)['foreign.example.com']).toEqual(
        foreignSnap
      );
      expect(signed.unsigned).toEqual({ age: 9 });
      expect(await verifySignature(signed, 'foreign.example.com', foreign.keyId, foreign.publicKey)).toBe(
        true
      );
    }
    expect(await verifySignature(signedA, 'local.example.com', localA.keyId, localA.publicKey)).toBe(true);
    expect(await verifySignature(signedB, 'local.example.com', localB.keyId, localB.publicKey)).toBe(true);
    // Each concurrent call started from the same foreign base — sibling local keyIds are not merged
    expect(
      (signedA.signatures as Record<string, Record<string, string>>)['local.example.com'][localB.keyId]
    ).toBeUndefined();
    expect(
      (signedB.signatures as Record<string, Record<string, string>>)['local.example.com'][localA.keyId]
    ).toBeUndefined();
  });
});

describe('federation signing TOKENMAXX residual tertiary leftovers after #290', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('concurrent foreign re-sign from local-server base preserves local sig', async () => {
    const local = await generateSigningKeyPair();
    const foreignA = await generateSigningKeyPair();
    const foreignB = await generateSigningKeyPair();
    const base = await signJson(
      { type: 'm.test', content: { n: 2 }, unsigned: { age: 3 } },
      'local.example.com',
      local.keyId,
      local.privateKeyJwk
    );
    const localSnap = {
      ...(base.signatures as Record<string, Record<string, string>>)['local.example.com'],
    };
    const [signedA, signedB] = await Promise.all([
      signJson(base, 'foreign.example.com', foreignA.keyId, foreignA.privateKeyJwk),
      signJson(base, 'foreign.example.com', foreignB.keyId, foreignB.privateKeyJwk),
    ]);
    for (const signed of [signedA, signedB]) {
      expect((signed.signatures as Record<string, Record<string, string>>)['local.example.com']).toEqual(
        localSnap
      );
      expect(signed.unsigned).toEqual({ age: 3 });
      expect(await verifySignature(signed, 'local.example.com', local.keyId, local.publicKey)).toBe(true);
    }
    expect(await verifySignature(signedA, 'foreign.example.com', foreignA.keyId, foreignA.publicKey)).toBe(
      true
    );
    expect(await verifySignature(signedB, 'foreign.example.com', foreignB.keyId, foreignB.publicKey)).toBe(
      true
    );
    // Sibling foreign keyIds are not merged across concurrent calls from the shared local base
    expect(
      (signedA.signatures as Record<string, Record<string, string>>)['foreign.example.com'][foreignB.keyId]
    ).toBeUndefined();
    expect(
      (signedB.signatures as Record<string, Record<string, string>>)['foreign.example.com'][foreignA.keyId]
    ).toBeUndefined();
  });

  it('concurrent verifySignature empty-server-map vs valid signature stay isolated', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson({ type: 'm.test', content: { ok: true } }, 'ex.com', keyId, privateKeyJwk);
    const emptyServer = {
      ...signed,
      signatures: { 'ex.com': {} },
    };
    const [ok, empty, missing] = await Promise.all([
      verifySignature(signed, 'ex.com', keyId, publicKey),
      verifySignature(emptyServer, 'ex.com', keyId, publicKey),
      verifySignature(signed, 'other.example.com', keyId, publicKey),
    ]);
    expect(ok).toBe(true);
    expect(empty).toBe(false);
    expect(missing).toBe(false);
  });
});

describe('crypto TOKENMAXX residual tertiary leftovers after #290', () => {
  it('hashToken / sha256 concurrent distinct tokens stay isolated and match', async () => {
    const [ta, tb, sa, sb] = await Promise.all([
      hashToken('syt_a_example'),
      hashToken('syt_b_example'),
      sha256('syt_a_example'),
      sha256('syt_b_example'),
    ]);
    expect(ta).toBe(sa);
    expect(tb).toBe(sb);
    expect(ta).not.toBe(tb);
    expect(ta).not.toMatch(/[+/=]/);
    expect(tb).not.toMatch(/[+/=]/);
  });

  it('calculateContentHash concurrent strip leaves signatures while verifyContentHash races', async () => {
    const a = {
      type: 'm.test',
      content: { side: 'a' },
      signatures: { 'a.example.com': { 'ed25519:1': 'siga' } },
      unsigned: { age: 1 },
    };
    const b = {
      type: 'm.test',
      content: { side: 'b' },
      signatures: { 'b.example.com': { 'ed25519:2': 'sigb' } },
      unsigned: { age: 2 },
    };
    const expectedA = await calculateContentHash({ type: 'm.test', content: { side: 'a' } });
    const beforeA = JSON.stringify(a);
    const beforeB = JSON.stringify(b);
    const [hashA, hashB, okA, badB] = await Promise.all([
      calculateContentHash(a),
      calculateContentHash(b),
      verifyContentHash(a, expectedA),
      verifyContentHash(b, 'not-a-real-hash'),
    ]);
    expect(hashA).toBe(expectedA);
    expect(hashA).not.toBe(hashB);
    expect(okA).toBe(true);
    expect(badB).toBe(false);
    expect(JSON.stringify(a)).toBe(beforeA);
    expect(JSON.stringify(b)).toBe(beforeB);
    expect(a.signatures).toEqual({ 'a.example.com': { 'ed25519:1': 'siga' } });
    expect(b.signatures).toEqual({ 'b.example.com': { 'ed25519:2': 'sigb' } });
  });

  it('validatePasswordStrength concurrent boundary lengths stay independent', async () => {
    const [short, exact8, exact1000, over] = await Promise.all([
      Promise.resolve(validatePasswordStrength('abcdef7')),
      Promise.resolve(validatePasswordStrength('abcdefg1')),
      Promise.resolve(validatePasswordStrength(`${'a'.repeat(999)}1`)),
      Promise.resolve(validatePasswordStrength(`${'a'.repeat(1000)}1`)),
    ]);
    expect(short).toMatch(/at least 8/);
    expect(exact8).toBeNull();
    expect(exact1000).toBeNull();
    expect(over).toMatch(/at most 1000/);
  });
});

describe('crypto TOKENMAXX residual quaternary leftovers after #298', () => {
  it('validatePasswordStrength concurrent letter/number exact strings stay independent', async () => {
    const [noLetter, noNumber, okDigit, okSymbol, short, over] = await Promise.all([
      Promise.resolve(validatePasswordStrength('12345678')),
      Promise.resolve(validatePasswordStrength('password')),
      Promise.resolve(validatePasswordStrength('abcdefgh1')),
      Promise.resolve(validatePasswordStrength('abcdefg!')),
      Promise.resolve(validatePasswordStrength('abcdef7')),
      Promise.resolve(validatePasswordStrength(`${'a'.repeat(1000)}1`)),
    ]);
    expect(noLetter).toBe('Password must contain at least one letter');
    expect(noNumber).toBe('Password must contain at least one number or special character');
    expect(okDigit).toBeNull();
    expect(okSymbol).toBeNull();
    expect(short).toBe('Password must be at least 8 characters long');
    expect(over).toBe('Password must be at most 1000 characters long');
  });

  it('validatePasswordStrength concurrent symbol-only / whitespace-only / unicode-letter exacts', async () => {
    const [symbols, spaces, unicodeLetter, trailingSpace, mixedOk] = await Promise.all([
      Promise.resolve(validatePasswordStrength('!!!!!!!!')),
      Promise.resolve(validatePasswordStrength('        ')),
      Promise.resolve(validatePasswordStrength('ééééééé1')),
      Promise.resolve(validatePasswordStrength('abcdefgh ')),
      Promise.resolve(validatePasswordStrength('1abcdefg')),
    ]);
    expect(symbols).toBe('Password must contain at least one letter');
    expect(spaces).toBe('Password must contain at least one letter');
    expect(unicodeLetter).toBe('Password must contain at least one letter');
    expect(trailingSpace).toBe(
      'Password must contain at least one number or special character'
    );
    expect(mixedOk).toBeNull();
  });

  for (let i = 0; i < 8; i++) {
    it(`validatePasswordStrength exact complexity flood-${i}`, async () => {
      const [letter, number, ok] = await Promise.all([
        Promise.resolve(validatePasswordStrength(`${'9'.repeat(8 + (i % 3))}`)),
        Promise.resolve(validatePasswordStrength(`${'a'.repeat(8 + (i % 3))}`)),
        Promise.resolve(validatePasswordStrength(`pass${i}word1`)),
      ]);
      expect(letter).toBe('Password must contain at least one letter');
      expect(number).toBe(
        'Password must contain at least one number or special character'
      );
      expect(ok).toBeNull();
    });
  }
});

describe('crypto TOKENMAXX residual quinary leftovers after #303', () => {
  it('verifyPassword malformed∥atob-throw∥hashPassword ok∥timingSafeEqual under race', async () => {
    const [hash, lowIter, wrongScheme, extraParts, atobResult, eq, ne] = await Promise.all([
      hashPassword('quinary-ok-1'),
      verifyPassword('x', '$pbkdf2-sha256$99999$c2FsdA==$aGFzaA=='),
      verifyPassword('x', '$pbkdf2-sha1$100000$c2FsdA==$aGFzaA=='),
      verifyPassword('x', '$pbkdf2-sha256$100000$c2FsdA==$aGFzaA==$extra'),
      verifyPassword('x', '$pbkdf2-sha256$100000$!!!not-b64!!!$aGFzaA==').then(
        () => 'resolved' as const,
        () => 'threw' as const
      ),
      Promise.resolve(timingSafeEqual('same-token', 'same-token')),
      Promise.resolve(timingSafeEqual('same-token', 'diff-token')),
    ]);
    expect(await verifyPassword('quinary-ok-1', hash)).toBe(true);
    expect(lowIter).toBe(false);
    expect(wrongScheme).toBe(false);
    expect(extraParts).toBe(false);
    expect(atobResult).toBe('threw');
    expect(eq).toBe(true);
    expect(ne).toBe(false);
  });

  it('validatePasswordStrength exact ∥ verifyPassword reject ∥ hashToken under race', async () => {
    const [noLetter, noNumber, short, over, rejectIter, tokenA, tokenB] = await Promise.all([
      Promise.resolve(validatePasswordStrength('12345678')),
      Promise.resolve(validatePasswordStrength('password')),
      Promise.resolve(validatePasswordStrength('abcdef7')),
      Promise.resolve(validatePasswordStrength(`${'a'.repeat(1000)}1`)),
      verifyPassword('password1', '$pbkdf2-sha256$2000001$c2FsdA==$aGFzaA=='),
      hashToken('syt_quinary_a'),
      hashToken('syt_quinary_b'),
    ]);
    expect(noLetter).toBe('Password must contain at least one letter');
    expect(noNumber).toBe('Password must contain at least one number or special character');
    expect(short).toBe('Password must be at least 8 characters long');
    expect(over).toBe('Password must be at most 1000 characters long');
    expect(rejectIter).toBe(false);
    expect(tokenA).not.toBe(tokenB);
    expect(tokenA).toBe(await sha256('syt_quinary_a'));
  });

  for (let i = 0; i < 8; i++) {
    it(`verifyPassword malformed∥strength exact flood-${i}`, async () => {
      const [reject, letter, number, okHash] = await Promise.all([
        verifyPassword(
          `pw-${i}`,
          i % 2 === 0
            ? `$pbkdf2-sha256$${99999 - i}$c2FsdA==$aGFzaA==`
            : `$pbkdf2-sha256$100000$c2FsdA==$aGFzaA==$x${i}`
        ),
        Promise.resolve(validatePasswordStrength(`${'9'.repeat(8 + (i % 3))}`)),
        Promise.resolve(validatePasswordStrength(`${'a'.repeat(8 + (i % 3))}`)),
        hashPassword(`quinary-flood-${i}-1`),
      ]);
      expect(reject).toBe(false);
      expect(letter).toBe('Password must contain at least one letter');
      expect(number).toBe(
        'Password must contain at least one number or special character'
      );
      expect(await verifyPassword(`quinary-flood-${i}-1`, okHash)).toBe(true);
    });
  }
});

describe('federation signing TOKENMAXX residual quinary leftovers after #303', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('signJson∥verifySignature∥timingSafeEqual stay isolated under Promise.all', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const baseA = { type: 'm.test', content: { side: 'a' } };
    const baseB = { type: 'm.test', content: { side: 'b' } };
    const [signedA, signedB] = await Promise.all([
      signJson(baseA, 'a.example.com', a.keyId, a.privateKeyJwk),
      signJson(baseB, 'b.example.com', b.keyId, b.privateKeyJwk),
    ]);
    const [okA, okB, badCross, eq] = await Promise.all([
      verifySignature(signedA, 'a.example.com', a.keyId, a.publicKey),
      verifySignature(signedB, 'b.example.com', b.keyId, b.publicKey),
      verifySignature(signedA, 'a.example.com', a.keyId, b.publicKey),
      Promise.resolve(timingSafeEqual(a.keyId, b.keyId)),
    ]);
    expect(okA).toBe(true);
    expect(okB).toBe(true);
    expect(badCross).toBe(false);
    expect(eq).toBe(a.keyId === b.keyId);
  });

  for (let i = 0; i < 6; i++) {
    it(`signJson∥verifySignature concurrent flood-${i}`, async () => {
      const pair = await generateSigningKeyPair();
      const obj = { type: 'm.test', content: { n: i } };
      const [signed, other] = await Promise.all([
        signJson(obj, 'ex.com', pair.keyId, pair.privateKeyJwk),
        signJson({ type: 'm.other', content: { n: i } }, 'ex.com', pair.keyId, pair.privateKeyJwk),
      ]);
      const [ok, bad] = await Promise.all([
        verifySignature(signed, 'ex.com', pair.keyId, pair.publicKey),
        verifySignature(other, 'other.example.com', pair.keyId, pair.publicKey),
      ]);
      expect(ok).toBe(true);
      expect(bad).toBe(false);
    });
  }
});

describe('crypto TOKENMAXX residual senary leftovers after #310', () => {
  it('verifyPassword scheme/truncated/NaN rejects stay isolated from a valid verify under race', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = await hashPassword('password1');
    const truncated = (() => {
      const parts = real.split('$');
      parts[4] = parts[4].slice(0, Math.max(1, parts[4].length - 2));
      return parts.join('$');
    })();
    const [ok, badScheme, badTrunc, badNan] = await Promise.all([
      verifyPassword('password1', real),
      verifyPassword('password1', '$argon2id$100000$c2FsdA==$aGFzaA=='),
      verifyPassword('password1', truncated),
      verifyPassword('password1', '$pbkdf2-sha256$notanumber$c2FsdA==$aGFzaA=='),
    ]);
    expect(ok).toBe(true);
    expect(badScheme).toBe(false);
    expect(badTrunc).toBe(false);
    expect(badNan).toBe(false);
    // scheme reject is silent; NaN iteration logs once
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe(
      '[crypto] Rejecting stored hash with invalid iteration count: notanumber'
    );
    spy.mockRestore();
  });

  it('verifyContentHash empty expected ∥ correct ∥ cross-hash stay independent under race', async () => {
    const a = { type: 'm.test', content: { side: 'a' } };
    const b = { type: 'm.test', content: { side: 'b' } };
    const hashA = await calculateContentHash(a);
    const hashB = await calculateContentHash(b);
    const [empty, ok, cross, hashAgain] = await Promise.all([
      verifyContentHash(a, ''),
      verifyContentHash(a, hashA),
      verifyContentHash(b, hashA),
      calculateContentHash(b),
    ]);
    expect(empty).toBe(false);
    expect(ok).toBe(true);
    expect(cross).toBe(false);
    expect(hashAgain).toBe(hashB);
  });

  it('timingSafeEqual + hashToken + generateRandomString stay isolated under Promise.all', async () => {
    const [eq, neq, len, tokA, tokB, empty, one, def] = await Promise.all([
      Promise.resolve(timingSafeEqual('same', 'same')),
      Promise.resolve(timingSafeEqual('same', 'samp')),
      Promise.resolve(timingSafeEqual('ab', 'abc')),
      hashToken('syt_senary_a'),
      hashToken('syt_senary_b'),
      Promise.resolve(generateRandomString(0)),
      Promise.resolve(generateRandomString(1)),
      Promise.resolve(generateRandomString()),
    ]);
    expect(eq).toBe(true);
    expect(neq).toBe(false);
    expect(len).toBe(false);
    expect(tokA).not.toBe(tokB);
    expect(tokA).not.toMatch(/[+/=]/);
    expect(empty).toBe('');
    expect(one).toMatch(/^[A-Za-z0-9]$/);
    expect(def).toHaveLength(32);
    expect(def).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('canonicalJson bigint/function/undefined race stays deterministic', async () => {
    const [bigintObj, fnObj, undefArr, nested] = await Promise.all([
      Promise.resolve(canonicalJson({ n: 1n })),
      Promise.resolve(canonicalJson({ f: () => 1 })),
      Promise.resolve(canonicalJson([undefined, null])),
      Promise.resolve(canonicalJson({ z: 1, a: { b: undefined } })),
    ]);
    expect(bigintObj).toBe('{"n":null}');
    expect(fnObj).toBe('{"f":null}');
    expect(undefArr).toBe('[null,null]');
    expect(nested).toBe('{"a":{"b":null},"z":1}');
  });
});

describe('federation signing TOKENMAXX residual senary leftovers after #310', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('generateSigningKeyPair ∥ Legacy produce distinct keyIds that both sign/verify under race', async () => {
    const [a, legacy] = await Promise.all([
      generateSigningKeyPair(),
      generateSigningKeyPairLegacy(),
    ]);
    expect(a.keyId).toMatch(/^ed25519:[0-9a-f]{8}$/);
    expect(legacy.keyId).toMatch(/^ed25519:[0-9a-f]{8}$/);
    expect(a.keyId).not.toBe(legacy.keyId);
    const [signedA, signedL] = await Promise.all([
      signJson({ type: 'm.test', content: { k: 'a' } }, 'ex.com', a.keyId, a.privateKeyJwk),
      signJson({ type: 'm.test', content: { k: 'l' } }, 'ex.com', legacy.keyId, legacy.privateKey),
    ]);
    const [okA, okL, cross] = await Promise.all([
      verifySignature(signedA, 'ex.com', a.keyId, a.publicKey),
      verifySignature(signedL, 'ex.com', legacy.keyId, legacy.publicKey),
      verifySignature(signedA, 'ex.com', a.keyId, legacy.publicKey),
    ]);
    expect(okA).toBe(true);
    expect(okL).toBe(true);
    expect(cross).toBe(false);
  });

  it('signJson overwrite same server+keyId ∥ verify of pre-overwrite snapshot stays true', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const first = await signJson(
      { type: 'm.test', content: { n: 1 } },
      'ex.com',
      keyId,
      privateKeyJwk
    );
    const snapshot = structuredClone(first);
    const [rewritten, stillOk, missing] = await Promise.all([
      signJson({ type: 'm.test', content: { n: 2 } }, 'ex.com', keyId, privateKeyJwk),
      verifySignature(snapshot, 'ex.com', keyId, publicKey),
      verifySignature(snapshot, 'other.example.com', keyId, publicKey),
    ]);
    expect(stillOk).toBe(true);
    expect(missing).toBe(false);
    expect(await verifySignature(rewritten, 'ex.com', keyId, publicKey)).toBe(true);
    expect(
      (rewritten.signatures as Record<string, Record<string, string>>)['ex.com'][keyId]
    ).not.toBe((snapshot.signatures as Record<string, Record<string, string>>)['ex.com'][keyId]);
  });

  it('concurrent verifySignature garbage pubkey catch ∥ empty sig ∥ valid stay isolated', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson({ type: 'm.test', content: { ok: true } }, 'ex.com', keyId, privateKeyJwk);
    const emptySig = {
      ...signed,
      signatures: { 'ex.com': { [keyId]: '' } },
    };
    const [ok, garbage, empty] = await Promise.all([
      verifySignature(signed, 'ex.com', keyId, publicKey),
      verifySignature(signed, 'ex.com', keyId, '!!!not-base64!!!'),
      verifySignature(emptySig, 'ex.com', keyId, publicKey),
    ]);
    expect(ok).toBe(true);
    expect(garbage).toBe(false);
    expect(empty).toBe(false);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('Signature verification failed'))).toBe(
      true
    );
    spy.mockRestore();
  });
});

describe('crypto TOKENMAXX residual septenary leftovers after #319', () => {
  it('verifyPassword iteration boundary 99999/2000001 rejects under race with exact logs', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = await hashPassword('septenary-ok-1');
    const [ok, below, above, wrongPw, badHash] = await Promise.all([
      verifyPassword('septenary-ok-1', real),
      verifyPassword('x', '$pbkdf2-sha256$99999$c2FsdA==$aGFzaA=='),
      verifyPassword('x', '$pbkdf2-sha256$2000001$c2FsdA==$aGFzaA=='),
      verifyPassword('wrong', real),
      // valid iteration count but wrong digest → false without iteration log
      verifyPassword('x', '$pbkdf2-sha256$100000$c2FsdA==$aGFzaA=='),
    ]);
    expect(ok).toBe(true);
    expect(below).toBe(false);
    expect(above).toBe(false);
    expect(wrongPw).toBe(false);
    expect(badHash).toBe(false);
    const iterLogs = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('[crypto] Rejecting stored hash with invalid iteration count:'));
    expect(iterLogs.sort()).toEqual([
      '[crypto] Rejecting stored hash with invalid iteration count: 2000001',
      '[crypto] Rejecting stored hash with invalid iteration count: 99999',
    ]);
    spy.mockRestore();
  });

  it('hashPassword same plaintext ∥ sha256 string≡bytes ∥ hashToken stay isolated under race', async () => {
    const text = 'septenary-salt';
    const bytes = new TextEncoder().encode(text);
    const [a, b, fromStr, fromBytes, tok] = await Promise.all([
      hashPassword('same-plain-1'),
      hashPassword('same-plain-1'),
      sha256(text),
      sha256(bytes),
      hashToken(text),
    ]);
    expect(a).toMatch(/^\$pbkdf2-sha256\$100000\$/);
    expect(b).toMatch(/^\$pbkdf2-sha256\$100000\$/);
    expect(a).not.toBe(b); // distinct salts
    expect(await verifyPassword('same-plain-1', a)).toBe(true);
    expect(await verifyPassword('same-plain-1', b)).toBe(true);
    expect(fromStr).toBe(fromBytes);
    expect(tok).toBe(fromStr);
    expect(tok).not.toMatch(/[+/=]/);
  });

  it('canonicalJson Symbol/NaN/Infinity/-0/bigint race stays deterministic', async () => {
    const [sym, nan, posInf, negInf, negZero, bigint] = await Promise.all([
      Promise.resolve(canonicalJson(Symbol('sept'))),
      Promise.resolve(canonicalJson(Number.NaN)),
      Promise.resolve(canonicalJson(Number.POSITIVE_INFINITY)),
      Promise.resolve(canonicalJson(Number.NEGATIVE_INFINITY)),
      Promise.resolve(canonicalJson(-0)),
      Promise.resolve(canonicalJson(2n)),
    ]);
    expect(sym).toBe('null');
    expect(nan).toBe('null');
    expect(posInf).toBe('null');
    expect(negInf).toBe('null');
    expect(negZero).toBe('0');
    expect(bigint).toBe('null');
  });

  it('base64UrlEncode/Decode concurrent empty/zeros/non-ascii round-trips stay isolated', async () => {
    const zeros = new Uint8Array(8);
    const nonAscii = new Uint8Array([0, 255, 128, 1, 127, 254]);
    const [emptyEnc, emptyDec, zeroRound, nonRound, identity] = await Promise.all([
      Promise.resolve(base64UrlEncode(new Uint8Array())),
      Promise.resolve(Array.from(base64UrlDecode(''))),
      Promise.resolve(Array.from(base64UrlDecode(base64UrlEncode(zeros)))),
      Promise.resolve(Array.from(base64UrlDecode(base64UrlEncode(nonAscii)))),
      Promise.resolve(base64UrlEncode(nonAscii)),
    ]);
    expect(emptyEnc).toBe('');
    expect(emptyDec).toEqual([]);
    expect(zeroRound).toEqual(Array.from(zeros));
    expect(nonRound).toEqual(Array.from(nonAscii));
    expect(identity).not.toMatch(/[+/=]/);
  });

  it('validatePasswordStrength empty/nullish-adjacent exacts ∥ generateRandomString under race', async () => {
    const [empty, undefish, one, long, rnd0, rnd3, rndDef] = await Promise.all([
      Promise.resolve(validatePasswordStrength('')),
      Promise.resolve(validatePasswordStrength(undefined as unknown as string)),
      Promise.resolve(validatePasswordStrength('a1')),
      Promise.resolve(validatePasswordStrength(`${'Ab1!'.repeat(250)}x`)), // 1001 chars
      Promise.resolve(generateRandomString(0)),
      Promise.resolve(generateRandomString(3)),
      Promise.resolve(generateRandomString()),
    ]);
    expect(empty).toBe('Password must be at least 8 characters long');
    expect(undefish).toBe('Password must be at least 8 characters long');
    expect(one).toBe('Password must be at least 8 characters long');
    expect(long).toBe('Password must be at most 1000 characters long');
    expect(rnd0).toBe('');
    expect(rnd3).toMatch(/^[A-Za-z0-9]{3}$/);
    expect(rndDef).toHaveLength(32);
  });

  for (let i = 0; i < 6; i++) {
    it(`verifyPassword wrong∥ok ∥ timingSafeEqual flood-${i}`, async () => {
      const hash = await hashPassword(`sept-flood-${i}-1`);
      const [ok, wrong, eq, ne] = await Promise.all([
        verifyPassword(`sept-flood-${i}-1`, hash),
        verifyPassword(`sept-flood-${i}-WRONG`, hash),
        Promise.resolve(timingSafeEqual(`tok-${i}`, `tok-${i}`)),
        Promise.resolve(timingSafeEqual(`tok-${i}`, `tok-${i + 1}`)),
      ]);
      expect(ok).toBe(true);
      expect(wrong).toBe(false);
      expect(eq).toBe(true);
      expect(ne).toBe(false);
    });
  }
});

describe('federation signing TOKENMAXX residual septenary leftovers after #319', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('signJson string-JWK ∥ object-JWK both verify; missing server/keyId stay false under race', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const base = { type: 'm.test', content: { path: 'sept' } };
    const [signedObj, signedStr] = await Promise.all([
      signJson(base, 'ex.com', keyId, privateKeyJwk),
      signJson({ ...base, content: { path: 'str' } }, 'ex.com', keyId, JSON.stringify(privateKeyJwk)),
    ]);
    const [okObj, okStr, missServer, missKey, cross] = await Promise.all([
      verifySignature(signedObj, 'ex.com', keyId, publicKey),
      verifySignature(signedStr, 'ex.com', keyId, publicKey),
      verifySignature(signedObj, 'other.example.com', keyId, publicKey),
      verifySignature(signedObj, 'ex.com', 'ed25519:deadbeef', publicKey),
      verifySignature(signedObj, 'ex.com', keyId, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    ]);
    expect(okObj).toBe(true);
    expect(okStr).toBe(true);
    expect(missServer).toBe(false);
    expect(missKey).toBe(false);
    expect(cross).toBe(false);
  });

  it('dual-server concurrent sign of shared base merges both; calculateContentHash non-mutates', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const base = {
      type: 'm.test',
      content: { shared: true },
      signatures: { 'keep.example.com': { 'ed25519:old': 'preserve' } },
      unsigned: { age: 9 },
    };
    const before = structuredClone(base);
    const [signedA, signedB, hash] = await Promise.all([
      signJson(base, 'a.example.com', a.keyId, a.privateKeyJwk),
      signJson(base, 'b.example.com', b.keyId, b.privateKeyJwk),
      calculateContentHash(base),
    ]);
    // Original base must not be mutated by sign/hash
    expect(base).toEqual(before);
    expect(base.signatures).toEqual({ 'keep.example.com': { 'ed25519:old': 'preserve' } });
    expect(base.unsigned).toEqual({ age: 9 });
    const merged = await signJson(signedA, 'b.example.com', b.keyId, b.privateKeyJwk);
    const sigs = merged.signatures as Record<string, Record<string, string>>;
    expect(sigs['keep.example.com']['ed25519:old']).toBe('preserve');
    expect(sigs['a.example.com'][a.keyId]).toBeTruthy();
    expect(sigs['b.example.com'][b.keyId]).toBeTruthy();
    const [okA, okB, verifyHash, hashAgain] = await Promise.all([
      verifySignature(merged, 'a.example.com', a.keyId, a.publicKey),
      verifySignature(merged, 'b.example.com', b.keyId, b.publicKey),
      verifyContentHash(base, hash),
      calculateContentHash({
        type: 'm.test',
        content: { shared: true },
        signatures: { x: { y: 'z' } },
        unsigned: { age: 1 },
      }),
    ]);
    expect(okA).toBe(true);
    expect(okB).toBe(true);
    expect(verifyHash).toBe(true);
    expect(hashAgain).toBe(hash);
    void signedB;
  });

  for (let i = 0; i < 6; i++) {
    it(`signJson∥verify missing-server∥content-hash flood-${i}`, async () => {
      const pair = await generateSigningKeyPair();
      const obj = { type: 'm.test', content: { n: i }, unsigned: { age: i } };
      const [signed, hash] = await Promise.all([
        signJson(obj, 'ex.com', pair.keyId, pair.privateKeyJwk),
        calculateContentHash(obj),
      ]);
      expect(signed.unsigned).toEqual({ age: i });
      const [ok, miss, hashOk] = await Promise.all([
        verifySignature(signed, 'ex.com', pair.keyId, pair.publicKey),
        verifySignature(signed, 'missing.example.com', pair.keyId, pair.publicKey),
        verifyContentHash(obj, hash),
      ]);
      expect(ok).toBe(true);
      expect(miss).toBe(false);
      expect(hashOk).toBe(true);
    });
  }
});

describe('crypto TOKENMAXX residual octonary leftovers after #330', () => {
  it('verifyPassword empty-pw ∥ too-few-parts ∥ empty-stored ∥ ok stay isolated under race', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = await hashPassword('octonary-ok-1');
    const [ok, emptyPw, fewParts, emptyStored, bare] = await Promise.all([
      verifyPassword('octonary-ok-1', real),
      verifyPassword('', real),
      verifyPassword('x', '$pbkdf2-sha256$100000$c2FsdA=='),
      verifyPassword('x', ''),
      verifyPassword('x', 'notahash'),
    ]);
    expect(ok).toBe(true);
    expect(emptyPw).toBe(false);
    expect(fewParts).toBe(false);
    expect(emptyStored).toBe(false);
    expect(bare).toBe(false);
    // malformed length/scheme rejects are silent (no iteration log)
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('timingSafeEqual empty/unicode ∥ sha256 empty string≡bytes ∥ hashToken under race', async () => {
    const emptyBytes = new Uint8Array();
    const [eqEmpty, neEmpty, eqUni, neUni, fromStr, fromBytes, tok] = await Promise.all([
      Promise.resolve(timingSafeEqual('', '')),
      Promise.resolve(timingSafeEqual('', 'a')),
      Promise.resolve(timingSafeEqual('café', 'café')),
      Promise.resolve(timingSafeEqual('café', 'cafe')),
      sha256(''),
      sha256(emptyBytes),
      hashToken(''),
    ]);
    expect(eqEmpty).toBe(true);
    expect(neEmpty).toBe(false);
    expect(eqUni).toBe(true);
    expect(neUni).toBe(false);
    expect(fromStr).toBe(fromBytes);
    expect(tok).toBe(fromStr);
    expect(tok).not.toMatch(/[+/=]/);
    expect(tok.length).toBeGreaterThan(0);
  });

  it('canonicalJson nested empty / boolean / Date-like plain object race stays deterministic', async () => {
    const dateLike = { toISOString: () => 'x' };
    const [nestedEmpty, bools, dateObj, emptyArrNest, keyOrder] = await Promise.all([
      Promise.resolve(canonicalJson({ a: {}, b: [] })),
      Promise.resolve(canonicalJson({ t: true, f: false })),
      Promise.resolve(canonicalJson(dateLike)),
      Promise.resolve(canonicalJson([[], {}])),
      Promise.resolve(canonicalJson({ z: {}, a: [] })),
    ]);
    expect(nestedEmpty).toBe('{"a":{},"b":[]}');
    expect(bools).toBe('{"f":false,"t":true}');
    // Date-like plain object: only own enumerable keys (toISOString function → null)
    expect(dateObj).toBe('{"toISOString":null}');
    expect(emptyArrNest).toBe('[[],{}]');
    expect(keyOrder).toBe('{"a":[],"z":{}}');
  });

  it('validatePasswordStrength exact-8 ok ∥ exact-1000 ok ∥ 1001 reject under race', async () => {
    const at8 = 'abcd1234';
    const at1000 = `${'Ab1!'.repeat(250)}`; // 1000 chars
    expect(at8).toHaveLength(8);
    expect(at1000).toHaveLength(1000);
    const [ok8, ok1000, over, short7, letterOnly] = await Promise.all([
      Promise.resolve(validatePasswordStrength(at8)),
      Promise.resolve(validatePasswordStrength(at1000)),
      Promise.resolve(validatePasswordStrength(`${at1000}x`)),
      Promise.resolve(validatePasswordStrength('abcd123')),
      Promise.resolve(validatePasswordStrength('abcdefgh')),
    ]);
    expect(ok8).toBeNull();
    expect(ok1000).toBeNull();
    expect(over).toBe('Password must be at most 1000 characters long');
    expect(short7).toBe('Password must be at least 8 characters long');
    expect(letterOnly).toBe(
      'Password must contain at least one number or special character'
    );
  });

  it('calculateContentHash signatures-only ∥ unsigned-only ∥ empty ≡ under race', async () => {
    const sigOnly = {
      signatures: { 'example.com': { 'ed25519:1': 'sig' } },
    };
    const unsignedOnly = { unsigned: { age: 1 } };
    const empty = {};
    const emptyHash = await calculateContentHash({});
    const [hSig, hUnsig, hEmpty, vSig, vUnsig, vEmpty, vCross] = await Promise.all([
      calculateContentHash(sigOnly),
      calculateContentHash(unsignedOnly),
      calculateContentHash(empty),
      verifyContentHash(sigOnly, emptyHash),
      verifyContentHash(unsignedOnly, emptyHash),
      verifyContentHash(empty, emptyHash),
      verifyContentHash({ type: 'm.x' }, emptyHash),
    ]);
    expect(hSig).toBe(hEmpty);
    expect(hUnsig).toBe(hEmpty);
    expect(hEmpty).toBe(emptyHash);
    expect(vSig).toBe(true);
    expect(vUnsig).toBe(true);
    expect(vEmpty).toBe(true);
    expect(vCross).toBe(false);
  });

  for (let i = 0; i < 6; i++) {
    it(`hashPassword∥verify wrong∥timingSafeEqual∥hashToken flood-${i}`, async () => {
      const [hash, tok, eq, ne] = await Promise.all([
        hashPassword(`oct-flood-${i}-1`),
        hashToken(`syt_oct_${i}`),
        Promise.resolve(timingSafeEqual(`id-${i}`, `id-${i}`)),
        Promise.resolve(timingSafeEqual(`id-${i}`, `id-${i}x`)),
      ]);
      const [ok, wrong] = await Promise.all([
        verifyPassword(`oct-flood-${i}-1`, hash),
        verifyPassword(`oct-flood-${i}-WRONG`, hash),
      ]);
      expect(ok).toBe(true);
      expect(wrong).toBe(false);
      expect(tok).toBe(await sha256(`syt_oct_${i}`));
      expect(eq).toBe(true);
      expect(ne).toBe(false);
    });
  }
});

describe('federation signing TOKENMAXX residual octonary leftovers after #330', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('same-server dual-keyId concurrent sign merges; both verify under race', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const base = { type: 'm.test', content: { path: 'oct-dual' } };
    const once = await signJson(base, 'ex.com', a.keyId, a.privateKeyJwk);
    const [merged, hash] = await Promise.all([
      signJson(once, 'ex.com', b.keyId, b.privateKeyJwk),
      calculateContentHash(base),
    ]);
    const sigs = merged.signatures as Record<string, Record<string, string>>;
    expect(Object.keys(sigs['ex.com']).sort()).toEqual([a.keyId, b.keyId].sort());
    const [okA, okB, miss, hashOk] = await Promise.all([
      verifySignature(merged, 'ex.com', a.keyId, a.publicKey),
      verifySignature(merged, 'ex.com', b.keyId, b.publicKey),
      verifySignature(merged, 'ex.com', 'ed25519:deadbeef', a.publicKey),
      verifyContentHash(base, hash),
    ]);
    expect(okA).toBe(true);
    expect(okB).toBe(true);
    expect(miss).toBe(false);
    expect(hashOk).toBe(true);
  });

  it('verifySignature truncated∥null-signatures∥garbage-key∥valid stay isolated under race', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson(
      { type: 'm.test', content: { ok: true } },
      'ex.com',
      keyId,
      privateKeyJwk
    );
    const truncated = {
      ...signed,
      signatures: { 'ex.com': { [keyId]: 'AA' } },
    };
    const nullSigs = {
      ...signed,
      signatures: null as unknown as Record<string, Record<string, string>>,
    };
    const [ok, trunc, nulled, garbage] = await Promise.all([
      verifySignature(signed, 'ex.com', keyId, publicKey),
      verifySignature(truncated, 'ex.com', keyId, publicKey),
      verifySignature(nullSigs, 'ex.com', keyId, publicKey),
      verifySignature(signed, 'ex.com', keyId, '!!!not-base64!!!'),
    ]);
    expect(ok).toBe(true);
    expect(trunc).toBe(false);
    expect(nulled).toBe(false);
    expect(garbage).toBe(false);
    // truncated/null may return false without throw; garbage pubkey hits catch+log
    expect(
      spy.mock.calls.some((c) => String(c[0]).includes('Signature verification failed'))
    ).toBe(true);
    spy.mockRestore();
  });

  it('signJson bad-JSON privateKey reject ∥ valid string-JWK stay isolated under race', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const base = { type: 'm.test', content: { path: 'oct-json' } };
    const [okSettled, badSettled] = await Promise.allSettled([
      signJson(base, 'ex.com', keyId, JSON.stringify(privateKeyJwk)),
      signJson(base, 'ex.com', keyId, '{not-json'),
    ]);
    expect(okSettled.status).toBe('fulfilled');
    expect(badSettled.status).toBe('rejected');
    if (okSettled.status === 'fulfilled') {
      expect(await verifySignature(okSettled.value, 'ex.com', keyId, publicKey)).toBe(true);
    }
  });

  for (let i = 0; i < 6; i++) {
    it(`signJson∥verify truncated∥content-hash flood-${i}`, async () => {
      const pair = await generateSigningKeyPair();
      const obj = { type: 'm.test', content: { n: i }, unsigned: { age: i } };
      const [signed, hash] = await Promise.all([
        signJson(obj, 'ex.com', pair.keyId, pair.privateKeyJwk),
        calculateContentHash(obj),
      ]);
      const truncated = {
        ...signed,
        signatures: {
          'ex.com': {
            [pair.keyId]: 'AA',
          },
        },
      };
      const [ok, trunc, hashOk] = await Promise.all([
        verifySignature(signed, 'ex.com', pair.keyId, pair.publicKey),
        verifySignature(truncated, 'ex.com', pair.keyId, pair.publicKey),
        verifyContentHash(obj, hash),
      ]);
      expect(ok).toBe(true);
      expect(trunc).toBe(false);
      expect(hashOk).toBe(true);
      expect(signed.unsigned).toEqual({ age: i });
    });
  }
});

describe('crypto TOKENMAXX residual nonary leftovers after #336', () => {
  it('verifyPassword wrong-scheme ∥ NaN-iter log ∥ ok stay isolated under race', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = await hashPassword('nonary-ok-1');
    const [ok, argon, bcrypt, nanIter, emptyScheme] = await Promise.all([
      verifyPassword('nonary-ok-1', real),
      verifyPassword('x', '$argon2id$100000$c2FsdA==$aGFzaA=='),
      verifyPassword('x', '$bcrypt$100000$c2FsdA==$aGFzaA=='),
      verifyPassword('x', '$pbkdf2-sha256$NaN$c2FsdA==$aGFzaA=='),
      verifyPassword('x', '$$100000$c2FsdA==$aGFzaA=='),
    ]);
    expect(ok).toBe(true);
    expect(argon).toBe(false);
    expect(bcrypt).toBe(false);
    expect(nanIter).toBe(false);
    expect(emptyScheme).toBe(false);
    const iterLogs = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('[crypto] Rejecting stored hash with invalid iteration count:'));
    // scheme mismatches are silent; only NaN iteration logs
    expect(iterLogs).toEqual([
      '[crypto] Rejecting stored hash with invalid iteration count: NaN',
    ]);
    spy.mockRestore();
  });

  it('timingSafeEqual first/last char-diff ∥ unicode combining stay isolated under race', async () => {
    const [eq, first, last, uniEq, uniNe, emptyNe] = await Promise.all([
      Promise.resolve(timingSafeEqual('abcd', 'abcd')),
      Promise.resolve(timingSafeEqual('Xbcd', 'abcd')),
      Promise.resolve(timingSafeEqual('abcX', 'abcd')),
      Promise.resolve(timingSafeEqual('e\u0301', 'e\u0301')),
      Promise.resolve(timingSafeEqual('e\u0301', 'é')), // combining vs precomposed: different code units
      Promise.resolve(timingSafeEqual('', '0')),
    ]);
    expect(eq).toBe(true);
    expect(first).toBe(false);
    expect(last).toBe(false);
    expect(uniEq).toBe(true);
    expect(uniNe).toBe(false);
    expect(emptyNe).toBe(false);
  });

  it('canonicalJson Symbol-keyed object ∥ nested holes ∥ Map-like plain stay deterministic', async () => {
    const withSym = { visible: 1, [Symbol('hidden')]: 2 };
    // Array.map skips holes; join then emits empty slots → "[1,,3]" (not null-filled)
    const sparse = [1];
    sparse.length = 3;
    sparse[2] = 3;
    const [symObj, holes, mapLike, emptySymOnly] = await Promise.all([
      Promise.resolve(canonicalJson(withSym)),
      Promise.resolve(canonicalJson(sparse)),
      Promise.resolve(canonicalJson({ size: 1, data: [] })),
      Promise.resolve(canonicalJson({ [Symbol.for('x')]: true })),
    ]);
    // Object.keys ignores Symbols
    expect(symObj).toBe('{"visible":1}');
    expect(holes).toBe('[1,,3]');
    expect(mapLike).toBe('{"data":[],"size":1}');
    expect(emptySymOnly).toBe('{}');
  });

  it('hashPassword unicode ∥ verify wrong/ok ∥ hashToken under race', async () => {
    const pw = 'pásswörd1!';
    const [hash, tok, tokAgain] = await Promise.all([
      hashPassword(pw),
      hashToken(pw),
      hashToken(pw),
    ]);
    const [ok, wrong, wrongCase] = await Promise.all([
      verifyPassword(pw, hash),
      verifyPassword('password1!', hash),
      verifyPassword('PÁSSWÖRD1!', hash),
    ]);
    expect(ok).toBe(true);
    expect(wrong).toBe(false);
    expect(wrongCase).toBe(false);
    expect(tok).toBe(tokAgain);
    expect(tok).toBe(await sha256(pw));
    expect(hash).toMatch(/^\$pbkdf2-sha256\$100000\$/);
  });

  it('calculateContentHash keeps hashes field (not stripped) under race with signatures/unsigned', async () => {
    const withHashes = {
      type: 'm.test',
      content: { body: 'x' },
      hashes: { sha256: 'keep-me' },
    };
    const withSig = {
      type: 'm.test',
      content: { body: 'x' },
      hashes: { sha256: 'keep-me' },
      signatures: { 'example.com': { 'ed25519:1': 'sig' } },
      unsigned: { age: 1 },
    };
    const withoutHashes = { type: 'm.test', content: { body: 'x' } };
    const expected = await calculateContentHash(withHashes);
    const [hKeep, hStrip, hBare, vKeep, vBare] = await Promise.all([
      calculateContentHash(withHashes),
      calculateContentHash(withSig),
      calculateContentHash(withoutHashes),
      verifyContentHash(withHashes, expected),
      verifyContentHash(withoutHashes, expected),
    ]);
    // signatures/unsigned stripped → same as hashes-only body
    expect(hKeep).toBe(hStrip);
    expect(hKeep).toBe(expected);
    // hashes is hashed (not stripped) → differs from bare body
    expect(hKeep).not.toBe(hBare);
    expect(vKeep).toBe(true);
    expect(vBare).toBe(false);
  });

  for (let i = 0; i < 6; i++) {
    it(`hashPassword∥verify∥timingSafeEqual∥canonicalJson flood-${i}`, async () => {
      const [hash, eq, ne, canon] = await Promise.all([
        hashPassword(`non-flood-${i}-1`),
        Promise.resolve(timingSafeEqual(`n-${i}`, `n-${i}`)),
        Promise.resolve(timingSafeEqual(`n-${i}`, `n-${i}!`)),
        Promise.resolve(canonicalJson({ i, nest: { z: i, a: i } })),
      ]);
      const [ok, wrong] = await Promise.all([
        verifyPassword(`non-flood-${i}-1`, hash),
        verifyPassword(`non-flood-${i}-WRONG`, hash),
      ]);
      expect(ok).toBe(true);
      expect(wrong).toBe(false);
      expect(eq).toBe(true);
      expect(ne).toBe(false);
      expect(canon).toBe(`{"i":${i},"nest":{"a":${i},"z":${i}}}`);
    });
  }
});

describe('federation signing TOKENMAXX residual nonary leftovers after #336', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('legacy string privateKey ∥ object-JWK concurrent sign both verify under race', async () => {
    const legacy = await generateSigningKeyPairLegacy();
    const modern = await generateSigningKeyPair();
    const base = { type: 'm.test', content: { path: 'non-legacy' } };
    const [signedLegacy, signedModern, hash] = await Promise.all([
      signJson(base, 'legacy.example.com', legacy.keyId, legacy.privateKey),
      signJson(base, 'modern.example.com', modern.keyId, modern.privateKeyJwk),
      calculateContentHash(base),
    ]);
    const [okL, okM, miss, hashOk] = await Promise.all([
      verifySignature(signedLegacy, 'legacy.example.com', legacy.keyId, legacy.publicKey),
      verifySignature(signedModern, 'modern.example.com', modern.keyId, modern.publicKey),
      verifySignature(signedLegacy, 'modern.example.com', modern.keyId, modern.publicKey),
      verifyContentHash(base, hash),
    ]);
    expect(okL).toBe(true);
    expect(okM).toBe(true);
    expect(miss).toBe(false);
    expect(hashOk).toBe(true);
  });

  it('empty signatures {} merge ∥ re-sign same keyId overwrites under race', async () => {
    const pair = await generateSigningKeyPair();
    const base = {
      type: 'm.test',
      content: { path: 'non-empty-sigs' },
      signatures: {},
    };
    const once = await signJson(base, 'ex.com', pair.keyId, pair.privateKeyJwk);
    const twice = await signJson(
      { ...once, content: { path: 'non-empty-sigs', v: 2 } },
      'ex.com',
      pair.keyId,
      pair.privateKeyJwk
    );
    const sigsOnce = once.signatures as Record<string, Record<string, string>>;
    const sigsTwice = twice.signatures as Record<string, Record<string, string>>;
    expect(Object.keys(sigsOnce['ex.com'])).toEqual([pair.keyId]);
    expect(Object.keys(sigsTwice['ex.com'])).toEqual([pair.keyId]);
    const [okOnce, okTwiceOnOnceBody, okTwice] = await Promise.all([
      verifySignature(once, 'ex.com', pair.keyId, pair.publicKey),
      verifySignature(
        { ...once, content: { path: 'non-empty-sigs', v: 2 }, signatures: once.signatures },
        'ex.com',
        pair.keyId,
        pair.publicKey
      ),
      verifySignature(twice, 'ex.com', pair.keyId, pair.publicKey),
    ]);
    expect(okOnce).toBe(true);
    expect(okTwiceOnOnceBody).toBe(false); // body changed, old sig
    expect(okTwice).toBe(true);
    expect(sigsOnce['ex.com'][pair.keyId]).not.toBe(sigsTwice['ex.com'][pair.keyId]);
  });

  it('verifySignature truncated pubkey ∥ empty server map ∥ valid stay isolated under race', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson(
      { type: 'm.test', content: { ok: true } },
      'ex.com',
      keyId,
      privateKeyJwk
    );
    const emptyServer = {
      ...signed,
      signatures: { 'ex.com': {} },
    };
    const truncPub = publicKey.slice(0, 8);
    const [ok, emptyMap, trunc] = await Promise.all([
      verifySignature(signed, 'ex.com', keyId, publicKey),
      verifySignature(emptyServer, 'ex.com', keyId, publicKey),
      verifySignature(signed, 'ex.com', keyId, truncPub),
    ]);
    expect(ok).toBe(true);
    expect(emptyMap).toBe(false);
    expect(trunc).toBe(false);
    expect(
      spy.mock.calls.some((c) => String(c[0]).includes('Signature verification failed'))
    ).toBe(true);
    spy.mockRestore();
  });

  for (let i = 0; i < 6; i++) {
    it(`legacy∥modern signJson∥verify∥content-hash flood-${i}`, async () => {
      const legacy = await generateSigningKeyPairLegacy();
      const obj = { type: 'm.test', content: { n: i }, unsigned: { age: i } };
      const [signed, hash] = await Promise.all([
        signJson(obj, 'ex.com', legacy.keyId, legacy.privateKey),
        calculateContentHash(obj),
      ]);
      const [ok, miss, hashOk] = await Promise.all([
        verifySignature(signed, 'ex.com', legacy.keyId, legacy.publicKey),
        verifySignature(signed, 'other.example.com', legacy.keyId, legacy.publicKey),
        verifyContentHash(obj, hash),
      ]);
      expect(ok).toBe(true);
      expect(miss).toBe(false);
      expect(hashOk).toBe(true);
      expect(signed.unsigned).toEqual({ age: i });
    });
  }
});

describe('crypto TOKENMAXX residual denary leftovers after #356', () => {
  it('verifyPassword wrong-hash ∥ extra-parts ∥ ok stay isolated under race', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = await hashPassword('denary-ok-1');
    const parts = real.split('$');
    // Valid format + salt but wrong digest → false without iteration log
    const wrongDigest = `$pbkdf2-sha256$100000$${parts[3]}$YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=`;
    const extraParts = `${real}$extra`;
    const [ok, wrong, extra, few] = await Promise.all([
      verifyPassword('denary-ok-1', real),
      verifyPassword('denary-ok-1', wrongDigest),
      verifyPassword('denary-ok-1', extraParts),
      verifyPassword('x', '$pbkdf2-sha256$100000$only'),
    ]);
    expect(ok).toBe(true);
    expect(wrong).toBe(false);
    expect(extra).toBe(false);
    expect(few).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('timingSafeEqual mid-char diff ∥ equal long ∥ length-mismatch under race', async () => {
    const long = 'a'.repeat(64);
    const mid = 'a'.repeat(31) + 'X' + 'a'.repeat(32);
    const [eq, midNe, shortNe, emptyEq] = await Promise.all([
      Promise.resolve(timingSafeEqual(long, long)),
      Promise.resolve(timingSafeEqual(long, mid)),
      Promise.resolve(timingSafeEqual(long, long.slice(0, 63))),
      Promise.resolve(timingSafeEqual('', '')),
    ]);
    expect(eq).toBe(true);
    expect(midNe).toBe(false);
    expect(shortNe).toBe(false);
    expect(emptyEq).toBe(true);
  });

  it('canonicalJson undefined-value keys ∥ nested null ∥ empty string stay deterministic', async () => {
    const [undefKey, nestedNull, emptyStr, numZero] = await Promise.all([
      Promise.resolve(canonicalJson({ a: undefined, b: 1 })),
      Promise.resolve(canonicalJson({ z: { y: null }, a: [] })),
      Promise.resolve(canonicalJson({ '': 1, a: '' })),
      Promise.resolve(canonicalJson({ n: 0, f: false })),
    ]);
    expect(undefKey).toBe('{"a":null,"b":1}');
    expect(nestedNull).toBe('{"a":[],"z":{"y":null}}');
    expect(emptyStr).toBe('{"":1,"a":""}');
    expect(numZero).toBe('{"f":false,"n":0}');
  });

  it('validatePasswordStrength digit-only ∥ special-only ∥ letter+digit under race', async () => {
    const [digits, specials, ok, short, empty] = await Promise.all([
      Promise.resolve(validatePasswordStrength('12345678')),
      Promise.resolve(validatePasswordStrength('!!!!!!!!')),
      Promise.resolve(validatePasswordStrength('abcde123')),
      Promise.resolve(validatePasswordStrength('a1')),
      Promise.resolve(validatePasswordStrength('')),
    ]);
    expect(digits).toBe('Password must contain at least one letter');
    expect(specials).toBe('Password must contain at least one letter');
    expect(ok).toBeNull();
    expect(short).toBe('Password must be at least 8 characters long');
    expect(empty).toBe('Password must be at least 8 characters long');
  });

  it('calculateContentHash nested mutate-isolation ∥ verify false under race', async () => {
    const body = { type: 'm.test', content: { nest: { v: 1 } }, unsigned: { age: 1 } };
    const before = structuredClone(body);
    const hash = await calculateContentHash(body);
    const mutated = { type: 'm.test', content: { nest: { v: 2 } } };
    const [h1, h2, vOk, vBad, still] = await Promise.all([
      calculateContentHash(body),
      calculateContentHash(mutated),
      verifyContentHash(body, hash),
      verifyContentHash(mutated, hash),
      Promise.resolve(structuredClone(body)),
    ]);
    expect(h1).toBe(hash);
    expect(h2).not.toBe(hash);
    expect(vOk).toBe(true);
    expect(vBad).toBe(false);
    expect(body).toEqual(before);
    expect(still).toEqual(before);
  });

  for (let i = 0; i < 6; i++) {
    it(`hashPassword∥verify wrong-digest∥timingSafeEqual∥hashToken flood-${i}`, async () => {
      const [hash, tok, eq] = await Promise.all([
        hashPassword(`den-flood-${i}-1`),
        hashToken(`syt_den_${i}`),
        Promise.resolve(timingSafeEqual(`d-${i}`, `d-${i}`)),
      ]);
      const parts = hash.split('$');
      const wrongDigest = `$pbkdf2-sha256$100000$${parts[3]}$YmFkZGlnZXN0YmFkZGlnZXN0YmFkZGlnZXN0YmE=`;
      const [ok, wrong] = await Promise.all([
        verifyPassword(`den-flood-${i}-1`, hash),
        verifyPassword(`den-flood-${i}-1`, wrongDigest),
      ]);
      expect(ok).toBe(true);
      expect(wrong).toBe(false);
      expect(tok).toBe(await sha256(`syt_den_${i}`));
      expect(eq).toBe(true);
    });
  }
});

describe('federation signing TOKENMAXX residual denary leftovers after #356', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('signJson preserves other-server sigs ∥ wrong keyId verify false under race', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const base = {
      type: 'm.test',
      content: { path: 'den-preserve' },
      signatures: { 'keep.example.com': { 'ed25519:old': 'preserve-me' } },
      unsigned: { age: 3 },
    };
    const signed = await signJson(base, 'a.example.com', a.keyId, a.privateKeyJwk);
    const sigs = signed.signatures as Record<string, Record<string, string>>;
    expect(sigs['keep.example.com']['ed25519:old']).toBe('preserve-me');
    expect(signed.unsigned).toEqual({ age: 3 });
    const [ok, wrongKey, missServer, hashOk] = await Promise.all([
      verifySignature(signed, 'a.example.com', a.keyId, a.publicKey),
      verifySignature(signed, 'a.example.com', b.keyId, a.publicKey),
      verifySignature(signed, 'b.example.com', b.keyId, b.publicKey),
      verifyContentHash(base, await calculateContentHash(base)),
    ]);
    expect(ok).toBe(true);
    expect(wrongKey).toBe(false);
    expect(missServer).toBe(false);
    expect(hashOk).toBe(true);
  });

  it('verifySignature missing signatures field ∥ empty object ∥ valid under race', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson(
      { type: 'm.test', content: { ok: true } },
      'ex.com',
      keyId,
      privateKeyJwk
    );
    const noSigs = { type: 'm.test', content: { ok: true } };
    const emptySigs = { ...signed, signatures: {} };
    const [ok, missing, empty] = await Promise.all([
      verifySignature(signed, 'ex.com', keyId, publicKey),
      verifySignature(noSigs, 'ex.com', keyId, publicKey),
      verifySignature(emptySigs, 'ex.com', keyId, publicKey),
    ]);
    expect(ok).toBe(true);
    expect(missing).toBe(false);
    expect(empty).toBe(false);
  });

  it('legacy string-JWK re-sign same keyId overwrites; body/sig mismatch fails under race', async () => {
    const legacy = await generateSigningKeyPairLegacy();
    const v1 = { type: 'm.test', content: { v: 1 } };
    const once = await signJson(v1, 'ex.com', legacy.keyId, legacy.privateKey);
    const v2 = { ...once, content: { v: 2 } };
    const twice = await signJson(v2, 'ex.com', legacy.keyId, legacy.privateKey);
    const [okOnce, okTwice, oldSigNewBody, newSigOldBody] = await Promise.all([
      verifySignature(once, 'ex.com', legacy.keyId, legacy.publicKey),
      verifySignature(twice, 'ex.com', legacy.keyId, legacy.publicKey),
      verifySignature(
        { ...once, content: { v: 2 } },
        'ex.com',
        legacy.keyId,
        legacy.publicKey
      ),
      verifySignature(
        { ...twice, content: { v: 1 } },
        'ex.com',
        legacy.keyId,
        legacy.publicKey
      ),
    ]);
    expect(okOnce).toBe(true);
    expect(okTwice).toBe(true);
    expect(oldSigNewBody).toBe(false);
    expect(newSigOldBody).toBe(false);
    const sigsOnce = once.signatures as Record<string, Record<string, string>>;
    const sigsTwice = twice.signatures as Record<string, Record<string, string>>;
    expect(sigsOnce['ex.com'][legacy.keyId]).not.toBe(sigsTwice['ex.com'][legacy.keyId]);
  });

  for (let i = 0; i < 6; i++) {
    it(`signJson∥wrong-keyId∥missing-server∥content-hash flood-${i}`, async () => {
      const pair = await generateSigningKeyPair();
      const other = await generateSigningKeyPair();
      const obj = { type: 'm.test', content: { n: i }, unsigned: { age: i } };
      const [signed, hash] = await Promise.all([
        signJson(obj, 'ex.com', pair.keyId, pair.privateKeyJwk),
        calculateContentHash(obj),
      ]);
      const [ok, wrongKey, miss, hashOk] = await Promise.all([
        verifySignature(signed, 'ex.com', pair.keyId, pair.publicKey),
        verifySignature(signed, 'ex.com', other.keyId, pair.publicKey),
        verifySignature(signed, 'missing.example.com', pair.keyId, pair.publicKey),
        verifyContentHash(obj, hash),
      ]);
      expect(ok).toBe(true);
      expect(wrongKey).toBe(false);
      expect(miss).toBe(false);
      expect(hashOk).toBe(true);
      expect(signed.unsigned).toEqual({ age: i });
    });
  }
});

describe('crypto TOKENMAXX residual duodenary leftovers after #380', () => {
  it('verifyPassword wrong-scheme ∥ iters-too-low ∥ ok stay isolated under race', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = await hashPassword('duodenary-ok-1');
    const parts = real.split('$');
    const wrongScheme = `$pbkdf2-sha1$100000$${parts[3]}$${parts[4]}`;
    const lowIters = `$pbkdf2-sha256$99999$${parts[3]}$${parts[4]}`;
    const [ok, schemeBad, low, emptyPw] = await Promise.all([
      verifyPassword('duodenary-ok-1', real),
      verifyPassword('duodenary-ok-1', wrongScheme),
      verifyPassword('duodenary-ok-1', lowIters),
      verifyPassword('', real),
    ]);
    expect(ok).toBe(true);
    expect(schemeBad).toBe(false);
    expect(low).toBe(false);
    expect(emptyPw).toBe(false);
    expect(
      spy.mock.calls.some((c) => String(c[0]).includes('invalid iteration count'))
    ).toBe(true);
    spy.mockRestore();
  });

  it('timingSafeEqual last-char diff ∥ leading space ∥ equal under race', async () => {
    const base = 'pqrs';
    const [eq, last, lead, emptyNe, longEq] = await Promise.all([
      Promise.resolve(timingSafeEqual(base, base)),
      Promise.resolve(timingSafeEqual('pqrX', base)),
      Promise.resolve(timingSafeEqual(' pqrs', base)),
      Promise.resolve(timingSafeEqual('', 'a')),
      Promise.resolve(timingSafeEqual('Ω'.repeat(16), 'Ω'.repeat(16))),
    ]);
    expect(eq).toBe(true);
    expect(last).toBe(false);
    expect(lead).toBe(false);
    expect(emptyNe).toBe(false);
    expect(longEq).toBe(true);
  });

  it('canonicalJson unicode keys ∥ mixed primitives ∥ empty array stay deterministic', async () => {
    const [uni, mixed, emptyArr, boolTop] = await Promise.all([
      Promise.resolve(canonicalJson({ ζ: 1, α: 2, a: 3 })),
      Promise.resolve(canonicalJson({ z: [null, false, 0, ''], a: true })),
      Promise.resolve(canonicalJson({ items: [] })),
      Promise.resolve(canonicalJson(false)),
    ]);
    expect(uni).toBe('{"a":3,"α":2,"ζ":1}');
    expect(mixed).toBe('{"a":true,"z":[null,false,0,""]}');
    expect(emptyArr).toBe('{"items":[]}');
    expect(boolTop).toBe('false');
  });

  it('validatePasswordStrength exact-1000 ok ∥ 1001 fail ∥ digit+letter under race', async () => {
    const at1000 = 'a1' + 'x'.repeat(998);
    const over1000 = 'a1' + 'x'.repeat(999);
    const [at, over, digitLetter, shortSym, empty] = await Promise.all([
      Promise.resolve(validatePasswordStrength(at1000)),
      Promise.resolve(validatePasswordStrength(over1000)),
      Promise.resolve(validatePasswordStrength('Abcd1234')),
      Promise.resolve(validatePasswordStrength('!!!!!!!')),
      Promise.resolve(validatePasswordStrength('')),
    ]);
    expect(at1000).toHaveLength(1000);
    expect(over1000).toHaveLength(1001);
    expect(at).toBeNull();
    expect(over).toBe('Password must be at most 1000 characters long');
    expect(digitLetter).toBeNull();
    expect(shortSym).toBe('Password must be at least 8 characters long');
    expect(empty).toBe('Password must be at least 8 characters long');
  });

  it('calculateContentHash type-mutate ∥ unsigned-strip equality under race', async () => {
    const body = { type: 'm.test', content: { v: 1 }, unsigned: { age: 2 } };
    const stripped = { type: 'm.test', content: { v: 1 } };
    const typed = { type: 'm.other', content: { v: 1 } };
    const expected = await calculateContentHash(body);
    const [hBody, hStrip, hTyped, vOk, vTyped] = await Promise.all([
      calculateContentHash(body),
      calculateContentHash(stripped),
      calculateContentHash(typed),
      verifyContentHash(body, expected),
      verifyContentHash(typed, expected),
    ]);
    expect(hBody).toBe(hStrip);
    expect(hBody).toBe(expected);
    expect(hTyped).not.toBe(expected);
    expect(vOk).toBe(true);
    expect(vTyped).toBe(false);
  });

  for (let i = 0; i < 6; i++) {
    it(`hashPassword∥verify low-iters∥timingSafeEqual∥hashToken flood-${i}`, async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const [hash, tok, eq] = await Promise.all([
        hashPassword(`duo-flood-${i}-1`),
        hashToken(`syt_duo_${i}`),
        Promise.resolve(timingSafeEqual(`duo-${i}`, `duo-${i}`)),
      ]);
      const parts = hash.split('$');
      const lowIters = `$pbkdf2-sha256$99999$${parts[3]}$${parts[4]}`;
      const [ok, low] = await Promise.all([
        verifyPassword(`duo-flood-${i}-1`, hash),
        verifyPassword(`duo-flood-${i}-1`, lowIters),
      ]);
      expect(ok).toBe(true);
      expect(low).toBe(false);
      expect(tok).toBe(await sha256(`syt_duo_${i}`));
      expect(eq).toBe(true);
      expect(
        spy.mock.calls.some((c) => String(c[0]).includes('invalid iteration count'))
      ).toBe(true);
      spy.mockRestore();
    });
  }
});

describe('federation signing TOKENMAXX residual duodenary leftovers after #380', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('cross-server dual sign ∥ wrong server pubkey false under race', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const base = { type: 'm.test', content: { path: 'duo-cross' }, unsigned: { age: 4 } };
    const once = await signJson(base, 'a.example.com', a.keyId, a.privateKeyJwk);
    const twice = await signJson(once, 'b.example.com', b.keyId, b.privateKeyJwk);
    const sigs = twice.signatures as Record<string, Record<string, string>>;
    expect(Object.keys(sigs).sort()).toEqual(['a.example.com', 'b.example.com']);
    expect(twice.unsigned).toEqual({ age: 4 });
    const [okA, okB, wrongServer, miss] = await Promise.all([
      verifySignature(twice, 'a.example.com', a.keyId, a.publicKey),
      verifySignature(twice, 'b.example.com', b.keyId, b.publicKey),
      verifySignature(twice, 'a.example.com', a.keyId, b.publicKey),
      verifySignature(twice, 'c.example.com', a.keyId, a.publicKey),
    ]);
    expect(okA).toBe(true);
    expect(okB).toBe(true);
    expect(wrongServer).toBe(false);
    expect(miss).toBe(false);
  });

  it('verifySignature truncated sig ∥ valid ∥ empty keyId map stay isolated under race', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson(
      { type: 'm.test', content: { ok: true } },
      'ex.com',
      keyId,
      privateKeyJwk
    );
    const truncated = {
      ...signed,
      signatures: { 'ex.com': { [keyId]: 'YQ' } }, // too-short base64url → verify false (may or may not log)
    };
    const emptyKeyMap = { ...signed, signatures: { 'ex.com': {} } };
    const garbage = {
      ...signed,
      signatures: { 'ex.com': { [keyId]: '!!!not-valid-b64!!!' } },
    };
    const [ok, trunc, emptyMap, garb] = await Promise.all([
      verifySignature(signed, 'ex.com', keyId, publicKey),
      verifySignature(truncated, 'ex.com', keyId, publicKey),
      verifySignature(emptyKeyMap, 'ex.com', keyId, publicKey),
      verifySignature(garbage, 'ex.com', keyId, publicKey),
    ]);
    expect(ok).toBe(true);
    expect(trunc).toBe(false);
    expect(emptyMap).toBe(false);
    expect(garb).toBe(false);
    expect(
      spy.mock.calls.some((c) => String(c[0]).includes('Signature verification failed'))
    ).toBe(true);
    spy.mockRestore();
  });

  it('type mutate after sign fails; signatures field mutate fails under race', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson(
      { type: 'm.test', content: { v: 1 }, unsigned: { age: 1 } },
      'ex.com',
      keyId,
      privateKeyJwk
    );
    const origSig = (signed.signatures as Record<string, Record<string, string>>)['ex.com'][keyId];
    const flipped = (origSig.endsWith('A') ? 'B' : 'A') + origSig.slice(1);
    const typeMut = { ...signed, type: 'm.other' };
    const sigMut = {
      ...signed,
      signatures: { 'ex.com': { [keyId]: flipped } },
    };
    const [okOrig, badType, badSig, hashOk] = await Promise.all([
      verifySignature(signed, 'ex.com', keyId, publicKey),
      verifySignature(typeMut, 'ex.com', keyId, publicKey),
      verifySignature(sigMut, 'ex.com', keyId, publicKey),
      verifyContentHash(
        { type: 'm.test', content: { v: 1 } },
        await calculateContentHash({ type: 'm.test', content: { v: 1 }, unsigned: { age: 1 } })
      ),
    ]);
    expect(okOrig).toBe(true);
    expect(badType).toBe(false);
    expect(badSig).toBe(false);
    expect(hashOk).toBe(true);
    expect(flipped).not.toBe(origSig);
    spy.mockRestore();
  });

  for (let i = 0; i < 6; i++) {
    it(`cross-server∥wrong-pub∥missing-server∥content-hash flood-${i}`, async () => {
      const a = await generateSigningKeyPair();
      const b = await generateSigningKeyPair();
      const obj = { type: 'm.test', content: { n: i }, unsigned: { age: i } };
      const once = await signJson(obj, 'a.example.com', a.keyId, a.privateKeyJwk);
      const [twice, hash] = await Promise.all([
        signJson(once, 'b.example.com', b.keyId, b.privateKeyJwk),
        calculateContentHash(obj),
      ]);
      const [okA, okB, wrongPub, miss, hashOk] = await Promise.all([
        verifySignature(twice, 'a.example.com', a.keyId, a.publicKey),
        verifySignature(twice, 'b.example.com', b.keyId, b.publicKey),
        verifySignature(twice, 'a.example.com', a.keyId, b.publicKey),
        verifySignature(twice, 'gone.example.com', a.keyId, a.publicKey),
        verifyContentHash(obj, hash),
      ]);
      expect(okA).toBe(true);
      expect(okB).toBe(true);
      expect(wrongPub).toBe(false);
      expect(miss).toBe(false);
      expect(hashOk).toBe(true);
      expect(twice.unsigned).toEqual({ age: i });
    });
  }
});

describe('crypto TOKENMAXX residual tridecenary leftovers after #395', () => {
  it('verifyPassword wrong-salt ∥ empty-digest ∥ ok stay isolated under race', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = await hashPassword('tridecenary-ok-1');
    const parts = real.split('$');
    // Valid scheme+iters+digest shape but different salt → false (silent; digest mismatch)
    const wrongSalt = `$pbkdf2-sha256$100000$${btoa('salt-salt-salt!!')}$${parts[4]}`;
    const emptyDigest = `$pbkdf2-sha256$100000$${parts[3]}$`;
    const [ok, saltBad, emptyDig, emptyStored] = await Promise.all([
      verifyPassword('tridecenary-ok-1', real),
      verifyPassword('tridecenary-ok-1', wrongSalt),
      verifyPassword('tridecenary-ok-1', emptyDigest),
      verifyPassword('tridecenary-ok-1', ''),
    ]);
    expect(ok).toBe(true);
    expect(saltBad).toBe(false);
    expect(emptyDig).toBe(false);
    expect(emptyStored).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('timingSafeEqual second-char diff ∥ trailing space ∥ equal under race', async () => {
    const [eq, second, trail, longEq, longNe] = await Promise.all([
      Promise.resolve(timingSafeEqual('wxyz', 'wxyz')),
      Promise.resolve(timingSafeEqual('wXyz', 'wxyz')),
      Promise.resolve(timingSafeEqual('wxyz ', 'wxyz')),
      Promise.resolve(timingSafeEqual('ü'.repeat(32), 'ü'.repeat(32))),
      Promise.resolve(timingSafeEqual('ü'.repeat(32), 'ü'.repeat(31) + 'ú')),
    ]);
    expect(eq).toBe(true);
    expect(second).toBe(false);
    expect(trail).toBe(false);
    expect(longEq).toBe(true);
    expect(longNe).toBe(false);
  });

  it('canonicalJson nested array-of-objects key-sort ∥ empty nest stay deterministic', async () => {
    const [nested, emptyNest, arrPrim, deep] = await Promise.all([
      Promise.resolve(
        canonicalJson({
          z: [{ b: 2, a: 1 }, { d: 4, c: 3 }],
          a: [],
        })
      ),
      Promise.resolve(canonicalJson({ outer: { inner: {} } })),
      Promise.resolve(canonicalJson([true, false, null, 0])),
      Promise.resolve(canonicalJson({ a: { b: { c: { z: 1, a: 2 } } } })),
    ]);
    expect(nested).toBe('{"a":[],"z":[{"a":1,"b":2},{"c":3,"d":4}]}');
    expect(emptyNest).toBe('{"outer":{"inner":{}}}');
    expect(arrPrim).toBe('[true,false,null,0]');
    expect(deep).toBe('{"a":{"b":{"c":{"a":2,"z":1}}}}');
  });

  it('validatePasswordStrength letter+symbol ok ∥ letter-only ∥ whitespace-short under race', async () => {
    const [symOk, letterOnly, spaces, over, exact8] = await Promise.all([
      Promise.resolve(validatePasswordStrength('abcdefg!')),
      Promise.resolve(validatePasswordStrength('abcdefgh')),
      Promise.resolve(validatePasswordStrength('   a1   ')), // length 8 but spaces count; has letter+digit
      Promise.resolve(validatePasswordStrength('a1' + 'x'.repeat(999))), // 1001
      Promise.resolve(validatePasswordStrength('abcdef1!')),
    ]);
    expect(symOk).toBeNull();
    expect(letterOnly).toBe('Password must contain at least one number or special character');
    expect(spaces).toBeNull(); // '   a1   ' is length 8 with letter+digit
    expect(over).toBe('Password must be at most 1000 characters long');
    expect(exact8).toBeNull();
  });

  it('calculateContentHash empty≡sigs-stripped ∥ wrong expected verify false under race', async () => {
    const bare = {};
    const withSigs = {
      signatures: { 'example.com': { 'ed25519:1': 'sig' } },
      unsigned: { age: 9 },
    };
    const withBody = { type: 'm.test', content: { v: 1 } };
    const expectedBare = await calculateContentHash(bare);
    const [hBare, hSigs, hBody, vBare, vWrong] = await Promise.all([
      calculateContentHash(bare),
      calculateContentHash(withSigs),
      calculateContentHash(withBody),
      verifyContentHash(bare, expectedBare),
      verifyContentHash(withBody, expectedBare),
    ]);
    expect(hBare).toBe(hSigs);
    expect(hBare).toBe(expectedBare);
    expect(hBody).not.toBe(hBare);
    expect(vBare).toBe(true);
    expect(vWrong).toBe(false);
  });

  for (let i = 0; i < 6; i++) {
    it(`hashPassword∥verify wrong-salt∥timingSafeEqual∥hashToken flood-${i}`, async () => {
      const [hash, tok, eq] = await Promise.all([
        hashPassword(`tri-flood-${i}-1`),
        hashToken(`syt_tri_${i}`),
        Promise.resolve(timingSafeEqual(`t-${i}`, `t-${i}`)),
      ]);
      const parts = hash.split('$');
      const wrongSalt = `$pbkdf2-sha256$100000$${btoa(`salt-${i}-pad!!!!`)}$${parts[4]}`;
      const [ok, saltBad] = await Promise.all([
        verifyPassword(`tri-flood-${i}-1`, hash),
        verifyPassword(`tri-flood-${i}-1`, wrongSalt),
      ]);
      expect(ok).toBe(true);
      expect(saltBad).toBe(false);
      expect(tok).toBe(await sha256(`syt_tri_${i}`));
      expect(eq).toBe(true);
    });
  }
});

describe('federation signing TOKENMAXX residual tridecenary leftovers after #395', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('same-server dual-keyId merge ∥ wrong pubkey for right keyId false under race', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const base = { type: 'm.test', content: { path: 'tri-dual' }, unsigned: { age: 1 } };
    const once = await signJson(base, 'ex.com', a.keyId, a.privateKeyJwk);
    const twice = await signJson(once, 'ex.com', b.keyId, b.privateKeyJwk);
    const sigs = twice.signatures as Record<string, Record<string, string>>;
    expect(Object.keys(sigs['ex.com']).sort()).toEqual([a.keyId, b.keyId].sort());
    expect(twice.unsigned).toEqual({ age: 1 });
    const [okA, okB, wrongPubA, miss] = await Promise.all([
      verifySignature(twice, 'ex.com', a.keyId, a.publicKey),
      verifySignature(twice, 'ex.com', b.keyId, b.publicKey),
      verifySignature(twice, 'ex.com', a.keyId, b.publicKey),
      verifySignature(twice, 'other.example.com', a.keyId, a.publicKey),
    ]);
    expect(okA).toBe(true);
    expect(okB).toBe(true);
    expect(wrongPubA).toBe(false);
    expect(miss).toBe(false);
  });

  it('verifySignature garbage sig bytes ∥ valid ∥ missing keyId stay isolated under race', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson(
      { type: 'm.test', content: { ok: true } },
      'ex.com',
      keyId,
      privateKeyJwk
    );
    const garbage = {
      ...signed,
      signatures: { 'ex.com': { [keyId]: '!!!not-valid-b64!!!' } },
    };
    const [ok, garb, missKey] = await Promise.all([
      verifySignature(signed, 'ex.com', keyId, publicKey),
      verifySignature(garbage, 'ex.com', keyId, publicKey),
      verifySignature(signed, 'ex.com', 'ed25519:deadbeef', publicKey),
    ]);
    expect(ok).toBe(true);
    expect(garb).toBe(false);
    expect(missKey).toBe(false);
    expect(
      spy.mock.calls.some((c) => String(c[0]).includes('Signature verification failed'))
    ).toBe(true);
    spy.mockRestore();
  });

  it('unsigned mutate after sign still verifies; content mutate fails under race', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson(
      { type: 'm.test', content: { v: 1 }, unsigned: { age: 1 } },
      'ex.com',
      keyId,
      privateKeyJwk
    );
    const unsignedMut = { ...signed, unsigned: { age: 99, txn_id: 'x' } };
    const contentMut = { ...signed, content: { v: 2 } };
    const [okOrig, okUnsigned, badContent, hashOk] = await Promise.all([
      verifySignature(signed, 'ex.com', keyId, publicKey),
      verifySignature(unsignedMut, 'ex.com', keyId, publicKey),
      verifySignature(contentMut, 'ex.com', keyId, publicKey),
      verifyContentHash(
        { type: 'm.test', content: { v: 1 } },
        await calculateContentHash({ type: 'm.test', content: { v: 1 }, unsigned: { age: 1 } })
      ),
    ]);
    expect(okOrig).toBe(true);
    expect(okUnsigned).toBe(true);
    expect(badContent).toBe(false);
    expect(hashOk).toBe(true);
  });

  for (let i = 0; i < 6; i++) {
    it(`dual-keyId∥wrong-pub∥missing-server∥content-hash flood-${i}`, async () => {
      const a = await generateSigningKeyPair();
      const b = await generateSigningKeyPair();
      const obj = { type: 'm.test', content: { n: i }, unsigned: { age: i } };
      const once = await signJson(obj, 'ex.com', a.keyId, a.privateKeyJwk);
      const [twice, hash] = await Promise.all([
        signJson(once, 'ex.com', b.keyId, b.privateKeyJwk),
        calculateContentHash(obj),
      ]);
      const [okA, okB, wrongPub, miss, hashOk] = await Promise.all([
        verifySignature(twice, 'ex.com', a.keyId, a.publicKey),
        verifySignature(twice, 'ex.com', b.keyId, b.publicKey),
        verifySignature(twice, 'ex.com', a.keyId, b.publicKey),
        verifySignature(twice, 'gone.example.com', a.keyId, a.publicKey),
        verifyContentHash(obj, hash),
      ]);
      expect(okA).toBe(true);
      expect(okB).toBe(true);
      expect(wrongPub).toBe(false);
      expect(miss).toBe(false);
      expect(hashOk).toBe(true);
      expect(twice.unsigned).toEqual({ age: i });
    });
  }
});
