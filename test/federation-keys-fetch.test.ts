import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_KEY_MAX_STALENESS_MS,
  federationGet,
  federationPost,
  federationPut,
  fetchRawServerKeyResponse,
  fetchRemoteServerKeys,
  getRemoteKeysWithNotarySignature,
  getRemoteServerKey,
  getServerSigningKey,
  makeFederationRequest,
  verifyRemoteSignature,
} from '../src/services/federation-keys';
import { generateSigningKeyPair, signJson } from '../src/utils/crypto';

const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const KEY_CACHE_TTL = 5 * 60;

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

type RemoteKeyRow = {
  server_name: string;
  key_id: string;
  public_key: string;
  valid_from: number;
  valid_until: number | null;
  fetched_at: number;
  verified: boolean | number;
};

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const kv = {
    puts,
    data,
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
  return kv as unknown as KVNamespace & { puts: KvPut[]; data: Record<string, string> };
}

function mockKeysDb(rows: RemoteKeyRow[] = []) {
  const binds: unknown[][] = [];
  const inserts: unknown[][] = [];
  const db = {
    binds,
    inserts,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          if (sql.includes('FROM remote_server_keys')) {
            binds.push(args);
            const cutoff = args[1] as number;
            const serverName = args[0] as string;
            const results = rows.filter(
              (k) =>
                k.server_name === serverName &&
                (k.valid_until === null || k.valid_until > cutoff)
            );
            return {
              all: async () => ({ results }),
              first: async () => null,
              run: async () => ({ meta: { changes: 0 } }),
            };
          }
          if (sql.includes('INSERT OR REPLACE INTO remote_server_keys')) {
            inserts.push(args);
            return {
              all: async () => ({ results: [] }),
              first: async () => null,
              run: async () => ({ meta: { changes: 1 } }),
            };
          }
          return {
            all: async () => ({ results: [] }),
            first: async () => null,
            run: async () => ({ meta: { changes: 0 } }),
          };
        },
      };
    },
  };
  return db as unknown as D1Database & { binds: unknown[][]; inserts: unknown[][] };
}

function seedDiscovery(kv: ReturnType<typeof mockKv>, serverName: string, host = serverName, port = 8448) {
  kv.data[`discovery:${serverName}`] = JSON.stringify({
    host,
    port,
    tlsHostname: host,
  });
}

