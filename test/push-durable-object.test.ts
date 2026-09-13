import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeDurableObjectState, durableObjectMockFactory } from './helpers/fake-durable-object';
import type { Env } from '../src/types';

vi.mock('cloudflare:workers', () => durableObjectMockFactory());

import { PushDurableObject } from '../src/durable-objects/PushDurableObject';

function makePush(env: Partial<Env> = {}) {
  const state = new FakeDurableObjectState();
  return {
    state,
    do: new PushDurableObject(state as unknown as DurableObjectState, env as Env),
  };
}

type PendingPush = {
  id: string;
  notification: {
    pushkey: string;
    topic: string;
    payload: { aps: Record<string, unknown> };
  };
  attempts: number;
  lastAttempt?: number;
  error?: string;
};

function pendingMap(push: PushDurableObject): Map<string, PendingPush> {
  return (push as unknown as { pendingPushes: Map<string, PendingPush> }).pendingPushes;
}

describe('PushDurableObject TOKENMAXX edge paths after #57', () => {
  it('returns 404 for unknown paths and empty status when idle', async () => {
    const { do: push } = makePush();
    expect((await push.fetch(new Request('https://do/nope'))).status).toBe(404);

    const status = await push.fetch(new Request('https://do/status'));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ pendingCount: 0, pending: [] });
  });

  it('returns APNs-not-configured without calling network when secrets unset', async () => {
    const { do: push } = makePush();
    const res = await push.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          pushkey: 'device-token',
          topic: 'io.element.elementx',
          payload: { aps: { alert: 'hi' } },
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: false,
      error: 'APNs not configured',
    });
  });

  it('batch send reports not-configured for each notification when secrets unset', async () => {
    const { do: push } = makePush();
    const res = await push.fetch(
      new Request('https://do/send-batch', {
        method: 'POST',
        body: JSON.stringify({
          notifications: [
            { pushkey: 'a', topic: 't', payload: { aps: {} } },
            { pushkey: 'b', topic: 't', payload: { aps: {} } },
          ],
        }),
      })
    );
    expect(await res.json()).toEqual({
      results: [
        { success: false, error: 'APNs not configured' },
        { success: false, error: 'APNs not configured' },
      ],
    });
  });
});

describe('PushDurableObject TOKENMAXX edge paths after #58', () => {
  it('returns 500 for invalid JSON on /send and /send-batch', async () => {
    const { do: push } = makePush();
    const send = await push.fetch(
      new Request('https://do/send', { method: 'POST', body: '{bad' })
    );
    expect(send.status).toBe(500);
    expect(await send.json()).toMatchObject({ success: false });

    const batch = await push.fetch(
      new Request('https://do/send-batch', { method: 'POST', body: '{bad' })
    );
    expect(batch.status).toBe(500);
    expect(await batch.json()).toMatchObject({ success: false });
  });

  it('returns 404 for wrong methods on gated paths', async () => {
    const { do: push } = makePush();
    expect((await push.fetch(new Request('https://do/send'))).status).toBe(404);
    expect((await push.fetch(new Request('https://do/send-batch'))).status).toBe(404);
    expect(
      (await push.fetch(new Request('https://do/status', { method: 'POST' }))).status
    ).toBe(404);
  });

  it('alarm is a no-op when pendingPushes is empty', async () => {
    const { state, do: push } = makePush();
    await (push as unknown as { alarm: () => Promise<void> }).alarm();
    expect(state.storage.alarm).toBeNull();
  });
});

