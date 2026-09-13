import { describe, it, expect, vi } from 'vitest';
import {
  FakeDurableObjectState,
  FakeWebSocket,
  durableObjectMockFactory,
} from './helpers/fake-durable-object';
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

describe('RoomDurableObject TOKENMAXX edge paths after #58', () => {
  it('returns idle /state with empty connections', async () => {
    const { do: room } = makeRoom();
    const res = await room.fetch(new Request('https://do/state'));
    expect(await res.json()).toEqual({
      room_id: '',
      connected_users: [],
      connection_count: 0,
    });
  });

  it('persists threaded receipts and includes thread_id in GET response', async () => {
    const { state, do: room } = makeRoom();
    await room.fetch(
      new Request('https://do/receipt', {
        method: 'PUT',
        body: JSON.stringify({
          user_id: '@a:ex.com',
          event_id: '$e2',
          receipt_type: 'm.read',
          thread_id: '$root',
        }),
      })
    );
    expect(state.storage.map.has('receipt:@a:ex.com:m.read:$root')).toBe(true);

    const body = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
      receipts: Record<string, Record<string, Record<string, { ts: number; thread_id?: string }>>>;
    };
    expect(body.receipts.$e2['m.read']['@a:ex.com'].thread_id).toBe('$root');
  });

  it('loads legacy receipt keys missing user_id into Matrix-shaped GET', async () => {
    const { state, do: room } = makeRoom();
    await state.storage.put('receipt:@legacy:ex.com:m.read', {
      event_id: '$legacy',
      receipt_type: 'm.read',
      ts: 42,
    });

    const body = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
      receipts: Record<string, Record<string, Record<string, { ts: number }>>>;
    };
    expect(body.receipts.$legacy['m.read']['@legacy:ex.com'].ts).toBe(42);
  });

  it('clamps typing timeout to 120s max', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { do: room } = makeRoom();

    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: '@a:ex.com', typing: true, timeout: 999_999 }),
      })
    );
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: ['@a:ex.com'],
    });

    vi.setSystemTime(10_000 + 120_000 + 1);
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: [],
    });
    vi.useRealTimers();
  });

  it('broadcasts JSON to connected sockets via /broadcast', async () => {
    const { state, do: room } = makeRoom();
    const ws = new FakeWebSocket();
    state.sockets.push(ws);

    const res = await room.fetch(
      new Request('https://do/broadcast', {
        method: 'POST',
        body: JSON.stringify({ type: 'custom', value: 1 }),
      })
    );
    expect(await res.text()).toBe('OK');
    expect(ws.sent).toEqual([JSON.stringify({ type: 'custom', value: 1 })]);
  });
});