describe('fetchRemoteServerKeys TOKENMAXX clock boundaries after #63', () => {
  let restore: (() => void) | undefined;
  let remotePair: Awaited<ReturnType<typeof generateSigningKeyPair>>;

  beforeAll(async () => {
    restore = installNodeEd25519Shim();
    remotePair = await generateSigningKeyPair();
  });

  afterAll(() => {
    restore?.();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns KV-cached keys without consulting D1 or the network', async () => {
    const cached = [
      {
        server_name: 'cached.example.com',
        key_id: 'ed25519:1',
        public_key: 'abc',
        valid_from: 1,
        valid_until: NOW + 1,
        fetched_at: NOW,
        verified: true,
      },
    ];
    const kv = mockKv({
      'federation:keys:cached.example.com': JSON.stringify(cached),
    });
    const db = mockKeysDb();

    const keys = await fetchRemoteServerKeys('cached.example.com', db, kv);

    expect(keys).toEqual(cached);
    expect(db.binds).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('binds Date.now as the D1 valid_until cutoff and keeps null / future rows', async () => {
    const rows: RemoteKeyRow[] = [
      {
        server_name: 'd1.example.com',
        key_id: 'ed25519:null',
        public_key: 'n',
        valid_from: 0,
        valid_until: null,
        fetched_at: NOW - HOUR_MS + 1,
        verified: 1,
      },
      {
        server_name: 'd1.example.com',
        key_id: 'ed25519:eq',
        public_key: 'e',
        valid_from: 0,
        valid_until: NOW, // SQL uses valid_until > ? → excluded at equality
        fetched_at: NOW,
        verified: 1,
      },
      {
        server_name: 'd1.example.com',
        key_id: 'ed25519:future',
        public_key: 'f',
        valid_from: 0,
        valid_until: NOW + 1,
        fetched_at: NOW - HOUR_MS + 1,
        verified: 1,
      },
    ];
    const kv = mockKv();
    const db = mockKeysDb(rows);

    const keys = await fetchRemoteServerKeys('d1.example.com', db, kv);

    expect(db.binds).toEqual([['d1.example.com', NOW]]);
    expect(keys.map((k) => k.key_id).sort()).toEqual(['ed25519:future', 'ed25519:null']);
    expect(kv.puts).toEqual([
      {
        key: 'federation:keys:d1.example.com',
        value: JSON.stringify(keys),
        options: { expirationTtl: KEY_CACHE_TTL },
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats fetched_at === NOW - 1h as not recent (strict >) and falls through to remote', async () => {
    const rows: RemoteKeyRow[] = [
      {
        server_name: 'stale-fetch.example.com',
        key_id: 'ed25519:1',
        public_key: 'x'.repeat(43), // will be overwritten by remote
        valid_from: 0,
        valid_until: NOW + 86_400_000,
        fetched_at: NOW - HOUR_MS, // equality → not recent
        verified: 1,
      },
    ];
    const kv = mockKv();
    seedDiscovery(kv, 'stale-fetch.example.com');
    const db = mockKeysDb(rows);

    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          server_name: 'stale-fetch.example.com',
          valid_until_ts: NOW + 86_400_000,
          verify_keys: { [remotePair.keyId]: { key: remotePair.publicKey } },
          old_verify_keys: {
            'ed25519:old': { key: remotePair.publicKey, expired_ts: NOW - 10 },
          },
        }),
        { status: 200 }
      )
    );

    const keys = await fetchRemoteServerKeys('stale-fetch.example.com', db, kv);

    expect(fetch).toHaveBeenCalled();
    expect(keys).toHaveLength(2);
    expect(keys[0].key_id).toBe(remotePair.keyId);
    expect(keys[0].fetched_at).toBe(NOW);
    expect(keys[0].valid_from).toBe(NOW);
    expect(keys[0].valid_until).toBe(NOW + 86_400_000);
    expect(keys[1].key_id).toBe('ed25519:old');
    expect(keys[1].valid_until).toBe(NOW - 10);
    expect(keys[1].verified).toBe(false);
    expect(db.inserts).toHaveLength(2);
    expect(kv.puts.some((p) => p.key === 'federation:keys:stale-fetch.example.com')).toBe(true);
  });

  it('uses D1 rows when fetched_at is one ms inside the 1h freshness window', async () => {
    const rows: RemoteKeyRow[] = [
      {
        server_name: 'fresh.example.com',
        key_id: 'ed25519:1',
        public_key: 'freshkey',
        valid_from: 0,
        valid_until: NOW + 1,
        fetched_at: NOW - HOUR_MS + 1,
        verified: 1,
      },
    ];
    const kv = mockKv();
    const db = mockKeysDb(rows);

    const keys = await fetchRemoteServerKeys('fresh.example.com', db, kv);

    expect(keys).toHaveLength(1);
    expect(keys[0].public_key).toBe('freshkey');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to D1 keys within DEFAULT_KEY_MAX_STALENESS when remote fetch fails', async () => {
    // SQL at NOW keeps valid_until > NOW (and null). Mid-flight we advance into the
    // grace window so the catch-path isKeyTooStale filter is exercised.
    const rows: RemoteKeyRow[] = [
      {
        server_name: 'fallback.example.com',
        key_id: 'ed25519:ok',
        public_key: 'keep',
        valid_from: 0,
        valid_until: NOW + 1,
        fetched_at: NOW - HOUR_MS, // not recent → attempt remote
        verified: 1,
      },
      {
        server_name: 'fallback.example.com',
        key_id: 'ed25519:null',
        public_key: 'null-ok',
        valid_from: 0,
        valid_until: null,
        fetched_at: NOW - HOUR_MS,
        verified: 1,
      },
    ];
    const kv = mockKv();
    seedDiscovery(kv, 'fallback.example.com');
    const db = mockKeysDb(rows);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // now - (NOW+1) === DEFAULT → equality is not too stale
      vi.setSystemTime(NOW + 1 + DEFAULT_KEY_MAX_STALENESS_MS);
      throw new Error('network down');
    });

    const keys = await fetchRemoteServerKeys('fallback.example.com', db, kv);

    expect(keys.map((k) => k.key_id).sort()).toEqual(['ed25519:null', 'ed25519:ok']);
  });

  it('drops D1 fallback keys one ms past the DEFAULT_KEY_MAX_STALENESS grace window', async () => {
    const rows: RemoteKeyRow[] = [
      {
        server_name: 'grace-drop.example.com',
        key_id: 'ed25519:1',
        public_key: 'x',
        valid_from: 0,
        valid_until: NOW + 1,
        fetched_at: NOW - HOUR_MS,
        verified: 1,
      },
    ];
    const kv = mockKv();
    seedDiscovery(kv, 'grace-drop.example.com');
    const db = mockKeysDb(rows);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      vi.setSystemTime(NOW + 1 + DEFAULT_KEY_MAX_STALENESS_MS + 1);
      throw new Error('timeout');
    });

    await expect(fetchRemoteServerKeys('grace-drop.example.com', db, kv)).rejects.toThrow(
      'Cannot fetch signing keys from grace-drop.example.com'
    );
  });

  it('excludes D1 rows whose valid_until equals the bind cutoff (SQL uses strict >)', async () => {
    const rows: RemoteKeyRow[] = [
      {
        server_name: 'eq-cut.example.com',
        key_id: 'ed25519:1',
        public_key: 'x',
        valid_from: 0,
        valid_until: NOW, // valid_until > NOW is false
        fetched_at: NOW,
        verified: 1,
      },
    ];
    const kv = mockKv();
    seedDiscovery(kv, 'eq-cut.example.com');
    const db = mockKeysDb(rows);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));

    await expect(fetchRemoteServerKeys('eq-cut.example.com', db, kv)).rejects.toThrow(
      'Cannot fetch signing keys from eq-cut.example.com'
    );
    expect(db.binds).toEqual([['eq-cut.example.com', NOW]]);
  });

  it('throws when remote fails and D1 has no usable rows', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'empty.example.com');
    const db = mockKeysDb([]);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    await expect(fetchRemoteServerKeys('empty.example.com', db, kv)).rejects.toThrow(
      'Cannot fetch signing keys from empty.example.com'
    );
  });

  it('rejects remote key responses with a server_name mismatch', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'name.example.com');
    const db = mockKeysDb([]);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          server_name: 'other.example.com',
          valid_until_ts: NOW + 1,
          verify_keys: { [remotePair.keyId]: { key: remotePair.publicKey } },
        }),
        { status: 200 }
      )
    );

    await expect(fetchRemoteServerKeys('name.example.com', db, kv)).rejects.toThrow(
      'Cannot fetch signing keys from name.example.com'
    );
  });

  it('rejects non-OK remote key HTTP and skips invalid key material', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'http.example.com');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('nope', { status: 500 })
    );
    await expect(fetchRemoteServerKeys('http.example.com', mockKeysDb([]), kv)).rejects.toThrow(
      'Cannot fetch signing keys from http.example.com'
    );

    seedDiscovery(kv, 'badkey.example.com');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          server_name: 'badkey.example.com',
          valid_until_ts: NOW + 1,
          verify_keys: {
            'ed25519:short': { key: 'abc' }, // not 32 bytes
            'ed25519:junk': { key: '!!!not-base64url!!!' },
          },
          old_verify_keys: {
            'ed25519:oldshort': { key: 'xy' },
          },
        }),
        { status: 200 }
      )
    );
    await expect(fetchRemoteServerKeys('badkey.example.com', mockKeysDb([]), kv)).rejects.toThrow(
      'Cannot fetch signing keys from badkey.example.com'
    );
  });

  it('marks self-signed remote keys verified when the signature checks out', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'signed.example.com');
    const unsigned = {
      server_name: 'signed.example.com',
      valid_until_ts: NOW + 50_000,
      verify_keys: { [remotePair.keyId]: { key: remotePair.publicKey } },
    };
    const signed = await signJson(
      unsigned,
      'signed.example.com',
      remotePair.keyId,
      remotePair.privateKeyJwk
    );
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(signed), { status: 200 })
    );

    const keys = await fetchRemoteServerKeys('signed.example.com', mockKeysDb([]), kv);
    expect(keys).toHaveLength(1);
    expect(keys[0].verified).toBe(true);
    expect(keys[0].valid_until).toBe(NOW + 50_000);
  });

  it('defaults old_verify_keys valid_until to NOW when expired_ts is omitted', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'oldnow.example.com');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          server_name: 'oldnow.example.com',
          valid_until_ts: NOW + 1,
          verify_keys: { [remotePair.keyId]: { key: remotePair.publicKey } },
          old_verify_keys: {
            'ed25519:retired': { key: remotePair.publicKey },
          },
        }),
        { status: 200 }
      )
    );

    const keys = await fetchRemoteServerKeys('oldnow.example.com', mockKeysDb([]), kv);
    const old = keys.find((k) => k.key_id === 'ed25519:retired');
    expect(old?.valid_until).toBe(NOW);
    expect(old?.valid_from).toBe(0);
  });

  it('keeps verified:false when self-signature is present but fails verify', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'badsig.example.com');
    const other = await generateSigningKeyPair();
    const unsigned = {
      server_name: 'badsig.example.com',
      valid_until_ts: NOW + 50_000,
      verify_keys: { [remotePair.keyId]: { key: remotePair.publicKey } },
    };
    // Sign with a different key so verify against remotePair.publicKey fails
    const wronglySigned = await signJson(
      unsigned,
      'badsig.example.com',
      remotePair.keyId,
      other.privateKeyJwk
    );
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(wronglySigned), { status: 200 })
    );

    const keys = await fetchRemoteServerKeys('badsig.example.com', mockKeysDb([]), kv);
    expect(keys).toHaveLength(1);
    expect(keys[0].verified).toBe(false);
    expect(keys[0].public_key).toBe(remotePair.publicKey);
    expect(kv.puts.some((p) => p.key === 'federation:keys:badsig.example.com')).toBe(true);
    expect(
      kv.puts.find((p) => p.key === 'federation:keys:badsig.example.com')?.options
    ).toEqual({ expirationTtl: KEY_CACHE_TTL });
  });

  it('stores valid_until as null when remote omits valid_until_ts', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'novalid.example.com');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          server_name: 'novalid.example.com',
          verify_keys: { [remotePair.keyId]: { key: remotePair.publicKey } },
        }),
        { status: 200 }
      )
    );

    const keys = await fetchRemoteServerKeys('novalid.example.com', mockKeysDb([]), kv);
    expect(keys).toHaveLength(1);
    expect(keys[0].valid_until).toBeNull();
    expect(keys[0].valid_from).toBe(NOW);
    expect(keys[0].fetched_at).toBe(NOW);
  });
});

