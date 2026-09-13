import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { parseAuthHeader } from '../src/middleware/federation-auth';
import {
  DEFAULT_KEY_MAX_STALENESS_MS,
  signFederationRequest,
  verifyRemoteSignature,
  getServerSigningKey,
  federationGet,
  type SigningKey,
} from '../src/services/federation-keys';
import * as serverDiscovery from '../src/services/server-discovery';
import {
  generateSigningKeyPair,
  signJson,
  verifySignature,
} from '../src/utils/crypto';

/** Remap Cloudflare's NODE-ED25519 algorithm name to Node's Ed25519 for unit tests. */
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

function mockKv(data: Record<string, string> = {}): KVNamespace {
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function mockDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: [] }),
        first: async () => null,
        run: async () => ({ meta: { changes: 0 } }),
      }),
      // getServerSigningKey calls prepare().first() without bind()
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 0 } }),
    }),
  } as unknown as D1Database;
}

describe('signFederationRequest', () => {
  let restore: (() => void) | undefined;
  let signingKey: SigningKey;
  let publicKey: string;

  beforeAll(async () => {
    restore = installNodeEd25519Shim();
    const pair = await generateSigningKeyPair();
    signingKey = { keyId: pair.keyId, privateKeyJwk: pair.privateKeyJwk };
    publicKey = pair.publicKey;
  });

  afterAll(() => {
    restore?.();
  });

  it('builds a parseable X-Matrix header for GET without content', async () => {
    const header = await signFederationRequest(
      'GET',
      '/_matrix/federation/v1/version',
      'origin.example.com',
      'dest.example.com',
      signingKey
    );
    const parsed = parseAuthHeader(header);
    expect(parsed).toEqual({
      origin: 'origin.example.com',
      destination: 'dest.example.com',
      key: signingKey.keyId,
      sig: expect.any(String),
    });

    const requestObj = {
      method: 'GET',
      uri: '/_matrix/federation/v1/version',
      origin: 'origin.example.com',
      destination: 'dest.example.com',
      signatures: {
        'origin.example.com': { [signingKey.keyId]: parsed!.sig },
      },
    };
    expect(
      await verifySignature(requestObj, 'origin.example.com', signingKey.keyId, publicKey)
    ).toBe(true);
  });

  it('includes content in the signed JSON for PUT/POST bodies', async () => {
    const content = { pdus: [{ type: 'm.room.message' }] };
    const header = await signFederationRequest(
      'PUT',
      '/_matrix/federation/v1/send/txn1',
      'origin.example.com',
      'dest.example.com',
      signingKey,
      content
    );
    const parsed = parseAuthHeader(header)!;
    const withContent = {
      method: 'PUT',
      uri: '/_matrix/federation/v1/send/txn1',
      origin: 'origin.example.com',
      destination: 'dest.example.com',
      content,
      signatures: {
        'origin.example.com': { [signingKey.keyId]: parsed.sig },
      },
    };
    const withoutContent = {
      method: 'PUT',
      uri: '/_matrix/federation/v1/send/txn1',
      origin: 'origin.example.com',
      destination: 'dest.example.com',
      signatures: {
        'origin.example.com': { [signingKey.keyId]: parsed.sig },
      },
    };
    expect(
      await verifySignature(withContent, 'origin.example.com', signingKey.keyId, publicKey)
    ).toBe(true);
    expect(
      await verifySignature(withoutContent, 'origin.example.com', signingKey.keyId, publicKey)
    ).toBe(false);
  });

  it('omits null and undefined content from the signed object', async () => {
    const headerNull = await signFederationRequest(
      'POST',
      '/path',
      'a.example.com',
      'b.example.com',
      signingKey,
      null
    );
    const parsed = parseAuthHeader(headerNull)!;
    const requestObj = {
      method: 'POST',
      uri: '/path',
      origin: 'a.example.com',
      destination: 'b.example.com',
      signatures: {
        'a.example.com': { [signingKey.keyId]: parsed.sig },
      },
    };
    expect(await verifySignature(requestObj, 'a.example.com', signingKey.keyId, publicKey)).toBe(
      true
    );

    const headerUndef = await signFederationRequest(
      'POST',
      '/path',
      'a.example.com',
      'b.example.com',
      signingKey,
      undefined
    );
    expect(parseAuthHeader(headerUndef)?.origin).toBe('a.example.com');
  });
});

