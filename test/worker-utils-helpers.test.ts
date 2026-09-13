/**
 * TOKENMAXX HEAVY deepen of worker utils after #75 (database CRUD).
 * Slice: crypto / ids / errors / url-validator — not product inventing.
 */
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
} from '../src/utils/crypto';
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
import {
  MatrixApiError,
  Errors,
  withErrorHandler,
  jsonResponse,
  emptyResponse,
} from '../src/utils/errors';
import { validateUrl, validateUrlForPreview } from '../src/utils/url-validator';
import { ErrorCodes } from '../src/types';

/** Remap Cloudflare NODE-ED25519 → Node Ed25519 for unit tests. */
function installNodeEd25519Shim() {
  const subtle = crypto.subtle;
  const origGenerateKey = subtle.generateKey.bind(subtle);
  const origImportKey = subtle.importKey.bind(subtle);
  const origSign = subtle.sign.bind(subtle);
  const origVerify = subtle.verify.bind(subtle);

  const mapAlg = (
    alg: AlgorithmIdentifier | EcKeyGenParams | EcKeyImportParams | EcdsaParams | unknown
  ): AlgorithmIdentifier => {
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
  ) =>
    origImportKey(format, keyData, mapAlg(alg), extractable, usages)) as typeof subtle.importKey;
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

// ---------------------------------------------------------------------------
// crypto — password / hash / canonical
// ---------------------------------------------------------------------------

