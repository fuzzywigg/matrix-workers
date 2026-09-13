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
