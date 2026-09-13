import { describe, it, expect, vi } from 'vitest';
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
