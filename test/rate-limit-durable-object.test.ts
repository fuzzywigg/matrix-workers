import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeDurableObjectState, durableObjectMockFactory } from './helpers/fake-durable-object';

vi.mock('cloudflare:workers', () => durableObjectMockFactory());

import { RateLimitDurableObject } from '../src/durable-objects/RateLimitDurableObject';

function makeDo(state = new FakeDurableObjectState()) {
  return {
    state,
    do: new RateLimitDurableObject(
      state as unknown as DurableObjectState,
      {} as Record<string, unknown>
    ),
  };
}

async function check(
  rateLimitDo: RateLimitDurableObject,
  clientId: string,
  limit: number,
  windowMs: number
) {
  const res = await rateLimitDo.fetch(
    new Request('https://do/', {
      method: 'POST',
      body: JSON.stringify({ action: 'check', clientId, limit, windowMs }),
    })
  );
  return { status: res.status, body: await res.json() };
}

describe('RateLimitDurableObject TOKENMAXX edge paths after #57', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('allows then rejects once the sliding window limit is hit', async () => {
    const { do: rateLimitDo } = makeDo();
    const first = await check(rateLimitDo, 'ip:1', 2, 60_000);
    expect(first.body).toMatchObject({ allowed: true, remaining: 1 });
    const second = await check(rateLimitDo, 'ip:1', 2, 60_000);
    expect(second.body).toMatchObject({ allowed: true, remaining: 0 });
    const third = await check(rateLimitDo, 'ip:1', 2, 60_000);
    expect(third.body).toMatchObject({ allowed: false, remaining: 0 });
    expect((third.body as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it('starts a fresh window after the prior window expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { do: rateLimitDo } = makeDo();
    await check(rateLimitDo, 'ip:2', 1, 1_000);
    expect((await check(rateLimitDo, 'ip:2', 1, 1_000)).body).toMatchObject({
      allowed: false,
    });
    vi.setSystemTime(1_000_000 + 1_001);
    expect((await check(rateLimitDo, 'ip:2', 1, 1_000)).body).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  it('resets a client counter and cleans up expired entries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { state, do: rateLimitDo } = makeDo();

    await check(rateLimitDo, 'ip:3', 1, 60_000);
    expect((await check(rateLimitDo, 'ip:3', 1, 60_000)).body).toMatchObject({
      allowed: false,
    });

    const reset = await rateLimitDo.fetch(
      new Request('https://do/', {
        method: 'POST',
        body: JSON.stringify({ action: 'reset', clientId: 'ip:3' }),
      })
    );
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ success: true });
    expect((await check(rateLimitDo, 'ip:3', 1, 60_000)).body).toMatchObject({
      allowed: true,
    });

    // Seed an aged entry via check, then jump past maxAge (2 minutes)
    await check(rateLimitDo, 'ip:old', 5, 60_000);
    vi.setSystemTime(2_000_000 + 3 * 60 * 1000);
    const cleanup = await rateLimitDo.fetch(
      new Request('https://do/', {
        method: 'POST',
        body: JSON.stringify({ action: 'cleanup' }),
      })
    );
    expect(await cleanup.json()).toEqual({ success: true });
    // After cleanup + expired window, next check starts fresh
    expect((await check(rateLimitDo, 'ip:old', 5, 60_000)).body).toMatchObject({
      allowed: true,
      remaining: 4,
    });
    expect(state.storage.alarm).not.toBeNull();
  });

  it('returns 400 for unknown actions and 500 for invalid JSON', async () => {
    const { do: rateLimitDo } = makeDo();
    const unknown = await rateLimitDo.fetch(
      new Request('https://do/', {
        method: 'POST',
        body: JSON.stringify({ action: 'explode', clientId: 'x' }),
      })
    );
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: 'Unknown action' });

    const bad = await rateLimitDo.fetch(
      new Request('https://do/', { method: 'POST', body: '{not-json' })
    );
    expect(bad.status).toBe(500);
    expect(await bad.json()).toEqual({ error: 'Internal error' });
  });

  it('alarm clears counters and clears cleanupAlarm when empty', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    const { do: rateLimitDo } = makeDo();
    await check(rateLimitDo, 'ip:4', 5, 60_000);
    // Age past cleanup maxAge so alarm wipe empties the map
    vi.setSystemTime(3_000_000 + 3 * 60 * 1000);
    await (rateLimitDo as unknown as { alarm: () => Promise<void> }).alarm();
    expect((await check(rateLimitDo, 'ip:4', 5, 60_000)).body).toMatchObject({
      allowed: true,
      remaining: 4,
    });
  });
});