describe('fetchRawServerKeyResponse TOKENMAXX edge paths after #63', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns the JSON body when server_name matches', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'raw.example.com');
    const body = {
      server_name: 'raw.example.com',
      valid_until_ts: NOW + 1000,
      verify_keys: { 'ed25519:1': { key: 'k' } },
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 })
    );

    await expect(fetchRawServerKeyResponse('raw.example.com', kv)).resolves.toEqual(body);
    expect(fetch).toHaveBeenCalledWith(
      'https://raw.example.com:8448/_matrix/key/v2/server',
      expect.objectContaining({ headers: { Accept: 'application/json' } })
    );
  });

  it('returns null on non-OK HTTP status', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'httpfail.example.com');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('nope', { status: 502 })
    );

    await expect(fetchRawServerKeyResponse('httpfail.example.com', kv)).resolves.toBeNull();
  });

  it('returns null on server_name mismatch', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'mismatch.example.com');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          server_name: 'other.example.com',
          valid_until_ts: NOW,
          verify_keys: {},
        }),
        { status: 200 }
      )
    );

    await expect(fetchRawServerKeyResponse('mismatch.example.com', kv)).resolves.toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'throw.example.com');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('dns'));

    await expect(fetchRawServerKeyResponse('throw.example.com', kv)).resolves.toBeNull();
  });
});

