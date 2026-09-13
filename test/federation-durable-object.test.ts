import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { FakeDurableObjectState, durableObjectMockFactory } from './helpers/fake-durable-object';
import type { Env } from '../src/types';
import { generateSigningKeyPair } from '../src/utils/crypto';

vi.mock('cloudflare:workers', () => durableObjectMockFactory());

import { FederationDurableObject } from '../src/durable-objects/FederationDurableObject';

function makeFed(state = new FakeDurableObjectState(), env: Partial<Env> = {}) {
  return {
    state,
    do: new FederationDurableObject(state as unknown as DurableObjectState, env as Env),
  };
}

describe('FederationDurableObject TOKENMAXX edge paths after #57', () => {
  it('returns 404 for unknown paths', async () => {
    const { do: fed } = makeFed();
    const res = await fed.fetch(new Request('https://do/unknown'));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
  });

  it('rejects /receive without X-Matrix-Origin', async () => {
    const { do: fed } = makeFed();
    const res = await fed.fetch(
      new Request('https://do/receive', {
        method: 'POST',
        body: JSON.stringify({ pdus: [] }),
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('stores received PDUs and updates server status locally (no DNS)', async () => {
    const { state, do: fed } = makeFed();
    const res = await fed.fetch(
      new Request('https://do/receive', {
        method: 'POST',
        headers: { 'X-Matrix-Origin': 'remote.example.com' },
        body: JSON.stringify({
          pdus: [{ event_id: '$e1', type: 'm.room.message' }],
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pdus: { $e1: {} } });
    expect(state.storage.map.has('received:$e1')).toBe(true);
    expect(state.storage.map.get('server:remote.example.com')).toMatchObject({
      serverName: 'remote.example.com',
      retryCount: 0,
      nextRetry: null,
    });
  });

  it('returns unknown status for unseen servers and lists known servers', async () => {
    const { state, do: fed } = makeFed();
    await state.storage.put('server:known.example.com', {
      serverName: 'known.example.com',
      lastContact: 1,
      retryCount: 0,
      nextRetry: null,
    });

    const unknown = await fed.fetch(new Request('https://do/status?server=missing.example.com'));
    expect(await unknown.json()).toEqual({
      serverName: 'missing.example.com',
      status: 'unknown',
    });

    const listed = await fed.fetch(new Request('https://do/status'));
    expect(await listed.json()).toEqual({
      servers: [
        {
          serverName: 'known.example.com',
          lastContact: 1,
          retryCount: 0,
          nextRetry: null,
        },
      ],
    });
  });

  it('rejects /keys without server param; serves unexpired cached keys without network', async () => {
    const { state, do: fed } = makeFed();
    const missing = await fed.fetch(new Request('https://do/keys'));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    await state.storage.put('keys:cached.example.com', {
      data: { server_name: 'cached.example.com', verify_keys: {} },
      expires: Date.now() + 60_000,
    });
    const cached = await fed.fetch(new Request('https://do/keys?server=cached.example.com'));
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual({
      server_name: 'cached.example.com',
      verify_keys: {},
    });
  });
});

describe('FederationDurableObject TOKENMAXX edge paths after #58', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns 404 when cached keys are expired and remote fetch fails', async () => {
    const { state, do: fed } = makeFed();
    await state.storage.put('keys:gone.example.com', {
      data: { server_name: 'gone.example.com' },
      expires: Date.now() - 1,
    });
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fed.fetch(new Request('https://do/keys?server=gone.example.com'));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ errcode: 'M_NOT_FOUND' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('accepts /receive with missing pdus and still updates server status', async () => {
    const { state, do: fed } = makeFed();
    const res = await fed.fetch(
      new Request('https://do/receive', {
        method: 'POST',
        headers: { 'X-Matrix-Origin': 'o.example.com' },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pdus: {} });
    expect(state.storage.map.get('server:o.example.com')).toMatchObject({
      serverName: 'o.example.com',
      retryCount: 0,
      nextRetry: null,
    });
  });

  it('queues /send and schedules retry when outbound signing/DB is unavailable', async () => {
    const { state, do: fed } = makeFed();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('net');
      })
    );

    const res = await fed.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          destination: 'remote.example.com',
          event_id: '$e1',
          room_id: '!r:ex.com',
          pdu: { event_id: '$e1' },
        }),
      })
    );
    expect(await res.text()).toBe('Queued');
    expect(state.storage.map.get('queue:remote.example.com:$e1')).toMatchObject({
      event_id: '$e1',
      destination: 'remote.example.com',
      retry_count: 1,
    });
    expect(state.storage.map.get('server:remote.example.com')).toMatchObject({
      serverName: 'remote.example.com',
      retryCount: 1,
    });
    expect(state.storage.alarm).toBeTypeOf('number');
  });

  it('queues /send-edu and schedules retry on outbound failure', async () => {
    const { state, do: fed } = makeFed();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('net');
      })
    );

    const res = await fed.fetch(
      new Request('https://do/send-edu', {
        method: 'POST',
        body: JSON.stringify({
          destination: 'edu.example.com',
          edu_type: 'm.typing',
          content: { room_id: '!r:ex.com' },
        }),
      })
    );
    expect(await res.text()).toBe('Queued');
    const eduKeys = [...state.storage.map.keys()].filter((k) => k.startsWith('edu:edu.example.com:'));
    expect(eduKeys.length).toBe(1);
    expect(state.storage.map.get('server:edu.example.com')).toMatchObject({
      retryCount: 1,
    });
    expect(state.storage.alarm).toBeTypeOf('number');
  });
});

