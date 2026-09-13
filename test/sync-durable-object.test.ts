import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FakeDurableObjectState,
  FakeWebSocket,
  durableObjectMockFactory,
} from './helpers/fake-durable-object';
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

const WAIT_CAP_MS = 25_000;

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

describe('SyncDurableObject alarm clock boundaries TOKENMAXX after #60', () => {
  const NOW = 1_700_000_000_000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('keeps events/connections at exact cutoff and deletes one ms older', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { state, do: sync } = makeSync();
    const cutoff = NOW - DAY_MS;

    await state.storage.put('event:$eq', {
      event_id: '$eq',
      room_id: '!r',
      type: 'm.room.message',
      timestamp: cutoff,
    });
    await state.storage.put('event:$older', {
      event_id: '$older',
      room_id: '!r',
      type: 'm.room.message',
      timestamp: cutoff - 1,
    });
    await state.storage.put('sliding_sync:eq', {
      pos: 1,
      lastAccess: cutoff,
      roomStates: {},
      listStates: {},
    });
    await state.storage.put('sliding_sync:older', {
      pos: 2,
      lastAccess: cutoff - 1,
      roomStates: {},
      listStates: {},
    });
    await state.storage.put('sliding_sync:no-access', {
      pos: 3,
      roomStates: {},
      listStates: {},
    });

    await (sync as unknown as { alarm: () => Promise<void> }).alarm();

    expect(state.storage.map.has('event:$eq')).toBe(true);
    expect(state.storage.map.has('event:$older')).toBe(false);
    expect(state.storage.map.has('sliding_sync:eq')).toBe(true);
    expect(state.storage.map.has('sliding_sync:older')).toBe(false);
    // lastAccess falsy → condition skipped → kept
    expect(state.storage.map.has('sliding_sync:no-access')).toBe(true);
    expect(state.storage.alarm).toBe(NOW + 3600_000);
    vi.useRealTimers();
  });

  it('filters in-memory pendingEvents with the same >= cutoff rule', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { do: sync } = makeSync();
    const cutoff = NOW - DAY_MS;

    // Seed via notify (in-memory + storage depending on impl) then age wall clock
    await sync.fetch(
      new Request('https://do/notify', {
        method: 'POST',
        body: JSON.stringify({
          event_id: '$mem-old',
          room_id: '!r:ex.com',
          type: 'm.room.message',
          timestamp: cutoff - 1,
        }),
      })
    );
    await sync.fetch(
      new Request('https://do/notify', {
        method: 'POST',
        body: JSON.stringify({
          event_id: '$mem-eq',
          room_id: '!r:ex.com',
          type: 'm.room.message',
          timestamp: cutoff,
        }),
      })
    );

    await (sync as unknown as { alarm: () => Promise<void> }).alarm();

    const pending = await sync.fetch(new Request('https://do/pending?since=0'));
    const body = (await pending.json()) as { events: Array<{ event_id: string }> };
    const ids = body.events.map((e) => e.event_id);
    expect(ids).toContain('$mem-eq');
    expect(ids).not.toContain('$mem-old');
    vi.useRealTimers();
  });
});