describe('getRemoteKeysWithNotarySignature TOKENMAXX clock boundaries after #63', () => {
  let restore: (() => void) | undefined;
  let notary: Awaited<ReturnType<typeof generateSigningKeyPair>>;

  beforeAll(async () => {
    restore = installNodeEd25519Shim();
    notary = await generateSigningKeyPair();
  });

  afterAll(() => {
    restore?.();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns cached notary responses when valid_until_ts === minimumValidUntilTs (>=)', async () => {
    const cached = [
      {
        server_name: 'notary-cache.example.com',
        valid_until_ts: NOW + 10_000,
        verify_keys: { 'ed25519:1': { key: 'cached' } },
        signatures: { 'notary.example.com': { [notary.keyId]: 'sig' } },
      },
    ];
    const kv = mockKv({
      'notary:keys:notary-cache.example.com:all': JSON.stringify(cached),
    });
    const db = mockKeysDb();

    const result = await getRemoteKeysWithNotarySignature(
      'notary-cache.example.com',
      null,
      NOW + 10_000,
      db,
      kv,
      'notary.example.com',
      notary.keyId,
      notary.privateKeyJwk
    );

    expect(result).toEqual(cached);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores cached responses when valid_until_ts is one ms below the minimum', async () => {
    const cached = [
      {
        server_name: 'notary-miss.example.com',
        valid_until_ts: NOW + 10_000 - 1,
        verify_keys: { 'ed25519:1': { key: 'stale-cache' } },
      },
    ];
    const kv = mockKv({
      'notary:keys:notary-miss.example.com:all': JSON.stringify(cached),
    });
    seedDiscovery(kv, 'notary-miss.example.com');
    const db = mockKeysDb();

    const remoteBody = {
      server_name: 'notary-miss.example.com',
      valid_until_ts: NOW + 86_400_000,
      verify_keys: { 'ed25519:1': { key: notary.publicKey } },
      signatures: {},
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(remoteBody), { status: 200 })
    );

    const result = await getRemoteKeysWithNotarySignature(
      'notary-miss.example.com',
      null,
      NOW + 10_000,
      db,
      kv,
      'notary.example.com',
      notary.keyId,
      notary.privateKeyJwk
    );

    expect(result).toHaveLength(1);
    expect(result[0].valid_until_ts).toBe(NOW + 86_400_000);
    expect(result[0].signatures?.['notary.example.com']?.[notary.keyId]).toEqual(expect.any(String));
    expect(kv.puts.some((p) => p.key === 'notary:keys:notary-miss.example.com:all')).toBe(true);
    expect(
      kv.puts.find((p) => p.key === 'notary:keys:notary-miss.example.com:all')?.options
    ).toEqual({ expirationTtl: KEY_CACHE_TTL });
  });

  it('rebuilds from D1 and pins valid_until_ts to NOW+24h when all cached valid_until are null', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'd1-notary.example.com');
    // Remote miss → fetchRemoteServerKeys path via D1 recent keys
    const rows: RemoteKeyRow[] = [
      {
        server_name: 'd1-notary.example.com',
        key_id: 'ed25519:a',
        public_key: 'aaa',
        valid_from: 0,
        valid_until: null,
        fetched_at: NOW - 1_000,
        verified: 1,
      },
      {
        server_name: 'd1-notary.example.com',
        key_id: 'ed25519:b',
        public_key: 'bbb',
        valid_from: 0,
        valid_until: null,
        fetched_at: NOW - 1_000,
        verified: 1,
      },
    ];
    const db = mockKeysDb(rows);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('nope', { status: 503 })
    );

    const result = await getRemoteKeysWithNotarySignature(
      'd1-notary.example.com',
      null,
      0,
      db,
      kv,
      'notary.example.com',
      notary.keyId,
      notary.privateKeyJwk
    );

    expect(result).toHaveLength(1);
    expect(result[0].valid_until_ts).toBe(NOW + 24 * 60 * 60 * 1000);
    expect(Object.keys(result[0].verify_keys).sort()).toEqual(['ed25519:a', 'ed25519:b']);
    expect(result[0].signatures?.['notary.example.com']?.[notary.keyId]).toEqual(expect.any(String));
  });

  it('filters D1 rebuild to a single keyId and returns [] when that key is absent', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'filter.example.com');
    const rows: RemoteKeyRow[] = [
      {
        server_name: 'filter.example.com',
        key_id: 'ed25519:keep',
        public_key: 'k',
        valid_from: 0,
        valid_until: NOW + 5_000,
        fetched_at: NOW,
        verified: 1,
      },
    ];
    const db = mockKeysDb(rows);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('nope', { status: 404 })
    );

    const hit = await getRemoteKeysWithNotarySignature(
      'filter.example.com',
      'ed25519:keep',
      0,
      db,
      kv,
      'notary.example.com',
      notary.keyId,
      notary.privateKeyJwk
    );
    expect(hit).toHaveLength(1);
    expect(Object.keys(hit[0].verify_keys)).toEqual(['ed25519:keep']);
    expect(hit[0].valid_until_ts).toBe(NOW + 5_000);

    const miss = await getRemoteKeysWithNotarySignature(
      'filter.example.com',
      'ed25519:missing',
      0,
      db,
      kv,
      'notary.example.com',
      notary.keyId,
      notary.privateKeyJwk
    );
    expect(miss).toEqual([]);
  });

  it('filters a remote response to a current keyId and caches the signed result', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'remote-filter.example.com');
    const remoteBody = {
      server_name: 'remote-filter.example.com',
      valid_until_ts: NOW + 9_000,
      verify_keys: {
        'ed25519:want': { key: notary.publicKey },
        'ed25519:other': { key: notary.publicKey },
      },
      old_verify_keys: {
        'ed25519:old': { key: notary.publicKey, expired_ts: NOW - 1 },
      },
      signatures: {},
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(remoteBody), { status: 200 })
    );
    const db = mockKeysDb();

    const result = await getRemoteKeysWithNotarySignature(
      'remote-filter.example.com',
      'ed25519:want',
      0,
      db,
      kv,
      'notary.example.com',
      notary.keyId,
      notary.privateKeyJwk
    );

    expect(result).toHaveLength(1);
    expect(Object.keys(result[0].verify_keys)).toEqual(['ed25519:want']);
    expect(result[0].old_verify_keys).toEqual({});
  });

  it('returns an old_verify_keys-only response when keyId is only in old keys', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'old-key.example.com');
    const remoteBody = {
      server_name: 'old-key.example.com',
      valid_until_ts: NOW + 1_000,
      verify_keys: { 'ed25519:current': { key: notary.publicKey } },
      old_verify_keys: {
        'ed25519:retired': { key: notary.publicKey, expired_ts: NOW - 50 },
      },
      signatures: {},
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(remoteBody), { status: 200 })
    );

    const result = await getRemoteKeysWithNotarySignature(
      'old-key.example.com',
      'ed25519:retired',
      0,
      mockKeysDb(),
      kv,
      'notary.example.com',
      notary.keyId,
      notary.privateKeyJwk
    );

    expect(result).toHaveLength(1);
    expect(result[0].verify_keys).toEqual({});
    expect(result[0].old_verify_keys).toEqual({
      'ed25519:retired': { key: notary.publicKey, expired_ts: NOW - 50 },
    });
  });

  it('returns [] when remote has neither the current nor old keyId', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'absent.example.com');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          server_name: 'absent.example.com',
          valid_until_ts: NOW + 1,
          verify_keys: { 'ed25519:x': { key: notary.publicKey } },
          old_verify_keys: {},
        }),
        { status: 200 }
      )
    );

    await expect(
      getRemoteKeysWithNotarySignature(
        'absent.example.com',
        'ed25519:nope',
        0,
        mockKeysDb(),
        kv,
        'notary.example.com',
        notary.keyId,
        notary.privateKeyJwk
      )
    ).resolves.toEqual([]);
  });
});