describe('FederationDurableObject TOKENMAXX clock boundaries after #61', () => {
  const NOW = 1_700_000_000_000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('serves cached keys while expires > now; exact expires forces remote fetch', async () => {
    const { state, do: fed } = makeFed();
    await state.storage.put('keys:edge.example.com', {
      data: { server_name: 'edge.example.com', verify_keys: { ed25519: 'a' } },
      expires: NOW + 1,
    });

    const hit = await fed.fetch(new Request('https://do/keys?server=edge.example.com'));
    expect(await hit.json()).toEqual({
      server_name: 'edge.example.com',
      verify_keys: { ed25519: 'a' },
    });

    // expires > Date.now() is false at equality → miss
    await state.storage.put('keys:edge.example.com', {
      data: { server_name: 'edge.example.com', verify_keys: { ed25519: 'a' } },
      expires: NOW,
    });
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const miss = await fed.fetch(new Request('https://do/keys?server=edge.example.com'));
    expect(miss.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://edge.example.com/_matrix/key/v2/server'
    );
  });

  it('caches remote keys for exactly 24h on successful fetch', async () => {
    const { state, do: fed } = makeFed();
    const remote = { server_name: 'fresh.example.com', verify_keys: { k: 'v' } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(remote), { status: 200 }))
    );

    const res = await fed.fetch(new Request('https://do/keys?server=fresh.example.com'));
    expect(await res.json()).toEqual(remote);
    expect(state.storage.map.get('keys:fresh.example.com')).toEqual({
      data: remote,
      expires: NOW + DAY_MS,
    });

    // Still cached at expires - 1
    vi.setSystemTime(NOW + DAY_MS - 1);
    vi.unstubAllGlobals();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const cached = await fed.fetch(new Request('https://do/keys?server=fresh.example.com'));
    expect(await cached.json()).toEqual(remote);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pins first-retry backoff to +60s and second retry to +120s', async () => {
    const { state, do: fed } = makeFed();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('net');
      })
    );

    await fed.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          destination: 'backoff.example.com',
          event_id: '$e1',
          room_id: '!r:ex.com',
          pdu: { event_id: '$e1' },
        }),
      })
    );
    expect(state.storage.map.get('server:backoff.example.com')).toMatchObject({
      retryCount: 1,
      nextRetry: NOW + 60_000,
    });
    expect(state.storage.alarm).toBe(NOW + 60_000);

    // Second failure: delay = min(60000 * 2^(2-1), day) = 120000
    vi.setSystemTime(NOW + 60_000);
    await (
      fed as unknown as { alarm: () => Promise<void> }
    ).alarm();
    expect(state.storage.map.get('server:backoff.example.com')).toMatchObject({
      retryCount: 2,
      nextRetry: NOW + 60_000 + 120_000,
    });
    expect(state.storage.alarm).toBe(NOW + 60_000 + 120_000);
  });

  it('caps retry backoff at 1 day', async () => {
    const { state, do: fed } = makeFed();
    await state.storage.put('server:cap.example.com', {
      serverName: 'cap.example.com',
      lastContact: 0,
      retryCount: 20,
      nextRetry: null,
    });
    await state.storage.put('queue:cap.example.com:$e', {
      event_id: '$e',
      room_id: '!r:ex.com',
      destination: 'cap.example.com',
      pdu: { event_id: '$e' },
      created_at: NOW,
      retry_count: 20,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('net');
      })
    );

    // Trigger process via alarm with due nextRetry
    await state.storage.put('server:cap.example.com', {
      serverName: 'cap.example.com',
      lastContact: 0,
      retryCount: 20,
      nextRetry: NOW,
    });
    await (fed as unknown as { alarm: () => Promise<void> }).alarm();

    expect(state.storage.map.get('server:cap.example.com')).toMatchObject({
      retryCount: 21,
      nextRetry: NOW + DAY_MS,
    });
    expect(state.storage.alarm).toBe(NOW + DAY_MS);
  });

  it('alarm processes nextRetry <= now and skips future nextRetry', async () => {
    const { state, do: fed } = makeFed();
    // Missing DB makes processFederationQueue fail before network; scheduleRetry still runs.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('net');
      })
    );

    await state.storage.put('server:due.example.com', {
      serverName: 'due.example.com',
      lastContact: 0,
      retryCount: 1,
      nextRetry: NOW, // exact equality: nextRetry <= now → process
    });
    await state.storage.put('queue:due.example.com:$due', {
      event_id: '$due',
      room_id: '!r:ex.com',
      destination: 'due.example.com',
      pdu: { event_id: '$due' },
      created_at: NOW - 1,
      retry_count: 1,
    });

    await state.storage.put('server:later.example.com', {
      serverName: 'later.example.com',
      lastContact: 0,
      retryCount: 1,
      nextRetry: NOW + 1, // strictly future → skip
    });
    await state.storage.put('queue:later.example.com:$later', {
      event_id: '$later',
      room_id: '!r:ex.com',
      destination: 'later.example.com',
      pdu: { event_id: '$later' },
      created_at: NOW - 1,
      retry_count: 1,
    });

    await state.storage.put('server:none.example.com', {
      serverName: 'none.example.com',
      lastContact: 1,
      retryCount: 0,
      nextRetry: null,
    });

    await (fed as unknown as { alarm: () => Promise<void> }).alarm();

    // due processed → retryCount bumped (backoff 2^1 → +120s from NOW)
    expect(state.storage.map.get('server:due.example.com')).toMatchObject({
      retryCount: 2,
      nextRetry: NOW + 120_000,
    });
    expect(state.storage.map.get('server:later.example.com')).toMatchObject({
      retryCount: 1,
      nextRetry: NOW + 1,
    });
    expect(state.storage.map.get('server:none.example.com')).toMatchObject({
      retryCount: 0,
      nextRetry: null,
    });
  });

  it('rejects /send when destination queue is already at 10000', async () => {
    const { state, do: fed } = makeFed();
    for (let i = 0; i < 10000; i++) {
      state.storage.map.set(`queue:full.example.com:$e${i}`, {
        event_id: `$e${i}`,
        destination: 'full.example.com',
        retry_count: 0,
      });
    }

    const res = await fed.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          destination: 'full.example.com',
          event_id: '$overflow',
          room_id: '!r:ex.com',
          pdu: { event_id: '$overflow' },
        }),
      })
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ errcode: 'M_LIMIT_EXCEEDED' });
    expect(state.storage.map.has('queue:full.example.com:$overflow')).toBe(false);
  });

  it('clears queue and EDUs on successful outbound send; pins lastContact', async () => {
    const nullKeyDb = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          },
        };
      },
    };
    const { state, do: fed } = makeFed(new FakeDurableObjectState(), {
      DB: nullKeyDb as unknown as Env['DB'],
      SERVER_NAME: 'local.example.com',
      CACHE: {
        get: async () => {
          throw new Error('no cache');
        },
        put: async () => {},
      } as unknown as Env['CACHE'],
    });

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ pdus: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fed.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          destination: 'ok.example.com',
          event_id: '$ok',
          room_id: '!r:ex.com',
          pdu: { event_id: '$ok' },
        }),
      })
    );
    expect(state.storage.map.has('queue:ok.example.com:$ok')).toBe(false);
    expect(state.storage.map.get('server:ok.example.com')).toEqual({
      serverName: 'ok.example.com',
      lastContact: NOW,
      retryCount: 0,
      nextRetry: null,
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'https://ok.example.com/_matrix/federation/v1/send/'
    );

    // EDU success path: fire-and-forget delete
    await fed.fetch(
      new Request('https://do/send-edu', {
        method: 'POST',
        body: JSON.stringify({
          destination: 'ok.example.com',
          edu_type: 'm.typing',
          content: { room_id: '!r:ex.com' },
        }),
      })
    );
    const eduKeys = [...state.storage.map.keys()].filter((k) =>
      k.startsWith('edu:ok.example.com:')
    );
    expect(eduKeys).toEqual([]);
  });

  it('keeps rejected PDUs under retry cap and drops at retry_count >= 32', async () => {
    const nullKeyDb = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          },
        };
      },
    };
    const { state, do: fed } = makeFed(new FakeDurableObjectState(), {
      DB: nullKeyDb as unknown as Env['DB'],
      SERVER_NAME: 'local.example.com',
      CACHE: {
        get: async () => {
          throw new Error('no cache');
        },
        put: async () => {},
      } as unknown as Env['CACHE'],
    });

    await state.storage.put('queue:rej.example.com:$keep', {
      event_id: '$keep',
      room_id: '!r:ex.com',
      destination: 'rej.example.com',
      pdu: { event_id: '$keep' },
      created_at: NOW,
      retry_count: 1,
    });
    await state.storage.put('queue:rej.example.com:$drop', {
      event_id: '$drop',
      room_id: '!r:ex.com',
      destination: 'rej.example.com',
      pdu: { event_id: '$drop' },
      created_at: NOW,
      retry_count: 32,
    });
    await state.storage.put('server:rej.example.com', {
      serverName: 'rej.example.com',
      lastContact: 0,
      retryCount: 1,
      nextRetry: NOW,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              pdus: {
                $keep: { error: 'soft fail' },
                $drop: { error: 'soft fail' },
              },
            }),
            { status: 200 }
          )
      )
    );

    await (fed as unknown as { alarm: () => Promise<void> }).alarm();

    expect(state.storage.map.has('queue:rej.example.com:$keep')).toBe(true);
    expect(state.storage.map.has('queue:rej.example.com:$drop')).toBe(false);
  });
});