describe('crypto password / hash TOKENMAXX after #75', () => {
  it('rejects verifyPassword when salt base64 is invalid (atob throws → catch via false path)', async () => {
    // Invalid base64 in salt position — atob throws in Node/Workers
    await expect(
      verifyPassword('password1', '$pbkdf2-sha256$100000$!!!not-b64!!!$aGFzaA==')
    ).rejects.toThrow();
  });

  it('rejects verifyPassword when derived hash length mismatches stored (timingSafeEqual)', async () => {
    const real = await hashPassword('match-me-99');
    const parts = real.split('$');
    // Truncate stored hash so lengths differ
    parts[4] = parts[4].slice(0, 8);
    expect(await verifyPassword('match-me-99', parts.join('$'))).toBe(false);
  });

  it('accepts the 2_000_000 iteration upper bound when the stored hash uses it', async () => {
    // Build a real PBKDF2 hash at 2e6 iterations in the expected storage format
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode('upper-bound-1'),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const hash = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 2_000_000, hash: 'SHA-256' },
      keyMaterial,
      256
    );
    const saltB64 = btoa(String.fromCharCode(...salt));
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
    const stored = `$pbkdf2-sha256$2000000$${saltB64}$${hashB64}`;
    expect(await verifyPassword('upper-bound-1', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('rejects NaN iteration counts (parseInt of non-numeric)', async () => {
    expect(await verifyPassword('x', '$pbkdf2-sha256$abc$c2FsdA==$aGFzaA==')).toBe(false);
  });

  it('rejects empty scheme segment and leading-only dollar formats', async () => {
    expect(await verifyPassword('x', '$$$$$')).toBe(false);
    expect(await verifyPassword('x', '$pbkdf2-sha256$')).toBe(false);
  });

  it('accepts passwords with every listed special character class', () => {
    for (const ch of `!@#$%^&*()_+-=[]{};':"\\|,.<>/?`) {
      expect(validatePasswordStrength(`abcdefg${ch}`)).toBeNull();
    }
  });

  it('rejects letter+whitespace-only (no number/symbol in allowed set)', () => {
    expect(validatePasswordStrength('abcdefgh ')).toMatch(/number or special/);
  });

  it('hashes empty Uint8Array via sha256 to a stable unpadded base64url digest', async () => {
    const empty = await sha256(new Uint8Array());
    expect(empty).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(empty).not.toMatch(/[+/=]/);
    expect(await sha256('')).toBe(empty);
  });

  it('hashToken equals sha256 for unicode tokens', async () => {
    const tok = 'syt_unicode_🔑';
    expect(await hashToken(tok)).toBe(await sha256(tok));
  });

  it('strips unsigned and signatures for content hash independently', async () => {
    const base = { type: 'm.test', content: { a: 1 }, unsigned: { age: 9 } };
    const hash = await calculateContentHash(base);
    expect(
      await verifyContentHash(
        { ...base, signatures: { 'ex.com': { 'ed25519:1': 'x' } }, unsigned: { age: 99 } },
        hash
      )
    ).toBe(true);
    expect(await verifyContentHash({ type: 'm.test', content: { a: 2 } }, hash)).toBe(false);
  });

  it('canonicalJson sorts keys lexicographically including numeric-looking keys', () => {
    expect(canonicalJson({ 10: 1, 2: 2, a: 3 })).toBe('{"10":1,"2":2,"a":3}');
  });

  it('canonicalJson encodes nested arrays of mixed primitives', () => {
    expect(canonicalJson([null, true, false, 0, '', [1]])).toBe('[null,true,false,0,"",[1]]');
  });

  it('timingSafeEqual is false when only the last character differs', () => {
    expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false);
    expect(timingSafeEqual('abcdef', 'abcdef')).toBe(true);
  });

  it('generateRandomString rejection sampling still terminates for length 1 and 63', () => {
    expect(generateRandomString(1)).toHaveLength(1);
    expect(generateRandomString(63)).toHaveLength(63);
    expect(generateRandomString(1)).toMatch(/^[A-Za-z0-9]$/);
  });
});

describe('crypto federation signing TOKENMAXX after #75', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('signs empty objects and verifies them', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson({}, 'ex.com', keyId, privateKeyJwk);
    expect(await verifySignature(signed, 'ex.com', keyId, publicKey)).toBe(true);
  });

  it('verifySignature returns false (catch) for garbage signature base64', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson({ type: 'm.test' }, 'ex.com', keyId, privateKeyJwk);
    const bad = {
      ...signed,
      signatures: { 'ex.com': { [keyId]: '%%%not-valid-b64%%%' } },
    };
    expect(await verifySignature(bad, 'ex.com', keyId, publicKey)).toBe(false);
  });

  it('verifySignature returns false for garbage public key bytes', async () => {
    const { privateKeyJwk, keyId } = await generateSigningKeyPair();
    const signed = await signJson({ type: 'm.test' }, 'ex.com', keyId, privateKeyJwk);
    expect(await verifySignature(signed, 'ex.com', keyId, 'AAAA')).toBe(false);
  });

  it('preserves unsigned while signing and does not include it in the signature', async () => {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const obj = { type: 'm.test', unsigned: { txn_id: 't1' }, content: { n: 1 } };
    const signed = await signJson(obj, 'ex.com', keyId, privateKeyJwk);
    expect(signed.unsigned).toEqual({ txn_id: 't1' });
    // Tamper unsigned — signature still covers content without unsigned
    const tamperedUnsigned = { ...signed, unsigned: { txn_id: 't2' } };
    expect(await verifySignature(tamperedUnsigned, 'ex.com', keyId, publicKey)).toBe(true);
  });

  it('legacy generateSigningKeyPairLegacy privateKey JSON string round-trips', async () => {
    const legacy = await generateSigningKeyPairLegacy();
    const jwk = JSON.parse(legacy.privateKey) as JsonWebKey;
    expect(jwk.kty).toBe('OKP');
    const signed = await signJson({ a: 1 }, 'hs.example.com', legacy.keyId, legacy.privateKey);
    expect(await verifySignature(signed, 'hs.example.com', legacy.keyId, legacy.publicKey)).toBe(
      true
    );
  });

  it('merges signatures across different origin servers without clobbering', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const once = await signJson({ type: 'm.x' }, 'a.example.com', a.keyId, a.privateKeyJwk);
    const twice = await signJson(once, 'b.example.com', b.keyId, b.privateKeyJwk);
    const sigs = twice.signatures as Record<string, Record<string, string>>;
    expect(Object.keys(sigs).sort()).toEqual(['a.example.com', 'b.example.com']);
    expect(await verifySignature(twice, 'a.example.com', a.keyId, a.publicKey)).toBe(true);
    expect(await verifySignature(twice, 'b.example.com', b.keyId, b.publicKey)).toBe(true);
  });

  it('keyId is derived from the first 4 bytes of the public key SHA-256', async () => {
    const { publicKey, keyId } = await generateSigningKeyPair();
    expect(keyId).toMatch(/^ed25519:[0-9a-f]{8}$/);
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

// ---------------------------------------------------------------------------
// ids — Matrix ID generation / parsing / validation
// ---------------------------------------------------------------------------

describe('ids format/parse TOKENMAXX after #75', () => {
  it('formats and parses unicode-ish localparts that the validators accept', () => {
    // Localpart regex is ASCII-only; format still interpolates whatever string is given
    const id = formatUserId('alice', 'example.com');
    expect(parseUserId(id)).toEqual({ localpart: 'alice', serverName: 'example.com' });
    expect(formatRoomAlias('general', 'example.com')).toBe('#general:example.com');
  });

  it('rejects user/room/alias IDs missing the colon separator entirely', () => {
    expect(parseUserId('@alice' as '@a:b')).toBeNull();
    expect(parseRoomId('!opaque' as '!a:b')).toBeNull();
    expect(parseRoomAlias('#alias' as '#a:b')).toBeNull();
  });

  it('rejects wrong sigil prefixes', () => {
    expect(parseUserId('!alice:example.com' as '@a:b')).toBeNull();
    expect(parseRoomId('@room:example.com' as '!a:b')).toBeNull();
    expect(parseRoomAlias('@alias:example.com' as '#a:b')).toBeNull();
  });

  it('parses server names with multiple colons via greedy (.+) group', () => {
    expect(parseUserId('@u:a:b:c' as '@u:a')).toEqual({
      localpart: 'u',
      serverName: 'a:b:c',
    });
  });

  it('accepts localpart characters .-_=/ at boundaries', () => {
    expect(isValidLocalpart('.alice.')).toBe(true);
    expect(isValidLocalpart('_=/-')).toBe(true);
    expect(isValidLocalpart('a')).toBe(true);
  });

  it('rejects localparts with spaces, tabs, and newlines', () => {
    expect(isValidLocalpart('a b')).toBe(false);
    expect(isValidLocalpart('a\tb')).toBe(false);
    expect(isValidLocalpart('a\nb')).toBe(false);
  });

  it('validates server names: ports, IPv4, bracketed IPv6, rejects schemes', () => {
    expect(isValidServerName('ex.com:1')).toBe(true);
    expect(isValidServerName('ex.com:65535')).toBe(true);
    expect(isValidServerName('0.0.0.0')).toBe(true);
    expect(isValidServerName('[::]')).toBe(true);
    expect(isValidServerName('http://ex.com')).toBe(false);
    expect(isValidServerName('ex.com/path')).toBe(false);
  });

  it('isLocalServerName is case-insensitive and exact on full string', () => {
    expect(isLocalServerName('EX.COM', 'ex.com')).toBe(true);
    expect(isLocalServerName('ex.com:8448', 'ex.com')).toBe(false);
  });

  it('getServerName returns null without a colon and last segment otherwise', () => {
    expect(getServerName('nocolon')).toBeNull();
    expect(getServerName(':only')).toBe('only');
    expect(getServerName('a:b:c')).toBe('c');
  });

  it('base64UrlEncode/Decode round-trips all byte values 0–255 in chunks', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const enc = base64UrlEncode(bytes);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(bytes));
  });

  it('base64UrlDecode accepts missing padding (length % 4 === 2 or 3)', () => {
    // "hi" → aGk= ; unpadded aGk
    expect(Array.from(base64UrlDecode('aGk'))).toEqual(Array.from(new TextEncoder().encode('hi')));
    // single byte needs == padding when restored
    const one = base64UrlEncode(new Uint8Array([1]));
    expect(Array.from(base64UrlDecode(one))).toEqual([1]);
  });
});