describe('PushDurableObject TOKENMAXX clock boundaries after #61', () => {
  const NOW = 1_700_000_000_000;
  const RETRY_DELAY = 60_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops pending pushes with attempts >= 3 without retrying', async () => {
    const { state, do: push } = makePush();
    pendingMap(push).set('give-up', {
      id: 'give-up',
      notification: {
        pushkey: 'tok',
        topic: 'io.element.elementx',
        payload: { aps: { alert: 'x' } },
      },
      attempts: 3,
      lastAttempt: NOW - RETRY_DELAY,
    });

    await (push as unknown as { alarm: () => Promise<void> }).alarm();
    expect(pendingMap(push).size).toBe(0);
    expect(state.storage.alarm).toBeNull();
  });

  it('skips retry while now - lastAttempt < 60s; retries at exact 60s', async () => {
    const { do: push } = makePush();
    pendingMap(push).set('soon', {
      id: 'soon',
      notification: {
        pushkey: 'tok',
        topic: 't',
        payload: { aps: {} },
      },
      attempts: 0,
      lastAttempt: NOW - (RETRY_DELAY - 1),
    });

    await (push as unknown as { alarm: () => Promise<void> }).alarm();
    expect(pendingMap(push).get('soon')?.attempts).toBe(0);

    vi.setSystemTime(NOW + 1); // lastAttempt was NOW-(RETRY_DELAY-1); now - last = RETRY_DELAY
    await (push as unknown as { alarm: () => Promise<void> }).alarm();
    // APNs unset → send fails; attempts bumped, stays pending
    expect(pendingMap(push).get('soon')?.attempts).toBe(1);
    expect(pendingMap(push).get('soon')?.lastAttempt).toBe(NOW + 1);
    expect(pendingMap(push).get('soon')?.error).toBe('APNs not configured');
  });

  it('retries immediately when lastAttempt is undefined', async () => {
    const { state, do: push } = makePush();
    pendingMap(push).set('fresh', {
      id: 'fresh',
      notification: {
        pushkey: 'tok',
        topic: 't',
        payload: { aps: {} },
      },
      attempts: 0,
    });

    await (push as unknown as { alarm: () => Promise<void> }).alarm();
    expect(pendingMap(push).get('fresh')?.attempts).toBe(1);
    expect(pendingMap(push).get('fresh')?.lastAttempt).toBe(NOW);
    expect(state.storage.alarm).toBe(NOW + RETRY_DELAY);
  });

  it('reschedules alarm while pending remain after failed retry', async () => {
    const { state, do: push } = makePush();
    pendingMap(push).set('a', {
      id: 'a',
      notification: { pushkey: '1', topic: 't', payload: { aps: {} } },
      attempts: 1,
      lastAttempt: NOW - RETRY_DELAY,
    });
    pendingMap(push).set('b', {
      id: 'b',
      notification: { pushkey: '2', topic: 't', payload: { aps: {} } },
      attempts: 2,
      lastAttempt: NOW - RETRY_DELAY,
    });

    await (push as unknown as { alarm: () => Promise<void> }).alarm();
    expect(pendingMap(push).size).toBe(2);
    expect(pendingMap(push).get('a')?.attempts).toBe(2);
    expect(pendingMap(push).get('b')?.attempts).toBe(3);
    expect(state.storage.alarm).toBe(NOW + RETRY_DELAY);
  });

  it('status returns pendingCount and only the first 10 pending entries', async () => {
    const { do: push } = makePush();
    for (let i = 0; i < 12; i++) {
      pendingMap(push).set(`p${i}`, {
        id: `p${i}`,
        notification: { pushkey: `t${i}`, topic: 't', payload: { aps: {} } },
        attempts: i,
      });
    }

    const status = await push.fetch(new Request('https://do/status'));
    const body = (await status.json()) as {
      pendingCount: number;
      pending: PendingPush[];
    };
    expect(body.pendingCount).toBe(12);
    expect(body.pending).toHaveLength(10);
    expect(body.pending[0].id).toBe('p0');
    expect(body.pending[9].id).toBe('p9');
  });

  it('removes pending on successful APNs retry (mocked sendAPNs)', async () => {
    const { state, do: push } = makePush();
    pendingMap(push).set('ok', {
      id: 'ok',
      notification: { pushkey: 'tok', topic: 't', payload: { aps: {} } },
      attempts: 0,
    });

    vi.spyOn(
      push as unknown as { sendAPNs: () => Promise<{ success: boolean }> },
      'sendAPNs'
    ).mockResolvedValue({ success: true });

    await (push as unknown as { alarm: () => Promise<void> }).alarm();
    expect(pendingMap(push).size).toBe(0);
    expect(state.storage.alarm).toBeNull();
  });
});

/** PKCS#8 PEM for ES256 (P-256) — generated once per suite. */
async function generateApnsPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const b64 = Buffer.from(pkcs8).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}

function apnsEnv(
  pem: string,
  extra: Partial<Env> = {}
): Partial<Env> {
  return {
    APNS_KEY_ID: 'KEYID123',
    APNS_TEAM_ID: 'TEAMID456',
    APNS_PRIVATE_KEY: pem,
    ...extra,
  };
}

