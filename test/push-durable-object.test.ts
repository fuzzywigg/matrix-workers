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