describe('SyncDurableObject wait/pending TOKENMAXX clock boundaries after #62', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults missing timeout to 25s and does not resolve 1ms early', async () => {
    const { do: sync } = makeSync();
    const pending = sync.fetch(
      new Request('https://do/wait-for-events', {
        method: 'POST',
        body: JSON.stringify({}),
      })
    );

    await vi.advanceTimersByTimeAsync(WAIT_CAP_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await (await pending).json()).toEqual({ hasEvents: false });
  });

  it('caps timeout above 25s at exactly the 25s cap', async () => {
    const { do: sync } = makeSync();
    const pending = sync.fetch(
      new Request('https://do/wait-for-events', {
        method: 'POST',
        body: JSON.stringify({ timeout: 60_000 }),
      })
    );

    await vi.advanceTimersByTimeAsync(WAIT_CAP_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await (await pending).json()).toEqual({ hasEvents: false });
  });

  it('excludes pending events at exact since (strict >) and includes since+1', async () => {
    const { do: sync } = makeSync();
    const SINCE = 1_700_000_000_000;

    await sync.fetch(
      new Request('https://do/notify', {
        method: 'POST',
        body: JSON.stringify({
          event_id: '$eq',
          room_id: '!r:ex.com',
          type: 'm.room.message',
          timestamp: SINCE,
        }),
      })
    );
    await sync.fetch(
      new Request('https://do/notify', {
        method: 'POST',
        body: JSON.stringify({
          event_id: '$after',
          room_id: '!r:ex.com',
          type: 'm.room.message',
          timestamp: SINCE + 1,
        }),
      })
    );

    const body = (await (
      await sync.fetch(new Request(`https://do/pending?since=${SINCE}`))
    ).json()) as { events: Array<{ event_id: string }> };
    expect(body.events.map((e) => e.event_id)).toEqual(['$after']);
  });

  it('wakes all concurrent waiters on a single notify before any timeout', async () => {
    const { do: sync } = makeSync();
    const w1 = sync.fetch(
      new Request('https://do/wait-for-events', {
        method: 'POST',
        body: JSON.stringify({ timeout: 5_000 }),
      })
    );
    const w2 = sync.fetch(
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
          event_id: '$wake-both',
          room_id: '!r:ex.com',
          type: 'm.room.message',
          timestamp: 42,
        }),
      })
    );

    expect(await (await w1).json()).toEqual({ hasEvents: true });
    expect(await (await w2).json()).toEqual({ hasEvents: true });
  });

  it('serves sliding-sync state from in-memory cache after PUT without re-read miss', async () => {
    const { state, do: sync } = makeSync();
    const payload = {
      pos: 7,
      lastAccess: 99,
      roomStates: { '!r:ex.com': { lastStreamOrdering: 1, sentState: true } },
      listStates: {},
    };
    await sync.fetch(
      new Request('https://do/sliding-sync/state?conn_id=cache1', {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
    );
    // Wipe storage so a cache miss would return null
    state.storage.map.delete('sliding_sync:cache1');

    const get = await sync.fetch(
      new Request('https://do/sliding-sync/state?conn_id=cache1')
    );
    expect(await get.json()).toMatchObject({ pos: 7, lastAccess: 99 });
  });

  it('sorts pending events by timestamp ascending across notifies', async () => {
    const { do: sync } = makeSync();
    await sync.fetch(
      new Request('https://do/notify', {
        method: 'POST',
        body: JSON.stringify({
          event_id: '$late',
          room_id: '!r:ex.com',
          type: 'm.room.message',
          timestamp: 300,
        }),
      })
    );
    await sync.fetch(
      new Request('https://do/notify', {
        method: 'POST',
        body: JSON.stringify({
          event_id: '$early',
          room_id: '!r:ex.com',
          type: 'm.room.message',
          timestamp: 100,
        }),
      })
    );

    const body = (await (
      await sync.fetch(new Request('https://do/pending?since=0'))
    ).json()) as { events: Array<{ event_id: string; timestamp: number }> };
    expect(body.events.map((e) => e.event_id)).toEqual(['$early', '$late']);
    expect(body.events.map((e) => e.timestamp)).toEqual([100, 300]);
  });
});