describe('verifyRemoteSignature staleness gate', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('returns false when no remote key is cached', async () => {
    const kv = mockKv({
      'federation:keys:remote.example.com': JSON.stringify([]),
    });
    expect(
      await verifyRemoteSignature(
        { type: 'm.test' },
        'remote.example.com',
        'ed25519:missing',
        mockDb(),
        kv
      )
    ).toBe(false);
  });

  it('returns false for keys past the max staleness window without verifying', async () => {
    const now = Date.now();
    const kv = mockKv({
      'federation:keys:stale.example.com': JSON.stringify([
        {
          server_name: 'stale.example.com',
          key_id: 'ed25519:stale',
          public_key: 'irrelevant',
          valid_from: 0,
          valid_until: now - DEFAULT_KEY_MAX_STALENESS_MS - 1,
          fetched_at: now - DEFAULT_KEY_MAX_STALENESS_MS - 1,
          verified: 1,
        },
      ]),
    });
    expect(
      await verifyRemoteSignature({ type: 'm.test' }, 'stale.example.com', 'ed25519:stale', mockDb(), kv)
    ).toBe(false);
  });

  it('still verifies when the key is expired but within the grace window', async () => {
    const pair = await generateSigningKeyPair();
    const now = Date.now();
    const signed = await signJson(
      { type: 'm.test', content: { n: 1 } },
      'grace.example.com',
      pair.keyId,
      pair.privateKeyJwk
    );
    const kv = mockKv({
      'federation:keys:grace.example.com': JSON.stringify([
        {
          server_name: 'grace.example.com',
          key_id: pair.keyId,
          public_key: pair.publicKey,
          valid_from: 0,
          valid_until: now - 60_000, // expired 1 minute ago, within 7-day grace
          fetched_at: now - 60_000,
          verified: 1,
        },
      ]),
    });
    expect(
      await verifyRemoteSignature(signed, 'grace.example.com', pair.keyId, mockDb(), kv)
    ).toBe(true);
  });

  it('verifies a valid non-expired remote key', async () => {
    const pair = await generateSigningKeyPair();
    const signed = await signJson(
      { type: 'm.room.member', content: { membership: 'join' } },
      'ok.example.com',
      pair.keyId,
      pair.privateKeyJwk
    );
    const kv = mockKv({
      'federation:keys:ok.example.com': JSON.stringify([
        {
          server_name: 'ok.example.com',
          key_id: pair.keyId,
          public_key: pair.publicKey,
          valid_from: 0,
          valid_until: Date.now() + 86_400_000,
          fetched_at: Date.now(),
          verified: 1,
        },
      ]),
    });
    expect(
      await verifyRemoteSignature(signed, 'ok.example.com', pair.keyId, mockDb(), kv)
    ).toBe(true);
  });
});

describe('getServerSigningKey', () => {
  it('returns null when DB row is missing or private_key_jwk is null', async () => {
    expect(await getServerSigningKey(mockDb())).toBeNull();

    const nullJwkDb = {
      prepare: () => ({
        first: async () => ({ key_id: 'ed25519:1', private_key_jwk: null }),
      }),
    } as unknown as D1Database;
    expect(await getServerSigningKey(nullJwkDb)).toBeNull();
  });

  it('parses a valid current signing key row', async () => {
    const jwk = { kty: 'OKP', crv: 'Ed25519', d: 'x', x: 'y' };
    const db = {
      prepare: () => ({
        first: async () => ({
          key_id: 'ed25519:abc',
          private_key_jwk: JSON.stringify(jwk),
        }),
      }),
    } as unknown as D1Database;
    await expect(getServerSigningKey(db)).resolves.toEqual({
      keyId: 'ed25519:abc',
      privateKeyJwk: jwk,
    });
  });
});

describe('federationGet', () => {
  let restoreShim: (() => void) | undefined;

  afterEach(() => {
    restoreShim?.();
    restoreShim = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws when server signing key is not configured', async () => {
    await expect(
      federationGet(
        'remote.example.com',
        '/_matrix/federation/v1/version',
        'local.example.com',
        mockDb(),
        mockKv()
      )
    ).rejects.toThrow(/Server signing key not configured/);
  });

  it('signs GET with path-only URI and omits body', async () => {
    restoreShim = installNodeEd25519Shim();
    const pair = await generateSigningKeyPair();
    const db = {
      prepare: () => ({
        first: async () => ({
          key_id: pair.keyId,
          private_key_jwk: JSON.stringify(pair.privateKeyJwk),
        }),
      }),
    } as unknown as D1Database;

    vi.spyOn(serverDiscovery, 'discoverServer').mockResolvedValue({
      host: 'remote.example.com',
      port: 443,
      tlsHostname: 'remote.example.com',
    });

    const fetchMock = vi.fn(async () => new Response('{"server":{}}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await federationGet(
      'remote.example.com',
      '/_matrix/federation/v1/version',
      'local.example.com',
      db,
      mockKv()
    );
    expect(res.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://remote.example.com/_matrix/federation/v1/version');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const auth = String((init.headers as Record<string, string>).Authorization);
    const parsed = parseAuthHeader(auth);
    expect(parsed?.origin).toBe('local.example.com');
    expect(parsed?.destination).toBe('remote.example.com');
    expect(parsed?.key).toBe(pair.keyId);

    const requestObj = {
      method: 'GET',
      uri: '/_matrix/federation/v1/version',
      origin: 'local.example.com',
      destination: 'remote.example.com',
      signatures: {
        'local.example.com': { [pair.keyId]: parsed!.sig },
      },
    };
    expect(
      await verifySignature(requestObj, 'local.example.com', pair.keyId, pair.publicKey)
    ).toBe(true);
  });
});

describe('verifyRemoteSignature wrong public key', () => {
  let restoreShim: (() => void) | undefined;

  afterEach(() => {
    restoreShim?.();
    restoreShim = undefined;
  });

  it('returns false when cached public key does not verify', async () => {
    restoreShim = installNodeEd25519Shim();
    const good = await generateSigningKeyPair();
    const other = await generateSigningKeyPair();
    const signed = await signJson(
      { type: 'm.room.message', content: { body: 'hi' } },
      'remote.example.com',
      good.keyId,
      good.privateKeyJwk
    );
    const kv = mockKv({
      'federation:keys:remote.example.com': JSON.stringify([
        {
          server_name: 'remote.example.com',
          key_id: good.keyId,
          public_key: other.publicKey,
          valid_from: 0,
          valid_until: Date.now() + 86_400_000,
          fetched_at: Date.now(),
          verified: 1,
        },
      ]),
    });
    expect(
      await verifyRemoteSignature(signed, 'remote.example.com', good.keyId, mockDb(), kv)
    ).toBe(false);
  });
});