describe('getRemoteServerKey / verifyRemoteSignature TOKENMAXX clock boundaries after #63', () => {
  let restore: (() => void) | undefined;
  let pair: Awaited<ReturnType<typeof generateSigningKeyPair>>;

  beforeAll(async () => {
    restore = installNodeEd25519Shim();
    pair = await generateSigningKeyPair();
  });

  afterAll(() => {
    restore?.();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the matching key or null from getRemoteServerKey', async () => {
    const rows = [
      {
        server_name: 'lookup.example.com',
        key_id: pair.keyId,
        public_key: pair.publicKey,
        valid_from: 0,
        valid_until: NOW + 1,
        fetched_at: NOW,
        verified: true,
      },
    ];
    const kv = mockKv({
      'federation:keys:lookup.example.com': JSON.stringify(rows),
    });
    const db = mockKeysDb();

    expect(await getRemoteServerKey('lookup.example.com', pair.keyId, db, kv)).toEqual(rows[0]);
    expect(await getRemoteServerKey('lookup.example.com', 'ed25519:missing', db, kv)).toBeNull();
  });

  it('still verifies when valid_until === now (expired warning branch not taken; not stale)', async () => {
    const signed = await signJson(
      { type: 'm.test', content: { n: 1 } },
      'eq.example.com',
      pair.keyId,
      pair.privateKeyJwk
    );
    const kv = mockKv({
      'federation:keys:eq.example.com': JSON.stringify([
        {
          server_name: 'eq.example.com',
          key_id: pair.keyId,
          public_key: pair.publicKey,
          valid_from: 0,
          valid_until: NOW,
          fetched_at: NOW,
          verified: 1,
        },
      ]),
    });

    expect(await verifyRemoteSignature(signed, 'eq.example.com', pair.keyId, mockKeysDb(), kv)).toBe(
      true
    );
  });

  it('verifies in the expired-but-within-grace window (valid_until < now, not too stale)', async () => {
    const signed = await signJson(
      { type: 'm.test', content: { n: 2 } },
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
          valid_until: NOW - 1,
          fetched_at: NOW,
          verified: 1,
        },
      ]),
    });

    expect(
      await verifyRemoteSignature(signed, 'grace.example.com', pair.keyId, mockKeysDb(), kv)
    ).toBe(true);
  });

  it('rejects when valid_until is one ms past the DEFAULT_KEY_MAX_STALENESS boundary', async () => {
    const signed = await signJson(
      { type: 'm.test', content: { n: 3 } },
      'stale.example.com',
      pair.keyId,
      pair.privateKeyJwk
    );
    const kv = mockKv({
      'federation:keys:stale.example.com': JSON.stringify([
        {
          server_name: 'stale.example.com',
          key_id: pair.keyId,
          public_key: pair.publicKey,
          valid_from: 0,
          valid_until: NOW - DEFAULT_KEY_MAX_STALENESS_MS - 1,
          fetched_at: NOW,
          verified: 1,
        },
      ]),
    });

    expect(
      await verifyRemoteSignature(signed, 'stale.example.com', pair.keyId, mockKeysDb(), kv)
    ).toBe(false);
  });
});


