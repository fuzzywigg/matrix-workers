import { describe, it, expect, vi } from 'vitest';
import { FakeDurableObjectState, durableObjectMockFactory } from './helpers/fake-durable-object';
import type { Env } from '../src/types';

vi.mock('cloudflare:workers', () => durableObjectMockFactory());

import { RoomDurableObject } from '../src/durable-objects/RoomDurableObject';

function makeRoom(state = new FakeDurableObjectState()) {
  return {
    state,
    do: new RoomDurableObject(state as unknown as DurableObjectState, {} as Env),
  };
}

describe('RoomDurableObject TOKENMAXX edge paths after #57', () => {
  it('returns 404 for unknown paths and 426 without websocket upgrade', async () => {
    const { do: room } = makeRoom();
    expect((await room.fetch(new Request('https://do/nope'))).status).toBe(404);

    const ws = await room.fetch(new Request('https://do/websocket'));
    expect(ws.status).toBe(426);
    expect(await ws.text()).toBe('Expected websocket upgrade');
  });

  it('rejects websocket upgrade missing user_id or room_id', async () => {
    const { do: room } = makeRoom();
    const res = await room.fetch(
      new Request('https://do/websocket?user_id=@a:ex.com', {
        headers: { Upgrade: 'websocket' },
      })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Missing user_id or room_id');
  });

  it('sets and clears typing users with expiry cleanup on GET', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { do: room } = makeRoom();

    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: '@a:ex.com', typing: true, timeout: 5_000 }),
      })
    );
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: ['@a:ex.com'],
    });

    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: '@a:ex.com', typing: false }),
      })
    );
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: [],
    });

    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: '@b:ex.com', typing: true, timeout: 1_000 }),
      })
    );
    vi.setSystemTime(12_000);
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: [],
    });
    vi.useRealTimers();
  });

  it('persists receipts and returns Matrix-shaped receipts map', async () => {
    const { state, do: room } = makeRoom();
    const put = await room.fetch(
      new Request('https://do/receipt', {
        method: 'PUT',
        body: JSON.stringify({
          user_id: '@a:ex.com',
          event_id: '$e1',
          receipt_type: 'm.read',
        }),
      })
    );
    expect(put.status).toBe(200);
    expect(state.storage.map.has('receipt:@a:ex.com:m.read:unthreaded')).toBe(true);

    const get = await room.fetch(new Request('https://do/receipts'));
    const body = (await get.json()) as {
      receipts: Record<string, Record<string, Record<string, { ts: number }>>>;
    };
    expect(body.receipts.$e1['m.read']['@a:ex.com'].ts).toBeGreaterThan(0);
  });
});
