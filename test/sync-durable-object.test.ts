import { describe, it, expect, vi } from 'vitest';
import { FakeDurableObjectState, durableObjectMockFactory } from './helpers/fake-durable-object';
import type { Env } from '../src/types';

vi.mock('cloudflare:workers', () => durableObjectMockFactory());

import { SyncDurableObject } from '../src/durable-objects/SyncDurableObject';

function makeSync(state = new FakeDurableObjectState()) {
  return {
    state,
    do: new SyncDurableObject(state as unknown as DurableObjectState, {} as Env),
  };
}

async function waitForEventsTimeout(sync: SyncDurableObject, timeout: number) {
  vi.useFakeTimers();
  try {
    const pending = sync.fetch(
      new Request('https://do/wait-for-events', {
        method: 'POST',
        body: JSON.stringify({ timeout }),
      })
    );
    await vi.advanceTimersByTimeAsync(timeout);
    return pending;
  } finally {
    vi.useRealTimers();
  }
}

describe('SyncDurableObject TOKENMAXX edge paths after #57', () => {
  it('returns 404 for unknown paths', async () => {
    const { do: sync } = makeSync();
    const res = await sync.fetch(new Request('https://do/nope'));
    expect(res.status).toBe(404);
  });

  it('requires conn_id for sliding-sync GET/PUT state', async () => {
    const { do: sync } = makeSync();
    const get = await sync.fetch(new Request('https://do/sliding-sync/state'));
    expect(get.status).toBe(400);
    expect(await get.json()).toEqual({ error: 'Missing conn_id' });

    const put = await sync.fetch(
      new Request('https://do/sliding-sync/state', {
        method: 'PUT',
        body: JSON.stringify({ pos: 1 }),
      })
    );
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error: 'Missing conn_id' });
  });

  it('round-trips sliding-sync state through storage', async () => {
    const { state, do: sync } = makeSync();
    const payload = {
      pos: 42,
      lastAccess: 100,
      roomStates: {},
      listStates: { all: { roomIds: ['!r:ex.com'], count: 1 } },
    };
    const put = await sync.fetch(
      new Request('https://do/sliding-sync/state?conn_id=c1', {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ success: true });
    expect(state.storage.map.get('sliding_sync:c1')).toMatchObject({ pos: 42 });

    const get = await sync.fetch(new Request('https://do/sliding-sync/state?conn_id=c1'));
    expect(await get.json()).toMatchObject({ pos: 42, listStates: payload.listStates });

    const missing = await sync.fetch(new Request('https://do/sliding-sync/state?conn_id=none'));
    expect(await missing.json()).toBeNull();
  });

  it('returns empty pending events and filters by since after notify', async () => {
    const { do: sync } = makeSync();
    const empty = await sync.fetch(new Request('https://do/pending'));
    expect(await empty.json()).toEqual({ events: [] });

    await sync.fetch(
      new Request('https://do/notify', {
        method: 'POST',
        body: JSON.stringify({
          event_id: '$e1',
          room_id: '!r:ex.com',
          type: 'm.room.message',
          timestamp: 5000,
        }),
      })
    );

    const all = await sync.fetch(new Request('https://do/pending?since=0'));
    expect(await all.json()).toEqual({
      events: [
        {
          event_id: '$e1',
          room_id: '!r:ex.com',
          type: 'm.room.message',
          timestamp: 5000,
        },
      ],
    });

    const filtered = await sync.fetch(new Request('https://do/pending?since=5000'));
    expect(await filtered.json()).toEqual({ events: [] });
  });
});

describe('SyncDurableObject TOKENMAXX edge paths after #58', () => {
  it('times out /wait-for-events with hasEvents:false and rejects bad JSON with 500', async () => {
    const { do: sync } = makeSync();
    const timedOut = await waitForEventsTimeout(sync, 100);
    expect(await (await timedOut).json()).toEqual({ hasEvents: false });

    const bad = await sync.fetch(
      new Request('https://do/wait-for-events', { method: 'POST', body: '{bad' })
    );
    expect(bad.status).toBe(500);
    expect(await bad.json()).toMatchObject({ hasEvents: false, error: 'Internal error' });
  });

  it('wakes /wait-for-events when /notify arrives before timeout', async () => {
    const { do: sync } = makeSync();
    vi.useFakeTimers();
    try {
      const waitPromise = sync.fetch(
        new Request('https://do/wait-for-events', {
          method: 'POST',
          body: JSON.stringify({ timeout: 5_000 }),
        })
      );
      await Promise.resolve();
      await sync.fetch(
        new Request('https://do/notify', {
          method: 'POST',
          body: JSON.stringify({
            event_id: '$wake',
            room_id: '!r:ex.com',
            type: 'm.room.message',
            timestamp: 1,
          }),
        })
      );
      expect(await (await waitPromise).json()).toEqual({ hasEvents: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns 426 without websocket upgrade and 500 for bad sliding-sync PUT JSON', async () => {
    const { do: sync } = makeSync();
    const ws = await sync.fetch(new Request('https://do/websocket'));
    expect(ws.status).toBe(426);
    expect(await ws.text()).toBe('Expected websocket upgrade');

    const badPut = await sync.fetch(
      new Request('https://do/sliding-sync/state?conn_id=c1', {
        method: 'PUT',
        body: '{bad',
      })
    );
    expect(badPut.status).toBe(500);
    expect(await badPut.json()).toEqual({ error: 'Failed to save state' });
  });

  it('alarm cleans old events and stale sliding-sync state, keeps fresh, reschedules', async () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const { state, do: sync } = makeSync();
    await state.storage.put('event:$old', {
      event_id: '$old',
      room_id: '!r',
      type: 'm.room.message',
      timestamp: now - 25 * 60 * 60 * 1000,
    });
    await state.storage.put('sliding_sync:stale', {
      pos: 1,
      lastAccess: now - 25 * 60 * 60 * 1000,
      roomStates: {},
      listStates: {},
    });
    await state.storage.put('sliding_sync:fresh', {
      pos: 2,
      lastAccess: now,
      roomStates: {},
      listStates: {},
    });

    await (sync as unknown as { alarm: () => Promise<void> }).alarm();

    expect(state.storage.map.has('event:$old')).toBe(false);
    expect(state.storage.map.has('sliding_sync:stale')).toBe(false);
    expect(state.storage.map.has('sliding_sync:fresh')).toBe(true);
    expect(state.storage.alarm).toBe(now + 3600_000);
    vi.useRealTimers();
  });
});