describe('makeFederationRequest / federationGet|Post|Put TOKENMAXX after #63', () => {
  let restore: (() => void) | undefined;
  let pair: Awaited<ReturnType<typeof generateSigningKeyPair>>;

  beforeAll(async () => {
    restore = installNodeEd25519Shim();
    pair = await generateSigningKeyPair();
  });

  afterAll(() => {
    restore?.();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('signs and GETs via makeFederationRequest using cached discovery', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'remote.example.com', 'hs.example.com', 8448);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{"ok":true}', { status: 200 })
    );

    const res = await makeFederationRequest(
      'GET',
      'remote.example.com',
      '/_matrix/federation/v1/version',
      'local.example.com',
      { keyId: pair.keyId, privateKeyJwk: pair.privateKeyJwk },
      kv
    );

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      'https://hs.example.com:8448/_matrix/federation/v1/version',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: expect.stringContaining('X-Matrix'),
        }),
      })
    );
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it('includes JSON body for POST/PUT makeFederationRequest', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'remote.example.com');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{}', { status: 200 })
    );
    const body = { pdus: [] };

    await makeFederationRequest(
      'PUT',
      'remote.example.com',
      '/_matrix/federation/v1/send/t1',
      'local.example.com',
      { keyId: pair.keyId, privateKeyJwk: pair.privateKeyJwk },
      kv,
      body
    );

    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify(body));
  });

  it('federationGet/Post/Put load the current signing key or throw when missing', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'dest.example.com');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{}', { status: 200 })
    );

    const emptyDb = {
      prepare: () => ({
        first: async () => null,
      }),
    } as unknown as D1Database;
    await expect(
      federationGet('dest.example.com', '/path', 'local.example.com', emptyDb, kv)
    ).rejects.toThrow('Server signing key not configured');
    await expect(
      federationPost('dest.example.com', '/path', {}, 'local.example.com', emptyDb, kv)
    ).rejects.toThrow('Server signing key not configured');
    await expect(
      federationPut('dest.example.com', '/path', {}, 'local.example.com', emptyDb, kv)
    ).rejects.toThrow('Server signing key not configured');

    const keyDb = {
      prepare: () => ({
        first: async () => ({
          key_id: pair.keyId,
          private_key_jwk: JSON.stringify(pair.privateKeyJwk),
        }),
      }),
    } as unknown as D1Database;

    expect(await getServerSigningKey(keyDb)).toEqual({
      keyId: pair.keyId,
      privateKeyJwk: pair.privateKeyJwk,
    });

    await federationGet('dest.example.com', '/g', 'local.example.com', keyDb, kv);
    await federationPost('dest.example.com', '/p', { a: 1 }, 'local.example.com', keyDb, kv);
    await federationPut('dest.example.com', '/u', { b: 2 }, 'local.example.com', keyDb, kv);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('omits fetch body when makeFederationRequest body is null (same as undefined)', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'remote.example.com', 'hs.example.com', 8448);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{}', { status: 200 })
    );

    await makeFederationRequest(
      'POST',
      'remote.example.com',
      '/_matrix/federation/v1/user/devices/@u:remote.example.com',
      'local.example.com',
      { keyId: pair.keyId, privateKeyJwk: pair.privateKeyJwk },
      kv,
      null
    );

    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: expect.stringContaining('X-Matrix'),
      })
    );
  });
});