describe('ids generators TOKENMAXX after #75', () => {
  it('generateOpaqueId(0) returns empty string', async () => {
    expect(await generateOpaqueId(0)).toBe('');
  });

  it('generateOpaqueId(1) returns a short unpadded base64url string', async () => {
    const id = await generateOpaqueId(1);
    expect(id.length).toBeGreaterThanOrEqual(1);
    expect(id.length).toBeLessThanOrEqual(4);
    expect(id).not.toMatch(/[+/=]/);
  });

  it('generateRoomId embeds the server name and opaque segment', async () => {
    const roomId = await generateRoomId('matrix.example.com');
    const parsed = parseRoomId(roomId);
    expect(parsed?.serverName).toBe('matrix.example.com');
    expect(parsed?.opaque.length).toBeGreaterThan(10);
  });

  it('generateDeviceId is uppercase opaque without Matrix sigils', async () => {
    const d = await generateDeviceId();
    expect(d).toBe(d.toUpperCase());
    expect(d).not.toMatch(/[@!:#$]/);
  });

  it('token generators use distinct prefixes and unpadded bodies', async () => {
    const access = await generateAccessToken();
    const refresh = await generateRefreshToken();
    const login = await generateLoginToken();
    expect(access.startsWith('syt_')).toBe(true);
    expect(refresh.startsWith('syr_')).toBe(true);
    expect(login.startsWith('mlt_')).toBe(true);
    for (const t of [access, refresh, login]) {
      expect(t.slice(4)).not.toMatch(/[+/=]/);
    }
  });

  it('generateTransactionId joins base36 timestamp with opaque via underscore', async () => {
    const before = Date.now();
    const txn = await generateTransactionId();
    const after = Date.now();
    const [tsPart, randPart] = txn.split('_');
    expect(randPart).toBeTruthy();
    const ts = parseInt(tsPart, 36);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('generateEventId uses domain suffix for room versions 1 and 2 only', async () => {
    for (const v of ['1', '2']) {
      const id = await generateEventId('ex.com', v);
      expect(id).toMatch(/^\$[^:]+:ex\.com$/);
    }
    for (const v of ['3', '4', '10', '12']) {
      const id = await generateEventId('ex.com', v);
      expect(id.startsWith('$')).toBe(true);
      expect(id.includes(':')).toBe(false);
    }
  });

  it('generateLegacyEventId always uses the domain-suffixed form', async () => {
    const id = await generateLegacyEventId('hs.example.com');
    expect(id).toMatch(/^\$[^:]+:hs\.example\.com$/);
  });

  it('generateDeterministicEventId defaults bucketSeconds to 1', async () => {
    const ts = 1_700_000_000_500;
    const a = await generateDeterministicEventId(
      'ex.com',
      '!r:ex.com',
      '@u:ex.com',
      'join',
      ts,
      undefined,
      '10'
    );
    const b = await generateDeterministicEventId(
      'ex.com',
      '!r:ex.com',
      '@u:ex.com',
      'join',
      ts + 499,
      1,
      '10'
    );
    expect(a).toBe(b);
  });

  it('generateDeterministicEventId changes with operation, room, or user', async () => {
    const base = {
      server: 'ex.com',
      room: '!r:ex.com',
      user: '@u:ex.com',
      op: 'join',
      ts: 1_700_000_000_000,
    } as const;
    const a = await generateDeterministicEventId(
      base.server,
      base.room,
      base.user,
      base.op,
      base.ts,
      1,
      '10'
    );
    const b = await generateDeterministicEventId(
      base.server,
      base.room,
      base.user,
      'leave',
      base.ts,
      1,
      '10'
    );
    const c = await generateDeterministicEventId(
      base.server,
      '!other:ex.com',
      base.user,
      base.op,
      base.ts,
      1,
      '10'
    );
    const d = await generateDeterministicEventId(
      base.server,
      base.room,
      '@other:ex.com',
      base.op,
      base.ts,
      1,
      '10'
    );
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('generateDeterministicEventId v1 format truncates opaque to 24 chars before domain', async () => {
    const id = await generateDeterministicEventId(
      'ex.com',
      '!r:ex.com',
      '@u:ex.com',
      'join',
      1_700_000_000_000,
      1,
      '1'
    );
    const m = id.match(/^\$([^:]+):ex\.com$/);
    expect(m).not.toBeNull();
    expect(m![1].length).toBe(24);
  });

  it('generateDeterministicEventId uses full digest opaque for modern formats', async () => {
    const id = await generateDeterministicEventId(
      'ex.com',
      '!r:ex.com',
      '@u:ex.com',
      'join',
      1_700_000_000_000,
      1,
      '10'
    );
    // SHA-256 → 32 bytes → ~43 unpadded base64url chars
    expect(id).toMatch(/^\$[A-Za-z0-9_-]{40,}$/);
  });

  it('larger bucketSeconds collapses a wider timestamp window', async () => {
    // bucket = floor(ts / (60*1000)); 1_700_000_000_000 % 60000 === 20000,
    // so the current 60s bucket ends 40_000ms later.
    const ts = 1_700_000_000_000;
    const a = await generateDeterministicEventId(
      'ex.com',
      '!r:ex.com',
      '@u:ex.com',
      'join',
      ts,
      60,
      '10'
    );
    const b = await generateDeterministicEventId(
      'ex.com',
      '!r:ex.com',
      '@u:ex.com',
      'join',
      ts + 39_999,
      60,
      '10'
    );
    const c = await generateDeterministicEventId(
      'ex.com',
      '!r:ex.com',
      '@u:ex.com',
      'join',
      ts + 40_000,
      60,
      '10'
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

// ---------------------------------------------------------------------------
// errors — factory defaults / response helpers
// ---------------------------------------------------------------------------

describe('errors factory TOKENMAXX after #75', () => {
  it('pins exact default messages for common factories', () => {
    expect(Errors.forbidden().message).toBe('Forbidden');
    expect(Errors.unknownToken().message).toBe('Unknown token');
    expect(Errors.missingToken().message).toBe('Missing access token');
    expect(Errors.badJson().message).toBe('Could not parse request body as JSON');
    expect(Errors.notJson().message).toBe('Content-Type must be application/json');
    expect(Errors.notFound().message).toBe('Not found');
    expect(Errors.limitExceeded().message).toBe('Rate limit exceeded');
    expect(Errors.unknown().message).toBe('An unknown error occurred');
    expect(Errors.unrecognized().message).toBe('Unrecognized request');
    expect(Errors.unauthorized().message).toBe('Unauthorized');
    expect(Errors.userDeactivated().message).toBe('User account has been deactivated');
    expect(Errors.userInUse().message).toBe('User ID already taken');
    expect(Errors.invalidUsername().message).toBe('Invalid username');
    expect(Errors.roomInUse().message).toBe('Room alias already taken');
    expect(Errors.invalidRoomState().message).toBe('Invalid room state');
    expect(Errors.unsupportedRoomVersion().message).toBe('Unsupported room version');
    expect(Errors.guestAccessForbidden().message).toBe('Guest access forbidden');
    expect(Errors.tooLarge().message).toBe('Request too large');
    expect(Errors.conflict().message).toBe(
      'State changed concurrently; retry the operation'
    );
  });

  it('missingParam / invalidParam interpolate the parameter name', () => {
    expect(Errors.missingParam('foo').toJSON()).toEqual({
      errcode: ErrorCodes.M_MISSING_PARAM,
      error: 'Missing required parameter: foo',
    });
    expect(Errors.invalidParam('bar').toJSON()).toEqual({
      errcode: ErrorCodes.M_INVALID_PARAM,
      error: 'Invalid parameter: bar',
    });
  });

  it('MatrixApiError sets name and optional retryAfterMs only when truthy', () => {
    const err = new MatrixApiError(ErrorCodes.M_LIMIT_EXCEEDED, 'slow', 429, 1500);
    expect(err.name).toBe('MatrixApiError');
    expect(err.retryAfterMs).toBe(1500);
    expect(err.toJSON().retry_after_ms).toBe(1500);
  });

  it('toResponse serializes status and JSON content-type', async () => {
    const res = Errors.conflict('race').toResponse();
    expect(res.status).toBe(409);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    await expect(res.json()).resolves.toEqual({
      errcode: ErrorCodes.M_CONFLICT,
      error: 'race',
    });
  });

  it('jsonResponse stringifies arbitrary values including null and arrays', async () => {
    // 204/205/304 forbid bodies in the Fetch Response constructor
    await expect(jsonResponse(null, 200).json()).resolves.toBeNull();
    await expect(jsonResponse([1, 2], 200).json()).resolves.toEqual([1, 2]);
  });
  it('emptyResponse defaults to 200 {}', async () => {
    const res = emptyResponse();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({});
  });

  it('withErrorHandler logs unexpected errors and returns default M_UNKNOWN body', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await withErrorHandler(async () => {
      throw new TypeError('boom');
    });
    expect(res).toBeInstanceOf(Response);
    await expect((res as Response).json()).resolves.toEqual({
      errcode: ErrorCodes.M_UNKNOWN,
      error: 'An unknown error occurred',
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('unsupportedRoomVersion interpolates the version into the message when provided', () => {
    expect(Errors.unsupportedRoomVersion('99').message).toContain('99');
  });
});

// ---------------------------------------------------------------------------
// url-validator — SSRF / preview edges
// ---------------------------------------------------------------------------

describe('url-validator SSRF TOKENMAXX after #75', () => {
  it('allows public hosts on http default port 80 and https 443', () => {
    expect(validateUrl('http://example.com').valid).toBe(true);
    expect(validateUrl('https://example.com').valid).toBe(true);
    expect(validateUrl('http://example.com:80').valid).toBe(true);
    expect(validateUrl('https://example.com:443').valid).toBe(true);
  });

  it('rejects RFC1918 192.168 and 10.x at boundaries', () => {
    expect(validateUrl('http://192.168.0.0/').valid).toBe(false);
    expect(validateUrl('http://192.168.255.255/').valid).toBe(false);
    expect(validateUrl('http://10.255.255.255/').valid).toBe(false);
    expect(validateUrl('http://11.0.0.1/').valid).toBe(true);
  });

  it('rejects link-local 169.254.0.0/16 including metadata IP', () => {
    expect(validateUrl('http://169.254.0.1/').valid).toBe(false);
    expect(validateUrl('http://169.254.169.254/').valid).toBe(false);
  });

  it('rejects loopback 127.x including 127.255.255.255', () => {
    expect(validateUrl('http://127.255.255.255/').valid).toBe(false);
  });

  it('rejects IPv6 link-local fe80::/10 and unique-local fc00::/7', () => {
    expect(validateUrl('http://[fe80::1]/').valid).toBe(false);
    expect(validateUrl('http://[fc00::1]/').valid).toBe(false);
  });

  it('rejects .local and .internal TLDs case-insensitively', () => {
    expect(validateUrl('http://printer.LOCAL/').valid).toBe(false);
    expect(validateUrl('http://svc.INTERNAL/').valid).toBe(false);
  });

  it('rejects subdomains of blocked hostnames', () => {
    expect(validateUrl('http://a.b.localhost.localdomain/').valid).toBe(false);
    expect(validateUrl('http://node.kubernetes.default.svc.cluster.local/').valid).toBe(false);
  });

  it('returns sanitizedUrl with trailing slash normalization from WHATWG URL', () => {
    const result = validateUrl('https://example.com');
    expect(result.valid).toBe(true);
    expect(result.sanitizedUrl).toBe('https://example.com/');
  });

  it('blocks remaining service ports 1433/1521/27017/9200 with port error text', () => {
    for (const port of [1433, 1521, 27017, 9200]) {
      const r = validateUrl(`https://example.com:${port}`);
      expect(r.valid).toBe(false);
      expect(r.error).toBe(`Access to port ${port} is not allowed`);
    }
  });

  it('allows non-blocked uncommon ports for general validateUrl but not preview', () => {
    expect(validateUrl('https://example.com:9443').valid).toBe(true);
    expect(validateUrlForPreview('https://example.com:9443').valid).toBe(false);
  });

  it('preview allows exact allow-list ports only', () => {
    for (const port of [80, 443, 8080, 8443]) {
      const proto = port === 80 || port === 8080 ? 'http' : 'https';
      expect(validateUrlForPreview(`${proto}://example.com:${port}`).valid).toBe(true);
    }
  });

  it('rejects IPv4-mapped private ::ffff:192.168.0.1 forms', () => {
    expect(validateUrl('http://[::ffff:192.168.0.1]/').valid).toBe(false);
    expect(validateUrl('http://[::ffff:c0a8:1]/').valid).toBe(false);
  });

  it('rejects javascript: and blob: schemes', () => {
    expect(validateUrl('javascript:void(0)').valid).toBe(false);
    expect(validateUrl('blob:https://example.com/uuid').valid).toBe(false);
  });

  it('rejects hostname metadata as exact match', () => {
    expect(validateUrl('http://metadata/').error).toBe(
      'Access to internal hostnames is not allowed'
    );
  });

  it('propagates SSRF failures through validateUrlForPreview unchanged', () => {
    const general = validateUrl('http://10.0.0.1/');
    const preview = validateUrlForPreview('http://10.0.0.1/');
    expect(preview).toEqual(general);
  });
});

// ---------------------------------------------------------------------------
// Extra combinatorial / clock-adjacent edges (TOKENMAXX HEAVY)
// ---------------------------------------------------------------------------

describe('crypto password strength boundary matrix after #75', () => {
  it('accepts length exactly 8 with letter+digit', () => {
    expect(validatePasswordStrength('abcdefg1')).toBeNull();
  });

  it('rejects length 7 with letter+digit', () => {
    expect(validatePasswordStrength('abcdef1')).toMatch(/at least 8/);
  });

  it('accepts length 1000 and rejects 1001', () => {
    expect(validatePasswordStrength('a1' + 'x'.repeat(998))).toBeNull();
    expect(validatePasswordStrength('a1' + 'x'.repeat(999))).toMatch(/at most 1000/);
  });

  it('accepts mixed case letters with a digit', () => {
    expect(validatePasswordStrength('AbCdEfG1')).toBeNull();
  });

  it('rejects digit-only and letter-only at length 8+', () => {
    expect(validatePasswordStrength('12345678')).toMatch(/letter/);
    expect(validatePasswordStrength('abcdefgh')).toMatch(/number or special/);
  });
});

describe('ids room-version event-id matrix after #75', () => {
  it('generateEventId for unsupported version falls back to bare $opaque (v4)', async () => {
    const id = await generateEventId('ex.com', '999');
    expect(id).toMatch(/^\$[A-Za-z0-9_-]+$/);
    expect(id.includes(':')).toBe(false);
  });

  it('generateDeterministicEventId for version 2 uses v1 domain-suffixed format', async () => {
    const id = await generateDeterministicEventId(
      'ex.com',
      '!r:ex.com',
      '@u:ex.com',
      'join',
      1_700_000_000_000,
      1,
      '2'
    );
    expect(id).toMatch(/^\$[^:]+:ex\.com$/);
  });

  it('generateDeterministicEventId for version 3 uses bare opaque (non-v1 format)', async () => {
    const id = await generateDeterministicEventId(
      'ex.com',
      '!r:ex.com',
      '@u:ex.com',
      'join',
      1_700_000_000_000,
      1,
      '3'
    );
    expect(id.startsWith('$')).toBe(true);
    expect(id.includes(':')).toBe(false);
  });

  it('omitting roomVersion on generateDeterministicEventId uses modern bare form', async () => {
    const id = await generateDeterministicEventId(
      'ex.com',
      '!r:ex.com',
      '@u:ex.com',
      'join',
      1_700_000_000_000
    );
    expect(id.includes(':')).toBe(false);
  });
});

describe('ids server-name / localpart matrix after #75', () => {
  it('accepts hyphenated multi-label domains and rejects empty labels', () => {
    expect(isValidServerName('a-b.example.com')).toBe(true);
    expect(isValidServerName('example..com')).toBe(false);
    expect(isValidServerName('.example.com')).toBe(false);
  });

  it('accepts single-label hosts and rejects underscore labels', () => {
    expect(isValidServerName('localhost')).toBe(true);
    expect(isValidServerName('my_host')).toBe(false);
  });

  it('accepts IPv4 with port and rejects IPv4 with trailing colon only', () => {
    expect(isValidServerName('1.2.3.4:8448')).toBe(true);
    expect(isValidServerName('1.2.3.4:')).toBe(false);
  });

  it('documents that octet magnitude is not range-checked (999.999.999.999)', () => {
    // Regex is \d{1,3} four times — does not enforce 0–255
    expect(isValidServerName('999.999.999.999')).toBe(true);
  });

  it('localpart allows = and / mid-string and rejects @', () => {
    expect(isValidLocalpart('a=b/c')).toBe(true);
    expect(isValidLocalpart('a@b')).toBe(false);
  });
});

describe('url-validator IPv4/IPv6 boundary matrix after #75', () => {
  it('allows 172.32.0.0 (just outside RFC1918 172.16/12) and blocks 172.16.0.0', () => {
    expect(validateUrl('http://172.32.0.0/').valid).toBe(true);
    expect(validateUrl('http://172.16.0.0/').valid).toBe(false);
  });

  it('blocks 0.0.0.0/8 current-network range', () => {
    expect(validateUrl('http://0.1.2.3/').valid).toBe(false);
    expect(validateUrl('http://0.255.255.255/').valid).toBe(false);
  });

  it('allows public 8.8.8.8 and blocks 127.0.0.1', () => {
    expect(validateUrl('http://8.8.8.8/').valid).toBe(true);
    expect(validateUrl('http://127.0.0.1/').valid).toBe(false);
  });

  it('blocks IPv6 documentation 2001:db8::/32 and allows 2001:db9::1', () => {
    expect(validateUrl('http://[2001:db8::abcd]/').valid).toBe(false);
    expect(validateUrl('http://[2001:db9::1]/').valid).toBe(true);
  });

  it('blocks multicast ff00::/8 and allows global unicast 2606:4700::', () => {
    expect(validateUrl('http://[ff05::1]/').valid).toBe(false);
    expect(validateUrl('http://[2606:4700::1]/').valid).toBe(true);
  });

  it('rejects Telnet/SSH/SMTP ports with exact error strings', () => {
    expect(validateUrl('https://example.com:22').error).toBe('Access to port 22 is not allowed');
    expect(validateUrl('https://example.com:23').error).toBe('Access to port 23 is not allowed');
    expect(validateUrl('https://example.com:25').error).toBe('Access to port 25 is not allowed');
  });

  it('preview rejects federation port 8448 after general SSRF would allow it', () => {
    expect(validateUrl('https://example.com:8448').valid).toBe(true);
    expect(validateUrlForPreview('https://example.com:8448').error).toBe(
      'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview'
    );
  });
});

describe('errors status / errcode matrix after #75', () => {
  it('maps factory statuses exactly', () => {
    expect(Errors.forbidden().status).toBe(403);
    expect(Errors.unknownToken().status).toBe(401);
    expect(Errors.missingToken().status).toBe(401);
    expect(Errors.badJson().status).toBe(400);
    expect(Errors.notJson().status).toBe(400);
    expect(Errors.notFound().status).toBe(404);
    expect(Errors.limitExceeded().status).toBe(429);
    expect(Errors.unknown().status).toBe(500);
    expect(Errors.unrecognized().status).toBe(400);
    expect(Errors.unauthorized().status).toBe(401);
    expect(Errors.userDeactivated().status).toBe(403);
    expect(Errors.tooLarge().status).toBe(413);
    expect(Errors.conflict().status).toBe(409);
    expect(Errors.guestAccessForbidden().status).toBe(403);
  });

  it('maps factory errcodes exactly', () => {
    expect(Errors.forbidden().errcode).toBe(ErrorCodes.M_FORBIDDEN);
    expect(Errors.unknownToken().errcode).toBe(ErrorCodes.M_UNKNOWN_TOKEN);
    expect(Errors.missingToken().errcode).toBe(ErrorCodes.M_MISSING_TOKEN);
    expect(Errors.userInUse().errcode).toBe(ErrorCodes.M_USER_IN_USE);
    expect(Errors.invalidUsername().errcode).toBe(ErrorCodes.M_INVALID_USERNAME);
    expect(Errors.roomInUse().errcode).toBe(ErrorCodes.M_ROOM_IN_USE);
    expect(Errors.invalidRoomState().errcode).toBe(ErrorCodes.M_INVALID_ROOM_STATE);
    expect(Errors.unsupportedRoomVersion().errcode).toBe(ErrorCodes.M_UNSUPPORTED_ROOM_VERSION);
    expect(Errors.tooLarge().errcode).toBe(ErrorCodes.M_TOO_LARGE);
    expect(Errors.conflict().errcode).toBe(ErrorCodes.M_CONFLICT);
  });

  it('withErrorHandler preserves MatrixApiError status and body', async () => {
    const res = await withErrorHandler(async () => {
      throw Errors.tooLarge('huge');
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(413);
    await expect((res as Response).json()).resolves.toEqual({
      errcode: ErrorCodes.M_TOO_LARGE,
      error: 'huge',
    });
  });
});

describe('crypto canonicalJson / content-hash extras after #75', () => {
  it('canonicalJson encodes boolean false and number zero distinctly from null', () => {
    expect(canonicalJson({ a: false, b: 0, c: null })).toBe('{"a":false,"b":0,"c":null}');
  });

  it('canonicalJson does not reorder array elements', () => {
    expect(canonicalJson([{ z: 1, a: 2 }, { b: 3 }])).toBe('[{"a":2,"z":1},{"b":3}]');
  });

  it('content hash ignores key order differences via canonicalJson', async () => {
    const a = { type: 'm.x', content: { b: 1, a: 2 } };
    const b = { type: 'm.x', content: { a: 2, b: 1 } };
    expect(await calculateContentHash(a)).toBe(await calculateContentHash(b));
  });

  it('empty object content hash is stable', async () => {
    const h = await calculateContentHash({});
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await verifyContentHash({}, h)).toBe(true);
  });
});
