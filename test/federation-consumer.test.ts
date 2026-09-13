import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { handleFederationQueue } from '../src/consumers/federation-consumer';
import { generateSigningKeyPair } from '../src/utils/crypto';
import type { Env } from '../src/types';

const NOW = 1_700_000_000_000;

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

type QueueBody = {
  destination: string;
  pdu?: Record<string, unknown>;
  edu?: { edu_type: string; content: Record<string, unknown> };
  timestamp: number;
};

function makeMessage(body: QueueBody, attempts = 0) {
  return {
    body,
    attempts,
    retry: vi.fn(),
    ack: vi.fn(),
  };
}

function makeDb(row: { key_id: string; private_key_jwk: string | null } | null = null) {
  return {
    prepare() {
      return {
        first: async () => row,
      };
    },
  } as unknown as Env['DB'];
}

describe('handleFederationQueue TOKENMAXX clock/backoff after #64', () => {
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
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('groups by destination, pins origin_server_ts/txn id to Date.now, and acks on success', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    const m1 = makeMessage({
      destination: 'a.example.com',
      pdu: { event_id: '$1' },
      timestamp: NOW,
    });
    const m2 = makeMessage({
      destination: 'a.example.com',
      edu: { edu_type: 'm.typing', content: { room_id: '!r:ex.com' } },
      timestamp: NOW,
    });
    const m3 = makeMessage({
      destination: 'b.example.com',
      pdu: { event_id: '$2' },
      timestamp: NOW,
    });

    await handleFederationQueue(
      { messages: [m1, m2, m3] } as unknown as MessageBatch<QueueBody>,
      {
        DB: makeDb(null),
        SERVER_NAME: 'local.example.com',
      } as Env
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));

    expect(urls.every((u) => u.includes(`/_matrix/federation/v1/send/${NOW}_`))).toBe(true);
    expect(bodies).toEqual(
      expect.arrayContaining([
        {
          pdus: [{ event_id: '$1' }],
          edus: [{ edu_type: 'm.typing', content: { room_id: '!r:ex.com' } }],
          origin: 'local.example.com',
          origin_server_ts: NOW,
        },
        {
          pdus: [{ event_id: '$2' }],
          edus: [],
          origin: 'local.example.com',
          origin_server_ts: NOW,
        },
      ])
    );
    expect(m1.ack).toHaveBeenCalledOnce();
    expect(m2.ack).toHaveBeenCalledOnce();
    expect(m3.ack).toHaveBeenCalledOnce();
    expect(m1.retry).not.toHaveBeenCalled();
  });

  it('retries with delaySeconds = 2^attempts * 60 when remote returns non-OK', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('nope', { status: 503 })
    );
    const msg = makeMessage(
      {
        destination: 'fail.example.com',
        pdu: { event_id: '$f' },
        timestamp: NOW,
      },
      2
    );

    await handleFederationQueue(
      { messages: [msg] } as unknown as MessageBatch<QueueBody>,
      { DB: makeDb(null), SERVER_NAME: 'local.example.com' } as Env
    );

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: Math.pow(2, 2) * 60 });
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('acks (gives up) when attempts >= 5 after a failed send', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    const msg = makeMessage(
      {
        destination: 'dlq.example.com',
        pdu: { event_id: '$d' },
        timestamp: NOW,
      },
      5
    );

    await handleFederationQueue(
      { messages: [msg] } as unknown as MessageBatch<QueueBody>,
      { DB: makeDb(null), SERVER_NAME: 'local.example.com' } as Env
    );

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('signs the transaction body when a current signing key exists', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const msg = makeMessage({
      destination: 'signed.example.com',
      pdu: { event_id: '$s' },
      timestamp: NOW,
    });

    await handleFederationQueue(
      { messages: [msg] } as unknown as MessageBatch<QueueBody>,
      {
        DB: makeDb({
          key_id: pair.keyId,
          private_key_jwk: JSON.stringify(pair.privateKeyJwk),
        }),
        SERVER_NAME: 'local.example.com',
      } as Env
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      signatures?: Record<string, Record<string, string>>;
      origin_server_ts: number;
    };
    expect(body.origin_server_ts).toBe(NOW);
    expect(body.signatures?.['local.example.com']?.[pair.keyId]).toEqual(expect.any(String));
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('uses a later Date.now for origin_server_ts when the clock advances before send', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async () => {
      vi.setSystemTime(NOW + 5_000);
      return new Response('{}', { status: 200 });
    });
    // Force sendFederationTransaction to read Date.now after our advance by
    // advancing before the handler runs the fetch — pin via stubbing Date.now
    // at the start of the request construction by advancing immediately.
    vi.setSystemTime(NOW + 5_000);

    const msg = makeMessage({
      destination: 'clock.example.com',
      pdu: { event_id: '$c' },
      timestamp: NOW,
    });

    await handleFederationQueue(
      { messages: [msg] } as unknown as MessageBatch<QueueBody>,
      { DB: makeDb(null), SERVER_NAME: 'local.example.com' } as Env
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      origin_server_ts: number;
    };
    expect(body.origin_server_ts).toBe(NOW + 5_000);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`send/${NOW + 5_000}_`);
  });
});