describe('getRemoteKeysWithNotarySignature self-signature path after #63', () => {
  let restore: (() => void) | undefined;
  let remote: Awaited<ReturnType<typeof generateSigningKeyPair>>;
  let notary: Awaited<ReturnType<typeof generateSigningKeyPair>>;

  beforeAll(async () => {
    restore = installNodeEd25519Shim();
    remote = await generateSigningKeyPair();
    notary = await generateSigningKeyPair();
  });

  afterAll(() => {
    restore?.();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('accepts a remote self-signed key response and adds the notary signature', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'selfsig.example.com');
    const unsigned = {
      server_name: 'selfsig.example.com',
      valid_until_ts: NOW + 12_000,
      verify_keys: { [remote.keyId]: { key: remote.publicKey } },
    };
    const remoteSigned = await signJson(
      unsigned,
      'selfsig.example.com',
      remote.keyId,
      remote.privateKeyJwk
    );
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(remoteSigned), { status: 200 })
    );

    const result = await getRemoteKeysWithNotarySignature(
      'selfsig.example.com',
      null,
      NOW + 1,
      mockKeysDb(),
      kv,
      'notary.example.com',
      notary.keyId,
      notary.privateKeyJwk
    );

    expect(result).toHaveLength(1);
    expect(result[0].signatures?.['selfsig.example.com']?.[remote.keyId]).toEqual(
      expect.any(String)
    );
    expect(result[0].signatures?.['notary.example.com']?.[notary.keyId]).toEqual(
      expect.any(String)
    );
  });

  it('propagates fetchRemoteServerKeys failure when remote raw fetch and D1 are empty', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'void.example.com');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('gone', { status: 404 })
    );

    await expect(
      getRemoteKeysWithNotarySignature(
        'void.example.com',
        null,
        0,
        mockKeysDb([]),
        kv,
        'notary.example.com',
        notary.keyId,
        notary.privateKeyJwk
      )
    ).rejects.toThrow('Cannot fetch signing keys from void.example.com');
  });

  it('still notary-signs when remote has verify_keys but no valid self-signature', async () => {
    const kv = mockKv();
    seedDiscovery(kv, 'noself.example.com');
    const unsigned = {
      server_name: 'noself.example.com',
      valid_until_ts: NOW + 9_000,
      verify_keys: { [remote.keyId]: { key: remote.publicKey } },
      // no signatures
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(unsigned), { status: 200 })
    );

    const result = await getRemoteKeysWithNotarySignature(
      'noself.example.com',
      null,
      NOW + 1,
      mockKeysDb(),
      kv,
      'notary.example.com',
      notary.keyId,
      notary.privateKeyJwk
    );

    expect(result).toHaveLength(1);
    expect(result[0].signatures?.['notary.example.com']?.[notary.keyId]).toEqual(
      expect.any(String)
    );
    expect(result[0].signatures?.['noself.example.com']).toBeUndefined();
    expect(kv.puts.some((p) => p.options?.expirationTtl === KEY_CACHE_TTL)).toBe(true);
  });
});