describe('PushDurableObject TOKENMAXX APNs configured path after #74', () => {
  let pem: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    pem = await generateApnsPem();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends to production host with alert type, default priority, and apns-id', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'apns-id': 'apns-uuid-1' },
      })
    );
    const { do: push } = makePush(apnsEnv(pem));

    const res = await push.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          pushkey: 'abc123token',
          topic: 'io.element.elementx',
          payload: { aps: { alert: 'hi', badge: 1 } },
        }),
      })
    );
    expect(await res.json()).toEqual({ success: true, apnsId: 'apns-uuid-1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.push.apple.com/3/device/abc123token');
    const headers = init.headers as Record<string, string>;
    expect(headers['apns-topic']).toBe('io.element.elementx');
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-priority']).toBe('10');
    expect(headers['authorization']).toMatch(/^bearer /);
    expect(headers['apns-expiration']).toBeUndefined();
    expect(headers['apns-collapse-id']).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      aps: { alert: 'hi', badge: 1 },
    });
  });

  it('uses sandbox host when APNS_ENVIRONMENT is sandbox', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const { do: push } = makePush(apnsEnv(pem, { APNS_ENVIRONMENT: 'sandbox' }));

    await push.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          pushkey: 'tok',
          topic: 't',
          payload: { aps: { alert: 'x' } },
        }),
      })
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.sandbox.push.apple.com/3/device/tok'
    );
  });

  it('strips angle brackets and whitespace from pushkey; background type for content-available', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const { do: push } = makePush(apnsEnv(pem));

    await push.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          pushkey: '< ab cd >',
          topic: 't',
          payload: { aps: { 'content-available': 1 } },
          priority: 5,
          expiration: 99,
          collapseId: 'collapse-1',
        }),
      })
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.push.apple.com/3/device/abcd');
    const headers = init.headers as Record<string, string>;
    expect(headers['apns-push-type']).toBe('background');
    expect(headers['apns-priority']).toBe('5');
    expect(headers['apns-expiration']).toBe('99');
    expect(headers['apns-collapse-id']).toBe('collapse-1');
  });

  it('caches JWT within 30m and regenerates after expiresAt', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const { do: push } = makePush(apnsEnv(pem));
    const signSpy = vi.spyOn(crypto.subtle, 'sign');

    await push.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          pushkey: 't1',
          topic: 't',
          payload: { aps: { alert: '1' } },
        }),
      })
    );
    const signsAfterFirst = signSpy.mock.calls.length;
    expect(signsAfterFirst).toBeGreaterThan(0);

    vi.setSystemTime(1_700_000_000_000 + 29 * 60 * 1000);
    await push.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          pushkey: 't2',
          topic: 't',
          payload: { aps: { alert: '2' } },
        }),
      })
    );
    expect(signSpy.mock.calls.length).toBe(signsAfterFirst);

    // jwtCache.expiresAt is unix seconds: now/1000 + 30*60 from first send
    vi.setSystemTime(1_700_000_000_000 + 30 * 60 * 1000);
    await push.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          pushkey: 't3',
          topic: 't',
          payload: { aps: { alert: '3' } },
        }),
      })
    );
    expect(signSpy.mock.calls.length).toBeGreaterThan(signsAfterFirst);
  });

  it('returns JSON reason on APNs error; raw body when non-JSON; missing apns-id ok', async () => {
    const { do: push } = makePush(apnsEnv(pem));

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 })
    );
    expect(
      await (
        await push.fetch(
          new Request('https://do/send', {
            method: 'POST',
            body: JSON.stringify({
              pushkey: 'bad',
              topic: 't',
              payload: { aps: { alert: 'x' } },
            }),
          })
        )
      ).json()
    ).toEqual({
      success: false,
      error: 'APNs 400',
      reason: 'BadDeviceToken',
    });

    fetchMock.mockResolvedValueOnce(new Response('plain failure', { status: 500 }));
    expect(
      await (
        await push.fetch(
          new Request('https://do/send', {
            method: 'POST',
            body: JSON.stringify({
              pushkey: 'bad2',
              topic: 't',
              payload: { aps: { alert: 'x' } },
            }),
          })
        )
      ).json()
    ).toEqual({
      success: false,
      error: 'APNs 500',
      reason: 'plain failure',
    });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(
      await (
        await push.fetch(
          new Request('https://do/send', {
            method: 'POST',
            body: JSON.stringify({
              pushkey: 'ok',
              topic: 't',
              payload: { aps: { alert: 'x' } },
            }),
          })
        )
      ).json()
    ).toEqual({ success: true });
  });

  it('maps fetch throw Error.message and non-Error to Request failed', async () => {
    const { do: push } = makePush(apnsEnv(pem));

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    expect(
      await (
        await push.fetch(
          new Request('https://do/send', {
            method: 'POST',
            body: JSON.stringify({
              pushkey: 't',
              topic: 't',
              payload: { aps: {} },
            }),
          })
        )
      ).json()
    ).toEqual({ success: false, error: 'network down' });

    fetchMock.mockRejectedValueOnce('string-reject');
    expect(
      await (
        await push.fetch(
          new Request('https://do/send', {
            method: 'POST',
            body: JSON.stringify({
              pushkey: 't',
              topic: 't',
              payload: { aps: {} },
            }),
          })
        )
      ).json()
    ).toEqual({ success: false, error: 'Request failed' });
  });

  it('imports PEM with EC PRIVATE KEY headers stripped', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const ecPem = pem
      .replace('BEGIN PRIVATE KEY', 'BEGIN EC PRIVATE KEY')
      .replace('END PRIVATE KEY', 'END EC PRIVATE KEY');
    const { do: push } = makePush(apnsEnv(ecPem));

    const res = await push.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          pushkey: 'tok',
          topic: 't',
          payload: { aps: { alert: 'ec' } },
        }),
      })
    );
    expect(await res.json()).toMatchObject({ success: true });
  });

  it('parses DER signatures via derToRaw when sign returns non-64-byte DER', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const { do: push } = makePush(apnsEnv(pem));

    // Craft DER: 0x30 len 0x02 rLen [r with leading 0] 0x02 sLen [s]
    const r = new Uint8Array(33);
    r[0] = 0;
    r.fill(0xaa, 1);
    const s = new Uint8Array(32);
    s.fill(0xbb);
    const der = new Uint8Array(2 + 2 + 33 + 2 + 32);
    let o = 0;
    der[o++] = 0x30;
    der[o++] = 2 + 33 + 2 + 32;
    der[o++] = 0x02;
    der[o++] = 33;
    der.set(r, o);
    o += 33;
    der[o++] = 0x02;
    der[o++] = 32;
    der.set(s, o);

    const signSpy = vi.spyOn(crypto.subtle, 'sign').mockResolvedValue(der.buffer);

    const res = await push.fetch(
      new Request('https://do/send', {
        method: 'POST',
        body: JSON.stringify({
          pushkey: 'tok',
          topic: 't',
          payload: { aps: { alert: 'der' } },
        }),
      })
    );
    expect(await res.json()).toMatchObject({ success: true });
    expect(signSpy).toHaveBeenCalled();
    // JWT third segment should be base64url of 64-byte raw r||s
    const auth = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    const jwt = auth.authorization.replace(/^bearer /, '');
    const sigPart = jwt.split('.')[2];
    const raw = Buffer.from(sigPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(raw.length).toBe(64);
    expect([...raw.slice(0, 32)]).toEqual([...new Uint8Array(32).fill(0xaa)]);
    expect([...raw.slice(32)]).toEqual([...new Uint8Array(32).fill(0xbb)]);
  });

  it('returns send failure when derToRaw rejects invalid DER', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const { do: push } = makePush(apnsEnv(pem));

    // length !== 64 and missing 0x02 markers
    const bad = new Uint8Array([0x30, 0x04, 0xff, 0xff, 0xff, 0xff]);
    vi.spyOn(crypto.subtle, 'sign').mockResolvedValue(bad.buffer);

    expect(
      await (
        await push.fetch(
          new Request('https://do/send', {
            method: 'POST',
            body: JSON.stringify({
              pushkey: 'tok',
              topic: 't',
              payload: { aps: { alert: 'bad-der' } },
            }),
          })
        )
      ).json()
    ).toEqual({ success: false, error: 'Invalid DER signature' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('batch send mixes success and failure with credentials configured', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { 'apns-id': 'ok-1' } })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 })
      );
    const { do: push } = makePush(apnsEnv(pem));

    const res = await push.fetch(
      new Request('https://do/send-batch', {
        method: 'POST',
        body: JSON.stringify({
          notifications: [
            { pushkey: 'a', topic: 't', payload: { aps: { alert: '1' } } },
            { pushkey: 'b', topic: 't', payload: { aps: { alert: '2' } } },
          ],
        }),
      })
    );
    expect(await res.json()).toEqual({
      results: [
        { success: true, apnsId: 'ok-1' },
        { success: false, error: 'APNs 410', reason: 'Unregistered' },
      ],
    });
  });

  it('partial credentials (missing any of key/team/pem) still report not configured', async () => {
    for (const env of [
      { APNS_KEY_ID: 'k', APNS_TEAM_ID: 't' },
      { APNS_KEY_ID: 'k', APNS_PRIVATE_KEY: pem },
      { APNS_TEAM_ID: 't', APNS_PRIVATE_KEY: pem },
    ] as Partial<Env>[]) {
      const { do: push } = makePush(env);
      expect(
        await (
          await push.fetch(
            new Request('https://do/send', {
              method: 'POST',
              body: JSON.stringify({
                pushkey: 'tok',
                topic: 't',
                payload: { aps: {} },
              }),
            })
          )
        ).json()
      ).toEqual({ success: false, error: 'APNs not configured' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