describe('FederationDurableObject !ok maxedOut / signed send TOKENMAXX after #64', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('on HTTP !ok drops retry_count>=32 and schedulesRetry only for remaining', async () => {
    const nullKeyDb = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          },
        };
      },
    };
    const { state, do: fed } = makeFed(new FakeDurableObjectState(), {
      DB: nullKeyDb as unknown as Env['DB'],
      SERVER_NAME: 'local.example.com',
      CACHE: {
        get: async () => {
          throw new Error('no cache');
        },
        put: async () => {},
      } as unknown as Env['CACHE'],
    });

    await state.storage.put('queue:httpfail.example.com:$keep', {
      event_id: '$keep',
      room_id: '!r:ex.com',
      destination: 'httpfail.example.com',
      pdu: { event_id: '$keep' },
      created_at: NOW,
      retry_count: 1,
    });
    await state.storage.put('queue:httpfail.example.com:$drop', {
      event_id: '$drop',
      room_id: '!r:ex.com',
      destination: 'httpfail.example.com',
      pdu: { event_id: '$drop' },
      created_at: NOW,
      retry_count: 32,
    });
    await state.storage.put('server:httpfail.example.com', {
      serverName: 'httpfail.example.com',
      lastContact: 0,
      retryCount: 1,
      nextRetry: NOW,
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));

    await (fed as unknown as { alarm: () => Promise<void> }).alarm();

    expect(state.storage.map.has('queue:httpfail.example.com:$drop')).toBe(false);
    expect(state.storage.map.get('queue:httpfail.example.com:$keep')).toMatchObject({
      event_id: '$keep',
      retry_count: 2, // scheduleRetry increments from server.retryCount 1 → 2
    });
    expect(state.storage.map.get('server:httpfail.example.com')).toMatchObject({
      retryCount: 2,
      nextRetry: NOW + 120_000, // 60s * 2^(2-1)
    });
    expect(state.storage.alarm).toBe(NOW + 120_000);
  });

  it('attaches Authorization when a signing key is configured and clears queue on 200', async () => {
    const subtle = crypto.subtle;
    const origGenerateKey = subtle.generateKey.bind(subtle);
    const origImportKey = subtle.importKey.bind(subtle);
    const origSign = subtle.sign.bind(subtle);
    const mapAlg = (alg: AlgorithmIdentifier | { name?: string }): AlgorithmIdentifier => {
      if (typeof alg === 'string') return alg === 'NODE-ED25519' ? 'Ed25519' : alg;
      if (alg && typeof alg === 'object' && alg.name === 'NODE-ED25519') return 'Ed25519';
      return alg as AlgorithmIdentifier;
    };
    subtle.generateKey = ((a: AlgorithmIdentifier, e: boolean, u: KeyUsage[]) =>
      origGenerateKey(mapAlg(a), e, u)) as typeof subtle.generateKey;
    subtle.importKey = ((
      f: KeyFormat,
      d: BufferSource | JsonWebKey,
      a: AlgorithmIdentifier,
      e: boolean,
      u: KeyUsage[]
    ) => origImportKey(f, d, mapAlg(a), e, u)) as typeof subtle.importKey;
    subtle.sign = ((a: AlgorithmIdentifier, k: CryptoKey, d: BufferSource) =>
      origSign(mapAlg(a), k, d)) as typeof subtle.sign;

    try {
      const pair = await generateSigningKeyPair();
      const signedKeyDb = {
        prepare() {
          return {
            bind() {
              return this;
            },
            async first() {
              return {
                key_id: pair.keyId,
                private_key_jwk: JSON.stringify(pair.privateKeyJwk),
              };
            },
          };
        },
      };

      const { state, do: fed } = makeFed(new FakeDurableObjectState(), {
        DB: signedKeyDb as unknown as Env['DB'],
        SERVER_NAME: 'local.example.com',
        CACHE: {
          get: async () => {
            throw new Error('no cache');
          },
          put: async () => {},
        } as unknown as Env['CACHE'],
      });

      await state.storage.put('queue:signed.example.com:$s1', {
        event_id: '$s1',
        room_id: '!r:ex.com',
        destination: 'signed.example.com',
        pdu: { event_id: '$s1' },
        created_at: NOW,
        retry_count: 0,
      });
      await state.storage.put('server:signed.example.com', {
        serverName: 'signed.example.com',
        lastContact: 0,
        retryCount: 0,
        nextRetry: NOW,
      });

      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await (fed as unknown as { alarm: () => Promise<void> }).alarm();

      expect(state.storage.map.has('queue:signed.example.com:$s1')).toBe(false);
      expect(fetchMock).toHaveBeenCalled();
      const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^X-Matrix /);
      expect(headers.Authorization).toContain('origin="local.example.com"');
      expect(headers.Authorization).toContain(`key="${pair.keyId}"`);
    } finally {
      subtle.generateKey = origGenerateKey;
      subtle.importKey = origImportKey;
      subtle.sign = origSign;
    }
  });
});