describe('SyncDurableObject websocket / notify fan-out TOKENMAXX after #64', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requires user_id on /websocket upgrade', async () => {
    const { do: sync } = makeSync();
    const res = await sync.fetch(
      new Request('https://do/websocket?since=0', {
        headers: { Upgrade: 'websocket' },
      })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Missing user_id');
  });

  it('accepts websocket upgrade, tags session, and pushes pending sync events', async () => {
    const { state, do: sync } = makeSync();
    await state.storage.put('event:$e1', {
      event_id: '$e1',
      room_id: '!r:ex.com',
      type: 'm.room.message',
      timestamp: 50,
    });
    await state.storage.put('event:$e2', {
      event_id: '$e2',
      room_id: '!r:ex.com',
      type: 'm.room.message',
      timestamp: 150,
    });

    const client = new FakeWebSocket();
    const server = new FakeWebSocket();
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = client;
        1 = server;
      }
    );

    // Node's Response rejects status 101; exercise accept + pending send first.
    await expect(
      sync.fetch(
        new Request('https://do/websocket?user_id=@a:ex.com&device_id=D1&since=100', {
          headers: { Upgrade: 'websocket' },
        })
      )
    ).rejects.toThrow();

    expect(state.sockets).toContain(server);
    expect(server.tags).toEqual(['@a:ex.com']);
    expect(server.deserializeAttachment()).toEqual({
      userId: '@a:ex.com',
      deviceId: 'D1',
      lastSyncToken: '100',
    });
    expect(server.sent).toHaveLength(1);
    const pushed = JSON.parse(server.sent[0]) as {
      type: string;
      events: Array<{ event_id: string }>;
    };
    expect(pushed.type).toBe('sync');
    expect(pushed.events.map((e) => e.event_id)).toEqual(['$e2']);
  });

  it('fans out /notify to hibernated sockets and swallows closed-socket send errors', async () => {
    const { state, do: sync } = makeSync();
    const open = new FakeWebSocket();
    const closed = new FakeWebSocket();
    closed.send = () => {
      throw new Error('socket closed');
    };
    state.sockets.push(open, closed);

    const res = await sync.fetch(
      new Request('https://do/notify', {
        method: 'POST',
        body: JSON.stringify({
          event_id: '$n1',
          room_id: '!r:ex.com',
          type: 'm.room.message',
          timestamp: 42,
        }),
      })
    );
    expect(await res.text()).toBe('OK');
    expect(open.sent).toEqual([
      JSON.stringify({
        type: 'event',
        event: {
          event_id: '$n1',
          room_id: '!r:ex.com',
          type: 'm.room.message',
          timestamp: 42,
        },
      }),
    ]);
    expect(state.storage.map.get('event:$n1')).toMatchObject({ event_id: '$n1' });
  });

  it('webSocketMessage handles ping/ack and no-ops without session or bad payloads', async () => {
    const { do: sync } = makeSync();
    const ws = new FakeWebSocket();
    ws.serializeAttachment({
      userId: '@a:ex.com',
      deviceId: 'D1',
      lastSyncToken: '0',
    });
    (
      sync as unknown as {
        sessions: Map<FakeWebSocket, { userId: string; lastSyncToken: string }>;
      }
    ).sessions.set(ws, { userId: '@a:ex.com', lastSyncToken: '0' });

    const msg = (
      sync as unknown as {
        webSocketMessage: (ws: FakeWebSocket, m: string | ArrayBuffer) => Promise<void>;
      }
    ).webSocketMessage.bind(sync);

    await msg(ws, JSON.stringify({ type: 'ping' }));
    expect(ws.sent).toContain(JSON.stringify({ type: 'pong' }));

    await msg(ws, JSON.stringify({ type: 'ack', token: '99' }));
    expect(ws.deserializeAttachment()).toMatchObject({ lastSyncToken: '99' });

    const before = ws.sent.length;
    await msg(ws, new ArrayBuffer(0));
    await msg(ws, '{bad');
    await msg(ws, JSON.stringify({ type: 'unknown' }));
    expect(ws.sent.length).toBe(before);

    const bare = new FakeWebSocket();
    await msg(bare, JSON.stringify({ type: 'ping' }));
    expect(bare.sent).toEqual([]);
  });

  it('webSocketClose / webSocketError remove sessions', async () => {
    const { do: sync } = makeSync();
    const leaving = new FakeWebSocket();
    leaving.serializeAttachment({
      userId: '@a:ex.com',
      deviceId: null,
      lastSyncToken: '0',
    });
    const sessions = (
      sync as unknown as {
        sessions: Map<FakeWebSocket, { userId: string }>;
      }
    ).sessions;
    sessions.set(leaving, { userId: '@a:ex.com' });

    await (
      sync as unknown as {
        webSocketClose: (
          ws: FakeWebSocket,
          code: number,
          reason: string,
          clean: boolean
        ) => Promise<void>;
      }
    ).webSocketClose(leaving, 1000, 'bye', true);
    expect(sessions.has(leaving)).toBe(false);
    expect(leaving.closed).toEqual({ code: 1000, reason: 'bye' });

    const errWs = new FakeWebSocket();
    errWs.serializeAttachment({ userId: '@b:ex.com', deviceId: null, lastSyncToken: '0' });
    sessions.set(errWs, { userId: '@b:ex.com' });
    await (
      sync as unknown as {
        webSocketError: (ws: FakeWebSocket, err: unknown) => Promise<void>;
      }
    ).webSocketError(errWs, new Error('boom'));
    expect(sessions.has(errWs)).toBe(false);
  });

  it('caps getPendingEvents storage scan at 1000 keys', async () => {
    const { state, do: sync } = makeSync();
    for (let i = 0; i < 1005; i++) {
      const id = `$e${String(i).padStart(4, '0')}`;
      await state.storage.put(`event:${id}`, {
        event_id: id,
        room_id: '!r:ex.com',
        type: 'm.room.message',
        timestamp: i + 1,
      });
    }

    const body = (await (
      await sync.fetch(new Request('https://do/pending?since=0'))
    ).json()) as { events: unknown[] };
    expect(body.events).toHaveLength(1000);
  });
});
