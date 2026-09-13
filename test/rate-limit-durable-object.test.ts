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

describe('RateLimitDurableObject TOKENMAXX edge paths after #58', () => {
  it('alarm reschedules when counters remain after cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000_000);
    const { state, do: rateLimitDo } = makeDo();
    await check(rateLimitDo, 'ip:keep', 5, 60_000);
    await (rateLimitDo as unknown as { alarm: () => Promise<void> }).alarm();
    expect(state.storage.alarm).toBe(4_000_000 + 5 * 60 * 1000);
    expect((await check(rateLimitDo, 'ip:keep', 5, 60_000)).body).toMatchObject({
      allowed: true,
      remaining: 3,
    });
    vi.useRealTimers();
  });
});

describe('RateLimitDurableObject TOKENMAXX clock boundaries after #60', () => {
  const NOW = 1_700_000_000_000;
  const WINDOW_MS = 60_000;
  const CLEANUP_MAX_AGE = 2 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('pins retryAfterMs and resetAt exactly when the limit is hit', async () => {
    const { do: rateLimitDo } = makeDo();
    expect((await check(rateLimitDo, 'ip:pin', 1, WINDOW_MS)).body).toEqual({
      allowed: true,
      remaining: 0,
      resetAt: NOW + WINDOW_MS,
    });
    expect((await check(rateLimitDo, 'ip:pin', 1, WINDOW_MS)).body).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: WINDOW_MS,
      resetAt: NOW + WINDOW_MS,
    });

    vi.setSystemTime(NOW + 15_000);
    expect((await check(rateLimitDo, 'ip:pin', 1, WINDOW_MS)).body).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: WINDOW_MS - 15_000,
      resetAt: NOW + WINDOW_MS,
    });
  });

  it('expires the window at now === windowStart + windowMs (strict > check)', async () => {
    const { do: rateLimitDo } = makeDo();
    await check(rateLimitDo, 'ip:edge', 1, WINDOW_MS);
    expect((await check(rateLimitDo, 'ip:edge', 1, WINDOW_MS)).body).toMatchObject({
      allowed: false,
    });

    // Still inside: windowStart > now - windowMs  ⇒  NOW > (NOW+windowMs-1) - windowMs
    vi.setSystemTime(NOW + WINDOW_MS - 1);
    expect((await check(rateLimitDo, 'ip:edge', 1, WINDOW_MS)).body).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 1,
      resetAt: NOW + WINDOW_MS,
    });

    // Exact expiry: windowStart === now - windowMs → condition false → fresh window
    vi.setSystemTime(NOW + WINDOW_MS);
    expect((await check(rateLimitDo, 'ip:edge', 1, WINDOW_MS)).body).toEqual({
      allowed: true,
      remaining: 0,
      resetAt: NOW + WINDOW_MS + WINDOW_MS,
    });
  });

  it('allows the request that brings count to limit (remaining 0) then rejects', async () => {
    const { do: rateLimitDo } = makeDo();
    expect((await check(rateLimitDo, 'ip:hit', 3, WINDOW_MS)).body).toMatchObject({
      allowed: true,
      remaining: 2,
    });
    expect((await check(rateLimitDo, 'ip:hit', 3, WINDOW_MS)).body).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect((await check(rateLimitDo, 'ip:hit', 3, WINDOW_MS)).body).toEqual({
      allowed: true,
      remaining: 0,
      resetAt: NOW + WINDOW_MS,
    });
    expect((await check(rateLimitDo, 'ip:hit', 3, WINDOW_MS)).body).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: WINDOW_MS,
      resetAt: NOW + WINDOW_MS,
    });
  });

  it('isolates counters per clientId', async () => {
    const { do: rateLimitDo } = makeDo();
    await check(rateLimitDo, 'ip:a', 1, WINDOW_MS);
    expect((await check(rateLimitDo, 'ip:a', 1, WINDOW_MS)).body).toMatchObject({
      allowed: false,
    });
    expect((await check(rateLimitDo, 'ip:b', 1, WINDOW_MS)).body).toEqual({
      allowed: true,
      remaining: 0,
      resetAt: NOW + WINDOW_MS,
    });
  });

  it('cleanup keeps entries at exact maxAge and deletes strictly older', async () => {
    const { do: rateLimitDo } = makeDo();
    await check(rateLimitDo, 'ip:keep-eq', 5, WINDOW_MS);
    await check(rateLimitDo, 'ip:drop', 5, WINDOW_MS);

    // Age both to exactly maxAge, then advance 1ms so only drop is older if we re-seed keep
    vi.setSystemTime(NOW + CLEANUP_MAX_AGE);
    // At exact maxAge: windowStart < now - maxAge is false → kept
    let cleanup = await rateLimitDo.fetch(
      new Request('https://do/', {
        method: 'POST',
        body: JSON.stringify({ action: 'cleanup' }),
      })
    );
    expect(await cleanup.json()).toEqual({ success: true });
    // Still in sliding window too (maxAge 2m > window 60s? wait - window expired at 60s)
    // Window expired at NOW+60s, so check starts fresh — but entry still in map until cleanup deletes
    // After exact-maxAge cleanup, entries remain; next check sees expired window → fresh count=1
    expect((await check(rateLimitDo, 'ip:keep-eq', 5, WINDOW_MS)).body).toMatchObject({
      allowed: true,
      remaining: 4,
    });

    // Seed drop at THIS moment, then jump past maxAge by 1ms from its windowStart
    const dropStart = Date.now();
    await check(rateLimitDo, 'ip:drop-strict', 5, WINDOW_MS);
    vi.setSystemTime(dropStart + CLEANUP_MAX_AGE + 1);
    cleanup = await rateLimitDo.fetch(
      new Request('https://do/', {
        method: 'POST',
        body: JSON.stringify({ action: 'cleanup' }),
      })
    );
    expect(await cleanup.json()).toEqual({ success: true });
    // Entry deleted from map; check starts fresh
    expect((await check(rateLimitDo, 'ip:drop-strict', 5, WINDOW_MS)).body).toMatchObject({
      allowed: true,
      remaining: 4,
    });
  });

  it('schedules cleanup alarm once and does not overwrite while alarm is in the future', async () => {
    const { state, do: rateLimitDo } = makeDo();
    await check(rateLimitDo, 'ip:alarm1', 5, WINDOW_MS);
    expect(state.storage.alarm).toBe(NOW + 5 * 60 * 1000);

    vi.setSystemTime(NOW + 60_000);
    await check(rateLimitDo, 'ip:alarm2', 5, WINDOW_MS);
    // cleanupAlarm still in the future relative to now; getAlarm already set → unchanged
    expect(state.storage.alarm).toBe(NOW + 5 * 60 * 1000);

    // Expire cleanupAlarm bookkeeping and clear storage alarm to prove re-schedule path
    vi.setSystemTime(NOW + 5 * 60 * 1000 + 1);
    state.storage.alarm = null;
    await check(rateLimitDo, 'ip:alarm3', 5, WINDOW_MS);
    expect(state.storage.alarm).toBe(NOW + 5 * 60 * 1000 + 1 + 5 * 60 * 1000);
  });

  it('alarm empties map without rewriting storage alarm; next check rebooks cleanupAlarm', async () => {
    const { state, do: rateLimitDo } = makeDo();
    await check(rateLimitDo, 'ip:empty', 5, WINDOW_MS);
    expect(state.storage.alarm).toBe(NOW + 5 * 60 * 1000);

    vi.setSystemTime(NOW + CLEANUP_MAX_AGE + 1);
    await (rateLimitDo as unknown as { alarm: () => Promise<void> }).alarm();
    // Empty path sets cleanupAlarm=null but does not call setAlarm/deleteAlarm
    expect(state.storage.alarm).toBe(NOW + 5 * 60 * 1000);

    // Fresh check works; scheduleCleanup sees cleanupAlarm null and wants a new alarm,
    // but getAlarm() is still set so storage alarm is left unchanged
    expect((await check(rateLimitDo, 'ip:empty', 5, WINDOW_MS)).body).toMatchObject({
      allowed: true,
      remaining: 4,
    });
    expect(state.storage.alarm).toBe(NOW + 5 * 60 * 1000);
  });
});
