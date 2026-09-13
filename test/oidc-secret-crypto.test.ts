import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../src/api/oidc-auth';

function b64Key(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe('encryptSecret / decryptSecret', () => {
  const secureKey = b64Key(crypto.getRandomValues(new Uint8Array(32)));
  const env = { SERVER_NAME: 'matrix.example.com', OIDC_ENCRYPTION_KEY: secureKey };

  it('round-trips plaintext and prefixes version byte 0x02', async () => {
    const cipher = await encryptSecret('client-secret-xyz', env);
    const decoded = Uint8Array.from(atob(cipher), (c) => c.charCodeAt(0));
    expect(decoded[0]).toBe(0x02);
    expect(await decryptSecret(cipher, env)).toBe('client-secret-xyz');
  });

  it('uses distinct IVs across encrypts of the same secret', async () => {
    const a = await encryptSecret('same', env);
    const b = await encryptSecret('same', env);
    expect(a).not.toBe(b);
    expect(await decryptSecret(a, env)).toBe('same');
    expect(await decryptSecret(b, env)).toBe('same');
  });

  it('refuses to encrypt without OIDC_ENCRYPTION_KEY', async () => {
    await expect(encryptSecret('x', { SERVER_NAME: 'matrix.example.com' })).rejects.toThrow(
      /OIDC_ENCRYPTION_KEY is required/
    );
  });

  it('rejects keys that are not exactly 32 bytes', async () => {
    const short = b64Key(new Uint8Array(16));
    await expect(
      encryptSecret('x', { SERVER_NAME: 'matrix.example.com', OIDC_ENCRYPTION_KEY: short })
    ).rejects.toThrow(/OIDC_ENCRYPTION_KEY must be 32 bytes/);
  });

  it('rejects tampered ciphertext and wrong key', async () => {
    const cipher = await encryptSecret('secret', env);
    const bytes = Uint8Array.from(atob(cipher), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(decryptSecret(tampered, env)).rejects.toThrow();

    const otherKey = b64Key(crypto.getRandomValues(new Uint8Array(32)));
    await expect(
      decryptSecret(cipher, { SERVER_NAME: 'matrix.example.com', OIDC_ENCRYPTION_KEY: otherKey })
    ).rejects.toThrow();
  });

  it('decrypts legacy 0x01 secrets derived from SERVER_NAME', async () => {
    const legacyEnv = { SERVER_NAME: 'matrix.example.com' };
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(legacyEnv.SERVER_NAME.padEnd(32, '0').slice(0, 32)),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode('legacy-secret'))
    );
    const combined = new Uint8Array(1 + iv.length + encrypted.length);
    combined[0] = 0x01;
    combined.set(iv, 1);
    combined.set(encrypted, 13);
    const blob = btoa(String.fromCharCode(...combined));

    // Decrypt with secure key present still uses version byte to pick legacy derivation
    expect(
      await decryptSecret(blob, {
        SERVER_NAME: 'matrix.example.com',
        OIDC_ENCRYPTION_KEY: secureKey,
      })
    ).toBe('legacy-secret');
  });

  it('decrypts unversioned legacy blobs (IV at offset 0)', async () => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode('matrix.example.com'.padEnd(32, '0').slice(0, 32)),
      'AES-GCM',
      false,
      ['encrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode('old-blob'))
    );
    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv, 0);
    combined.set(encrypted, 12);
    // First byte is random IV — not 0x01/0x02 — so decrypt takes legacy unversioned path
    if (combined[0] === 0x01 || combined[0] === 0x02) {
      combined[0] = 0x03;
    }
    const blob = btoa(String.fromCharCode(...combined));
    // If we mutated the IV the decrypt will fail — only assert when first byte stayed non-version
    if (Uint8Array.from(atob(blob), (c) => c.charCodeAt(0))[0] > 0x02) {
      // Re-encrypt with a forced non-version first IV byte for a deterministic path
      const forcedIv = new Uint8Array(12);
      forcedIv[0] = 0x55;
      crypto.getRandomValues(forcedIv.subarray(1));
      const enc2 = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv: forcedIv }, key, encoder.encode('old-blob'))
      );
      const c2 = new Uint8Array(forcedIv.length + enc2.length);
      c2.set(forcedIv, 0);
      c2.set(enc2, 12);
      const blob2 = btoa(String.fromCharCode(...c2));
      expect(await decryptSecret(blob2, { SERVER_NAME: 'matrix.example.com' })).toBe('old-blob');
    } else {
      expect(await decryptSecret(blob, { SERVER_NAME: 'matrix.example.com' })).toBe('old-blob');
    }
  });
});