describe('FederationDurableObject queue/keys/discovery edges after #71', () => {
  const NOW = 1_700_000_000_000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function nullKeyEnv(extra: Partial<Env> = {}): Partial<Env> {
    return {
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async first() {
              return null;
            },
          };
        },
      } as unknown as Env['DB'],
      SERVER_NAME: 'local.example.com',
      CACHE: {
        get: async () => {
          throw new Error('no cache');
        },
        put: async () => {},
      } as unknown as Env['CACHE'],
      ...extra,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('treats HTTP 200 non-JSON body as all-accepted and clears PDUs + EDUs', async () => {
    const { state, do: fed } = makeFed(new FakeDurableObjectState(), nullKeyEnv());
    await state.storage.put('queue:nonjson.example.com:$n1', {
      event_id: '$n1',
      room_id: '!r:ex.com',
      destination: 'nonjson.example.com',
      pdu: { event_id: '$n1' },
      created_at: NOW,
      retry_count: 0,
    });
    await state.storage.put('edu:nonjson.example.com:1:abc', {
      edu_type: 'm.typing',
      destination: 'nonjson.example.com',
      content: { room_id: '!r:ex.com' },
      created_at: NOW,
    });
    await state.storage.put('server:nonjson.example.com', {
      serverName: 'nonjson.example.com',
      lastContact: 0,
      retryCount: 3,
      nextRetry: NOW,
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })));

    await (fed as unknown as { alarm: () => Promise<void> }).alarm();

    expect(state.storage.map.has('queue:nonjson.example.com:$n1')).toBe(false);
    expect(
      [...state.storage.map.keys()].filter((k) => k.startsWith('edu:nonjson.example.com:'))
    ).toEqual([]);
    expect(state.storage.map.get('server:nonjson.example.com')).toEqual({
      serverName: 'nonjson.example.com',
      lastContact: NOW,
      retryCount: 0,
      nextRetry: null,
    });
  });

  it('on HTTP 200 keeps soft-rejected PDUs under cap, drops >=32, still deletes EDUs', async () => {
    const { state, do: fed } = makeFed(new FakeDurableObjectState(), nullKeyEnv());
    await state.storage.put('queue:mix.example.com:$ok', {
      event_id: '$ok',
      room_id: '!r:ex.com',
      destination: 'mix.example.com',
      pdu: { event_id: '$ok' },
      created_at: NOW,
      retry_count: 0,
    });
    await state.storage.put('queue:mix.example.com:$soft', {
      event_id: '$soft',
      room_id: '!r:ex.com',
      destination: 'mix.example.com',
      pdu: { event_id: '$soft' },
      created_at: NOW + 1,
      retry_count: 2,
    });
    await state.storage.put('queue:mix.example.com:$hard', {
      event_id: '$hard',
      room_id: '!r:ex.com',
      destination: 'mix.example.com',
      pdu: { event_id: '$hard' },
      created_at: NOW + 2,
      retry_count: 32,
    });
    await state.storage.put('edu:mix.example.com:1:x', {
      edu_type: 'm.typing',
      destination: 'mix.example.com',
      content: {},
      created_at: NOW,
    });
    await state.storage.put('server:mix.example.com', {
      serverName: 'mix.example.com',
      lastContact: 0,
      retryCount: 1,
      nextRetry: NOW,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              pdus: {
                $soft: { error: 'soft' },
                $hard: { error: 'hard' },
              },
            }),
            { status: 200 }
          )
      )
    );

    await (fed as unknown as { alarm: () => Promise<void> }).alarm();

    expect(state.storage.map.has('queue:mix.example.com:$ok')).toBe(false);
    expect(state.storage.map.has('queue:mix.example.com:$soft')).toBe(true);
    expect(state.storage.map.has('queue:mix.example.com:$hard')).toBe(false);
    expect(
      [...state.storage.map.keys()].filter((k) => k.startsWith('edu:mix.example.com:'))
    ).toEqual([]);
    expect(state.storage.map.get('server:mix.example.com')).toMatchObject({
      retryCount: 0,
      lastContact: NOW,
      nextRetry: null,
    });
  });

  it('on HTTP !ok when all events are maxedOut drops all and does not scheduleRetry', async () => {
    const { state, do: fed } = makeFed(new FakeDurableObjectState(), nullKeyEnv());
    await state.storage.put('queue:allmax.example.com:$a', {
      event_id: '$a',
      room_id: '!r:ex.com',
      destination: 'allmax.example.com',
      pdu: { event_id: '$a' },
      created_at: NOW,
      retry_count: 32,
    });
    await state.storage.put('queue:allmax.example.com:$b', {
      event_id: '$b',
      room_id: '!r:ex.com',
      destination: 'allmax.example.com',
      pdu: { event_id: '$b' },
      created_at: NOW,
      retry_count: 40,
    });
    await state.storage.put('server:allmax.example.com', {
      serverName: 'allmax.example.com',
      lastContact: 0,
      retryCount: 5,
      nextRetry: NOW,
    });
    state.storage.alarm = null;

    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));

    await (fed as unknown as { alarm: () => Promise<void> }).alarm();

    expect(state.storage.map.has('queue:allmax.example.com:$a')).toBe(false);
    expect(state.storage.map.has('queue:allmax.example.com:$b')).toBe(false);
    // No scheduleRetry → server record and alarm unchanged
    expect(state.storage.map.get('server:allmax.example.com')).toEqual({
      serverName: 'allmax.example.com',
      lastContact: 0,
      retryCount: 5,
      nextRetry: NOW,
    });
    expect(state.storage.alarm).toBeNull();
  });

  it('uses discoverServer CACHE hit host/port via buildServerUrl', async () => {
    const discovery = JSON.stringify({
      host: 'fed.cdn.example.com',
      port: 8448,
      tlsHostname: 'cdn.example.com',
    });
    const { state, do: fed } = makeFed(
      new FakeDurableObjectState(),
      nullKeyEnv({
        CACHE: {
          get: async () => discovery,
          put: async () => {},
        } as unknown as Env['CACHE'],
      })
    );

    await state.storage.put('queue:cdn.example.com:$d1', {
      event_id: '$d1',
      room_id: '!r:ex.com',
      destination: 'cdn.example.com',
      pdu: { event_id: '$d1' },
      created_at: NOW,
      retry_count: 0,
    });
    await state.storage.put('server:cdn.example.com', {
      serverName: 'cdn.example.com',
      lastContact: 0,
      retryCount: 0,
      nextRetry: NOW,
    });

    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await (fed as unknown as { alarm: () => Promise<void> }).alarm();

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://fed.cdn.example.com:8448/_matrix/federation/v1/send/${NOW}`
    );
    expect(state.storage.map.has('queue:cdn.example.com:$d1')).toBe(false);
  });

  it('caches remote keys for 24h on ok and returns 404 when remote fetch throws', async () => {
    const { state, do: fed } = makeFed();
    const remote = { server_name: 'throw.example.com', verify_keys: {} };

    // First: expired cache → remote ok → cache NOW+24h
    await state.storage.put('keys:throw.example.com', {
      data: { stale: true },
      expires: NOW - 1,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(remote), { status: 200 }))
    );
    const ok = await fed.fetch(new Request('https://do/keys?server=throw.example.com'));
    expect(await ok.json()).toEqual(remote);
    expect(state.storage.map.get('keys:throw.example.com')).toEqual({
      data: remote,
      expires: NOW + DAY_MS,
    });

    // Force miss again and throw
    await state.storage.put('keys:throw.example.com', {
      data: remote,
      expires: NOW,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('dns');
      })
    );
    const miss = await fed.fetch(new Request('https://do/keys?server=throw.example.com'));
    expect(miss.status).toBe(404);
    expect(await miss.json()).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('accepts /send when queue size is 9999 (under hard cap)', async () => {
    const { state, do: fed } = makeFed(new FakeDurableObjectState(), nullKeyEnv());
    for (let i = 0; i < 9999; i++) {
      state.storage.map.set(`queue:near.example.com:$e${i}`, {
        event_id: `$e${i}`,
        destination: 'near.example.com',
        retry_count: 0,
      });
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    const res = await fed.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          destination: 'near.example.com',
          event_id: '$under',
          room_id: '!r:ex.com',
          pdu: { event_id: '$under' },
        }),
      })
    );
    expect(await res.text()).toBe('Queued');
    // processFederationQueue runs immediately; on 200 the new event is deleted
    expect(state.storage.map.has('queue:near.example.com:$under')).toBe(false);
  });

  it('alarm with due destination and empty queues is a no-op (no fetch)', async () => {
    const { state, do: fed } = makeFed(new FakeDurableObjectState(), nullKeyEnv());
    await state.storage.put('server:emptyq.example.com', {
      serverName: 'emptyq.example.com',
      lastContact: 1,
      retryCount: 2,
      nextRetry: NOW,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await (fed as unknown as { alarm: () => Promise<void> }).alarm();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.storage.map.get('server:emptyq.example.com')).toEqual({
      serverName: 'emptyq.example.com',
      lastContact: 1,
      retryCount: 2,
      nextRetry: NOW,
    });
  });

  it('batches PDU+EDU into one PUT and clears both queues on success', async () => {
    const { state, do: fed } = makeFed(new FakeDurableObjectState(), nullKeyEnv());
    await state.storage.put('queue:both.example.com:$p', {
      event_id: '$p',
      room_id: '!r:ex.com',
      destination: 'both.example.com',
      pdu: { event_id: '$p', type: 'm.room.message' },
      created_at: NOW,
      retry_count: 0,
    });
    await state.storage.put('edu:both.example.com:1:z', {
      edu_type: 'm.typing',
      destination: 'both.example.com',
      content: { room_id: '!r:ex.com' },
      created_at: NOW,
    });
    await state.storage.put('server:both.example.com', {
      serverName: 'both.example.com',
      lastContact: 0,
      retryCount: 0,
      nextRetry: NOW,
    });

    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await (fed as unknown as { alarm: () => Promise<void> }).alarm();

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({
      pdus: [{ event_id: '$p', type: 'm.room.message' }],
      edus: [{ edu_type: 'm.typing', content: { room_id: '!r:ex.com' } }],
    });
    expect(state.storage.map.has('queue:both.example.com:$p')).toBe(false);
    expect(
      [...state.storage.map.keys()].filter((k) => k.startsWith('edu:both.example.com:'))
    ).toEqual([]);
  });
});