describe('handleFederationQueue ack/retry/sign edges after #71', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('no-ops on empty messages without calling fetch', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    await handleFederationQueue(
      { messages: [] } as unknown as MessageBatch<QueueBody>,
      { DB: makeDb(null), SERVER_NAME: 'local.example.com' } as Env
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still PUTs empty pdus/edus when message has neither pdu nor edu', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const msg = makeMessage({
      destination: 'empty.example.com',
      timestamp: NOW,
    });

    await handleFederationQueue(
      { messages: [msg] } as unknown as MessageBatch<QueueBody>,
      { DB: makeDb(null), SERVER_NAME: 'local.example.com' } as Env
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      pdus: [],
      edus: [],
      origin: 'local.example.com',
      origin_server_ts: NOW,
    });
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('sends EDU-only batches with empty pdus', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const msg = makeMessage({
      destination: 'edu.example.com',
      edu: { edu_type: 'm.typing', content: { room_id: '!r:ex.com' } },
      timestamp: NOW,
    });

    await handleFederationQueue(
      { messages: [msg] } as unknown as MessageBatch<QueueBody>,
      { DB: makeDb(null), SERVER_NAME: 'local.example.com' } as Env
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      pdus: [],
      edus: [{ edu_type: 'm.typing', content: { room_id: '!r:ex.com' } }],
    });
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('skips signing when private_key_jwk is null', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const msg = makeMessage({
      destination: 'unsigned.example.com',
      pdu: { event_id: '$u' },
      timestamp: NOW,
    });

    await handleFederationQueue(
      { messages: [msg] } as unknown as MessageBatch<QueueBody>,
      {
        DB: makeDb({ key_id: 'ed25519:null', private_key_jwk: null }),
        SERVER_NAME: 'local.example.com',
      } as Env
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      signatures?: unknown;
    };
    expect(body.signatures).toBeUndefined();
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('retries when invalid private_key_jwk makes signJson reject (attempts < 5)', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const msg = makeMessage(
      {
        destination: 'badjwk.example.com',
        pdu: { event_id: '$j' },
        timestamp: NOW,
      },
      1
    );

    await handleFederationQueue(
      { messages: [msg] } as unknown as MessageBatch<QueueBody>,
      {
        DB: makeDb({ key_id: 'ed25519:bad', private_key_jwk: 'not-json' }),
        SERVER_NAME: 'local.example.com',
      } as Env
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: Math.pow(2, 1) * 60 });
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('acks only successful destinations when multi-dest mixed OK/fail', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('ok.example.com')) {
        return new Response('{}', { status: 200 });
      }
      return new Response('down', { status: 503 });
    });

    const okMsg = makeMessage({
      destination: 'ok.example.com',
      pdu: { event_id: '$ok' },
      timestamp: NOW,
    });
    const failMsg = makeMessage(
      {
        destination: 'fail.example.com',
        pdu: { event_id: '$fail' },
        timestamp: NOW,
      },
      0
    );

    await handleFederationQueue(
      { messages: [okMsg, failMsg] } as unknown as MessageBatch<QueueBody>,
      { DB: makeDb(null), SERVER_NAME: 'local.example.com' } as Env
    );

    expect(okMsg.ack).toHaveBeenCalledOnce();
    expect(okMsg.retry).not.toHaveBeenCalled();
    expect(failMsg.retry).toHaveBeenCalledWith({ delaySeconds: 60 }); // 2^0 * 60
    expect(failMsg.ack).not.toHaveBeenCalled();
  });

  it('retries at attempts===4 with 16*60 and acks at attempts===5', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('nope', { status: 500 })
    );

    const at4 = makeMessage(
      {
        destination: 'retry.example.com',
        pdu: { event_id: '$4' },
        timestamp: NOW,
      },
      4
    );
    await handleFederationQueue(
      { messages: [at4] } as unknown as MessageBatch<QueueBody>,
      { DB: makeDb(null), SERVER_NAME: 'local.example.com' } as Env
    );
    expect(at4.retry).toHaveBeenCalledWith({ delaySeconds: 16 * 60 });
    expect(at4.ack).not.toHaveBeenCalled();

    const at5 = makeMessage(
      {
        destination: 'retry.example.com',
        pdu: { event_id: '$5' },
        timestamp: NOW,
      },
      5
    );
    await handleFederationQueue(
      { messages: [at5] } as unknown as MessageBatch<QueueBody>,
      { DB: makeDb(null), SERVER_NAME: 'local.example.com' } as Env
    );
    expect(at5.ack).toHaveBeenCalledOnce();
    expect(at5.retry).not.toHaveBeenCalled();
  });
});
