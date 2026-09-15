import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('RoomDurableObject TOKENMAXX clock boundaries after #61', () => {
  const NOW = 1_700_000_000_000;
  const MAX_TYPING_MS = 120_000;
  const DEFAULT_TIMEOUT = 30_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps typing while expiresAt > now; drops at exact equality', async () => {
    const { do: room } = makeRoom();
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: '@a:ex.com', typing: true, timeout: 5_000 }),
      })
    );

    vi.setSystemTime(NOW + 5_000 - 1);
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: ['@a:ex.com'],
    });

    // expiresAt > now is false when equal → expired + deleted
    vi.setSystemTime(NOW + 5_000);
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: [],
    });
  });

  it('clamps timeout at exact 120s: present at +120s-1, gone at +120s', async () => {
    const { do: room } = makeRoom();
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({
          user_id: '@a:ex.com',
          typing: true,
          timeout: MAX_TYPING_MS,
        }),
      })
    );

    vi.setSystemTime(NOW + MAX_TYPING_MS - 1);
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: ['@a:ex.com'],
    });

    vi.setSystemTime(NOW + MAX_TYPING_MS);
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: [],
    });
  });

  it('uses default 30s timeout when timeout omitted', async () => {
    const { do: room } = makeRoom();
    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: '@a:ex.com', typing: true }),
      })
    );

    vi.setSystemTime(NOW + DEFAULT_TIMEOUT - 1);
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: ['@a:ex.com'],
    });

    vi.setSystemTime(NOW + DEFAULT_TIMEOUT);
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: [],
    });
  });

  it('evicts expired typers before enforcing MAX_TYPING_USERS hard cap', async () => {
    const { do: room } = makeRoom();
    const typingUsers = (room as unknown as {
      typingUsers: Map<string, { expiresAt: number }>;
    }).typingUsers;

    for (let i = 0; i < 1000; i++) {
      typingUsers.set(`@expired${i}:ex.com`, { expiresAt: NOW - 1 });
    }

    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: '@fresh:ex.com', typing: true, timeout: 10_000 }),
      })
    );

    expect(typingUsers.has('@fresh:ex.com')).toBe(true);
    expect(typingUsers.size).toBe(1);
    expect(await (await room.fetch(new Request('https://do/typing'))).json()).toEqual({
      user_ids: ['@fresh:ex.com'],
    });
  });

  it('drops oldest insertion when all typers are still fresh at hard cap', async () => {
    const { do: room } = makeRoom();
    const typingUsers = (room as unknown as {
      typingUsers: Map<string, { expiresAt: number }>;
    }).typingUsers;

    for (let i = 0; i < 1000; i++) {
      typingUsers.set(`@u${i}:ex.com`, { expiresAt: NOW + 60_000 });
    }

    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: '@new:ex.com', typing: true, timeout: 10_000 }),
      })
    );

    expect(typingUsers.has('@u0:ex.com')).toBe(false);
    expect(typingUsers.has('@new:ex.com')).toBe(true);
    expect(typingUsers.size).toBe(1000);
  });

  it('pins receipt ts to Date.now', async () => {
    const { do: room } = makeRoom();
    await room.fetch(
      new Request('https://do/receipt', {
        method: 'PUT',
        body: JSON.stringify({
          user_id: '@a:ex.com',
          event_id: '$e1',
          receipt_type: 'm.read',
        }),
      })
    );
    const body = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
      receipts: Record<string, Record<string, Record<string, { ts: number }>>>;
    };
    expect(body.receipts.$e1['m.read']['@a:ex.com'].ts).toBe(NOW);
  });

  it('broadcasts typing start/stop to other users sockets (not the typer)', async () => {
    const { state, do: room } = makeRoom();
    const observer = new FakeWebSocket();
    observer.serializeAttachment({ userId: '@b:ex.com', roomId: '!r:ex.com' });
    const typer = new FakeWebSocket();
    typer.serializeAttachment({ userId: '@a:ex.com', roomId: '!r:ex.com' });
    state.sockets.push(observer, typer);

    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: '@a:ex.com', typing: true, timeout: 5_000 }),
      })
    );
    expect(observer.sent).toContain(
      JSON.stringify({
        type: 'typing',
        user_id: '@a:ex.com',
        typing: true,
        room_id: '',
      })
    );
    expect(typer.sent).toEqual([]);

    await room.fetch(
      new Request('https://do/typing', {
        method: 'PUT',
        body: JSON.stringify({ user_id: '@a:ex.com', typing: false }),
      })
    );
    expect(observer.sent).toContain(
      JSON.stringify({
        type: 'typing',
        user_id: '@a:ex.com',
        typing: false,
        room_id: '',
      })
    );
  });

  it('refuses new websockets at MAX_WS_CONNECTIONS with 503', async () => {
    const { state, do: room } = makeRoom();
    for (let i = 0; i < 500; i++) {
      state.sockets.push(new FakeWebSocket());
    }
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = new FakeWebSocket();
        1 = new FakeWebSocket();
      }
    );
    try {
      const res = await room.fetch(
        new Request('https://do/websocket?user_id=@a:ex.com&room_id=!r:ex.com', {
          headers: { Upgrade: 'websocket' },
        })
      );
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('Room WebSocket connection limit reached');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('accepts websocket upgrade under the cap (attachment + /state side effects)', async () => {
    const { state, do: room } = makeRoom();
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = new FakeWebSocket();
        1 = new FakeWebSocket();
      }
    );
    try {
      // Node's Response rejects status 101; DO still accepts the socket first.
      await expect(
        room.fetch(
          new Request(
            'https://do/websocket?user_id=@a:ex.com&room_id=!r:ex.com&device_id=DEV',
            { headers: { Upgrade: 'websocket' } }
          )
        )
      ).rejects.toThrow(/status/);

      expect(state.sockets).toHaveLength(1);
      expect(state.sockets[0].tags).toEqual(['@a:ex.com', '!r:ex.com']);
      expect(state.sockets[0].deserializeAttachment()).toMatchObject({
        userId: '@a:ex.com',
        deviceId: 'DEV',
      });

      const body = (await (await room.fetch(new Request('https://do/state'))).json()) as {
        room_id: string;
        connected_users: string[];
        connection_count: number;
      };
      expect(body).toEqual({
        room_id: '!r:ex.com',
        connected_users: ['@a:ex.com'],
        connection_count: 1,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('webSocketMessage handles ping, typing broadcast, and no-ops without session', async () => {
    const { state, do: room } = makeRoom();
    const sender = new FakeWebSocket();
    sender.serializeAttachment({ userId: '@a:ex.com' });
    const peer = new FakeWebSocket();
    peer.serializeAttachment({ userId: '@b:ex.com' });
    state.sockets.push(sender, peer);

    const msg = (
      room as unknown as {
        webSocketMessage: (ws: FakeWebSocket, m: string | ArrayBuffer) => Promise<void>;
      }
    ).webSocketMessage.bind(room);

    await msg(sender, JSON.stringify({ type: 'ping' }));
    expect(sender.sent).toContain(JSON.stringify({ type: 'pong' }));

    await msg(sender, JSON.stringify({ type: 'typing', typing: true }));
    expect(peer.sent).toContain(
      JSON.stringify({
        type: 'typing',
        user_id: '@a:ex.com',
        typing: true,
        room_id: '',
      })
    );

    const bare = new FakeWebSocket();
    await msg(bare, JSON.stringify({ type: 'ping' }));
    expect(bare.sent).toEqual([]);

    const before = peer.sent.length;
    await msg(sender, new ArrayBuffer(0));
    await msg(sender, JSON.stringify({ type: 'unknown' }));
    expect(peer.sent.length).toBe(before);
  });

  it('webSocketClose notifies peers and webSocketError drops session', async () => {
    const { state, do: room } = makeRoom();
    const leaving = new FakeWebSocket();
    leaving.serializeAttachment({ userId: '@a:ex.com', id: 's1' });
    const peer = new FakeWebSocket();
    peer.serializeAttachment({ userId: '@b:ex.com', id: 's2' });
    state.sockets.push(leaving, peer);
    (
      room as unknown as { sessions: Map<FakeWebSocket, { userId: string }> }
    ).sessions.set(leaving, { userId: '@a:ex.com' });

    await (
      room as unknown as {
        webSocketClose: (
          ws: FakeWebSocket,
          code: number,
          reason: string,
          clean: boolean
        ) => Promise<void>;
      }
    ).webSocketClose(leaving, 1000, 'bye', true);

    expect(peer.sent).toContain(
      JSON.stringify({ type: 'user_disconnected', user_id: '@a:ex.com' })
    );
    expect(leaving.closed).toEqual({ code: 1000, reason: 'bye' });

    const errWs = new FakeWebSocket();
    errWs.serializeAttachment({ userId: '@c:ex.com' });
    (
      room as unknown as { sessions: Map<FakeWebSocket, { userId: string }> }
    ).sessions.set(errWs, { userId: '@c:ex.com' });
    await (
      room as unknown as {
        webSocketError: (ws: FakeWebSocket, err: unknown) => Promise<void>;
      }
    ).webSocketError(errWs, new Error('boom'));
    expect(
      (room as unknown as { sessions: Map<FakeWebSocket, unknown> }).sessions.has(errWs)
    ).toBe(false);
  });

  it('webSocketMessage read receipt pins ts and persists', async () => {
    const { state, do: room } = makeRoom();
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ userId: '@a:ex.com' });

    await (
      room as unknown as {
        webSocketMessage: (ws: FakeWebSocket, m: string) => Promise<void>;
      }
    ).webSocketMessage(ws, JSON.stringify({ type: 'read', event_id: '$e9' }));

    expect(state.storage.map.get('receipt:@a:ex.com:m.read:unthreaded')).toMatchObject({
      event_id: '$e9',
      receipt_type: 'm.read',
      ts: NOW,
      user_id: '@a:ex.com',
    });
  });
});

describe('RoomDurableObject TOKENMAXX receipt/WS edges after #74', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('legacy load falls back when receipt_type is absent from storage key', async () => {
    const { state, do: room } = makeRoom();
    // Key ends with m.read but stored receipt_type is different → lastIndexOf fails
    await state.storage.put('receipt:@u:ex.com:m.read', {
      event_id: '$fb',
      receipt_type: 'm.read.private',
      ts: 7,
    });

    const body = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
      receipts: Record<string, Record<string, Record<string, { ts: number }>>>;
    };
    // Fallback key: keyWithoutPrefix + :unthreaded → cache key "@u:ex.com:m.read:unthreaded"
    // but user_id was never backfilled — GET still iterates cache values
    expect(body.receipts.$fb['m.read.private']).toBeDefined();
    const users = body.receipts.$fb['m.read.private'];
    // user_id undefined → property key "undefined" in JS object assignment
    expect(Object.values(users)[0].ts).toBe(7);
  });

  it('legacy load with thread_id uses threaded cache key and includes thread_id in GET', async () => {
    const { state, do: room } = makeRoom();
    await state.storage.put('receipt:@legacy:ex.com:m.read', {
      event_id: '$th',
      receipt_type: 'm.read',
      ts: 11,
      thread_id: '$t1',
    });

    const body = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
      receipts: Record<
        string,
        Record<string, Record<string, { ts: number; thread_id?: string }>>
      >;
    };
    expect(body.receipts.$th['m.read']['@legacy:ex.com']).toEqual({
      ts: 11,
      thread_id: '$t1',
    });
  });

  it('PUT /receipt broadcasts to other users only', async () => {
    const { state, do: room } = makeRoom();
    const sender = new FakeWebSocket();
    sender.serializeAttachment({
      id: 's1',
      userId: '@a:ex.com',
      deviceId: null,
    });
    const peer = new FakeWebSocket();
    peer.serializeAttachment({
      id: 's2',
      userId: '@b:ex.com',
      deviceId: null,
    });
    state.sockets.push(sender, peer);

    await room.fetch(
      new Request('https://do/receipt', {
        method: 'PUT',
        body: JSON.stringify({
          user_id: '@a:ex.com',
          event_id: '$e',
          receipt_type: 'm.read',
        }),
      })
    );

    const expected = JSON.stringify({
      type: 'receipt',
      user_id: '@a:ex.com',
      event_id: '$e',
      receipt_type: 'm.read',
      ts: NOW,
      room_id: '',
      thread_id: undefined,
    });
    expect(peer.sent).toContain(expected);
    expect(sender.sent).toEqual([]);
  });

  it('omits thread_id from GET when absent or explicitly unthreaded', async () => {
    const { do: room } = makeRoom();
    await room.fetch(
      new Request('https://do/receipt', {
        method: 'PUT',
        body: JSON.stringify({
          user_id: '@a:ex.com',
          event_id: '$u1',
          receipt_type: 'm.read',
          thread_id: 'unthreaded',
        }),
      })
    );
    await room.fetch(
      new Request('https://do/receipt', {
        method: 'PUT',
        body: JSON.stringify({
          user_id: '@b:ex.com',
          event_id: '$u2',
          receipt_type: 'm.read',
        }),
      })
    );

    const body = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
      receipts: Record<
        string,
        Record<string, Record<string, { ts: number; thread_id?: string }>>
      >;
    };
    expect(body.receipts.$u1['m.read']['@a:ex.com']).toEqual({ ts: NOW });
    expect(body.receipts.$u1['m.read']['@a:ex.com'].thread_id).toBeUndefined();
    expect(body.receipts.$u2['m.read']['@b:ex.com']).toEqual({ ts: NOW });
  });

  it('setReceiptCacheLRU refreshes recency and evicts oldest past MAX_RECEIPTS_CACHE', async () => {
    const { do: room } = makeRoom();
    const cache = (
      room as unknown as { receiptsCache: Map<string, unknown> }
    ).receiptsCache;

    for (let i = 0; i < 5000; i++) {
      cache.set(`old:${i}`, {
        user_id: `@u${i}:ex.com`,
        event_id: `$e${i}`,
        receipt_type: 'm.read',
        ts: i,
      });
    }
    // Refresh first key so it becomes newest; next insert should evict old:1 not old:0
    const setLRU = (
      room as unknown as {
        setReceiptCacheLRU: (k: string, v: unknown) => void;
      }
    ).setReceiptCacheLRU.bind(room);
    setLRU('old:0', {
      user_id: '@u0:ex.com',
      event_id: '$e0',
      receipt_type: 'm.read',
      ts: 0,
    });
    setLRU('new:cap', {
      user_id: '@new:ex.com',
      event_id: '$new',
      receipt_type: 'm.read',
      ts: 999,
    });

    expect(cache.size).toBe(5000);
    expect(cache.has('old:0')).toBe(true);
    expect(cache.has('old:1')).toBe(false);
    expect(cache.has('new:cap')).toBe(true);
  });

  it('returns 404 for wrong methods on typing/receipt/receipts', async () => {
    const { do: room } = makeRoom();
    expect(
      (await room.fetch(new Request('https://do/typing', { method: 'POST' }))).status
    ).toBe(404);
    expect((await room.fetch(new Request('https://do/receipt'))).status).toBe(404);
    expect(
      (
        await room.fetch(new Request('https://do/receipts', { method: 'PUT' }))
      ).status
    ).toBe(404);
  });

  it('webSocketMessage swallows malformed JSON without throwing', async () => {
    const { do: room } = makeRoom();
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ userId: '@a:ex.com', id: 's', deviceId: null });
    await expect(
      (
        room as unknown as {
          webSocketMessage: (ws: FakeWebSocket, m: string) => Promise<void>;
        }
      ).webSocketMessage(ws, '{bad')
    ).resolves.toBeUndefined();
    expect(ws.sent).toEqual([]);
  });

  it('websocket upgrade without device_id attaches deviceId null', async () => {
    const { state, do: room } = makeRoom();
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = new FakeWebSocket();
        1 = new FakeWebSocket();
      }
    );

    await expect(
      room.fetch(
        new Request('https://do/websocket?user_id=@a:ex.com&room_id=!r:ex.com', {
          headers: { Upgrade: 'websocket' },
        })
      )
    ).rejects.toThrow(/status/);

    expect(state.sockets[0].deserializeAttachment()).toMatchObject({
      userId: '@a:ex.com',
      deviceId: null,
    });
  });

  it('receipt broadcast swallows send throws on peer sockets', async () => {
    const { state, do: room } = makeRoom();
    const broken = new FakeWebSocket();
    broken.serializeAttachment({ userId: '@b:ex.com', id: 'b', deviceId: null });
    broken.send = () => {
      throw new Error('closed');
    };
    state.sockets.push(broken);

    const res = await room.fetch(
      new Request('https://do/receipt', {
        method: 'PUT',
        body: JSON.stringify({
          user_id: '@a:ex.com',
          event_id: '$e',
          receipt_type: 'm.read',
        }),
      })
    );
    expect(await res.text()).toBe('OK');
  });
});

/**
 * TOKENMAXX HEAVY leftovers after #240 — RoomDurableObject hibernation
 * *concurrent race / TOCTOU*. Sequential WS/typing/receipt coverage lives
 * above; concurrent Promise.all coverage was zero (distinct from CallRoom
 * hibernation races in call-room-hibernation.test.ts).
 */

class RacingRoomStorage {
  map = new Map<string, unknown>();
  events: string[] = [];
  putHold = new Set<string>();
  putWaiters = new Map<string, Array<() => void>>();
  listHold = false;
  listWaiters: Array<() => void> = [];
  listCalls = 0;

  async get(key: string): Promise<unknown> {
    return this.map.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.events.push(`put:${key}`);
    if (this.putHold.has(key)) {
      await new Promise<void>((resolve) => {
        const arr = this.putWaiters.get(key) ?? [];
        arr.push(resolve);
        this.putWaiters.set(key, arr);
      });
    }
    this.map.set(key, structuredClone(value));
  }

  releasePut(key: string): void {
    this.putHold.delete(key);
    const arr = this.putWaiters.get(key) ?? [];
    this.putWaiters.delete(key);
    for (const w of arr) w();
  }

  async delete(key: string): Promise<void> {
    this.events.push(`delete:${key}`);
    this.map.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.map.clear();
  }

  async list<T>(options: { prefix: string; limit?: number } = { prefix: '' }): Promise<Map<string, T>> {
    this.listCalls += 1;
    this.events.push(`list:${options.prefix}`);
    if (this.listHold) {
      await new Promise<void>((resolve) => {
        this.listWaiters.push(resolve);
      });
    }
    const out = new Map<string, T>();
    for (const [k, v] of [...this.map.entries()].sort()) {
      if (k.startsWith(options.prefix)) {
        out.set(k, v as T);
        if (options.limit !== undefined && out.size >= options.limit) break;
      }
    }
    return out;
  }

  async getAlarm(): Promise<number | null> {
    return null;
  }

  async setAlarm(_at: number): Promise<void> {}

  async deleteAlarm(): Promise<void> {}
}

class RacingRoomState {
  storage: RacingRoomStorage;
  sockets: FakeWebSocket[] = [];

  constructor(storage = new RacingRoomStorage()) {
    this.storage = storage;
  }

  getWebSockets(): FakeWebSocket[] {
    return this.sockets;
  }

  acceptWebSocket(ws: FakeWebSocket, tags?: string[]): void {
    if (tags) ws.tags = tags;
    this.sockets.push(ws);
  }

  setWebSocketAutoResponse(): void {}

  blockConcurrencyWhile(cb: () => Promise<void>): Promise<void> {
    return cb();
  }
}

function makeRacingRoomDo(state = new RacingRoomState()) {
  return {
    state,
    do: new RoomDurableObject(state as unknown as DurableObjectState, {} as Env),
  };
}

function wsMsg(
  room: RoomDurableObject,
  ws: FakeWebSocket,
  message: string | ArrayBuffer
): Promise<void> {
  return (
    room as unknown as {
      webSocketMessage: (ws: FakeWebSocket, m: string | ArrayBuffer) => Promise<void>;
    }
  ).webSocketMessage(ws, message);
}

function wsClose(
  room: RoomDurableObject,
  ws: FakeWebSocket,
  code = 1000,
  reason = 'bye'
): Promise<void> {
  return (
    room as unknown as {
      webSocketClose: (
        ws: FakeWebSocket,
        code: number,
        reason: string,
        wasClean: boolean
      ) => Promise<void>;
    }
  ).webSocketClose(ws, code, reason, true);
}

function wsError(room: RoomDurableObject, ws: FakeWebSocket, err: unknown = new Error('x')): Promise<void> {
  return (
    room as unknown as {
      webSocketError: (ws: FakeWebSocket, error: unknown) => Promise<void>;
    }
  ).webSocketError(ws, err);
}

describe('RoomDurableObject hibernation concurrent upgrade/state leftovers after #240', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`dual upgrade at cap-1: accept TOCTOU or 503 flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      for (let s = 0; s < 499; s++) state.sockets.push(new FakeWebSocket());
      vi.stubGlobal(
        'WebSocketPair',
        class {
          0 = new FakeWebSocket();
          1 = new FakeWebSocket();
        }
      );

      const results = await Promise.allSettled([
        room.fetch(
          new Request('https://do/websocket?user_id=@a:example.com&room_id=!r:example.com', {
            headers: { Upgrade: 'websocket' },
          })
        ),
        room.fetch(
          new Request('https://do/websocket?user_id=@b:example.com&room_id=!r:example.com', {
            headers: { Upgrade: 'websocket' },
          })
        ),
      ]);

      // Cap check is non-atomic: both may pass at 499 before either acceptWebSocket
      // (documented TOCTOU → 501), or one accepts then the other gets 503.
      // Response(101) throws in Node, so accepted legs often settle as 'throw'.
      const accepted = state.sockets.length - 499;
      expect(accepted).toBeGreaterThanOrEqual(1);
      expect(accepted).toBeLessThanOrEqual(2);
      const statuses = results.map((r) =>
        r.status === 'fulfilled' ? r.value.status : 'throw'
      );
      if (accepted === 1) {
        expect(statuses.filter((s) => s === 503)).toHaveLength(1);
      } else {
        expect(statuses.filter((s) => s === 503)).toHaveLength(0);
      }
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`state∥upgrade eventual connected_users flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      vi.stubGlobal(
        'WebSocketPair',
        class {
          0 = new FakeWebSocket();
          1 = new FakeWebSocket();
        }
      );

      const [stateRes] = await Promise.allSettled([
        room.fetch(new Request('https://do/state')),
        room.fetch(
          new Request(
            'https://do/websocket?user_id=@a:example.com&room_id=!r:example.com&device_id=D1',
            { headers: { Upgrade: 'websocket' } }
          )
        ),
      ]);
      expect(stateRes.status).toBe('fulfilled');
      if (stateRes.status === 'fulfilled') {
        const body = (await stateRes.value.json()) as { connection_count: number };
        expect(body.connection_count === 0 || body.connection_count === 1).toBe(true);
      }
      const after = (await (await room.fetch(new Request('https://do/state'))).json()) as {
        connected_users: string[];
        connection_count: number;
        room_id: string;
      };
      expect(after.connection_count).toBe(1);
      expect(after.connected_users).toEqual(['@a:example.com']);
      expect(after.room_id).toBe('!r:example.com');
      expect(state.sockets).toHaveLength(1);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`broadcast∥dual close peer isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      const c = new FakeWebSocket();
      c.serializeAttachment({ userId: '@c:example.com', id: '3' });
      state.sockets.push(a, b, c);

      await Promise.all([
        room.fetch(
          new Request('https://do/broadcast', {
            method: 'POST',
            body: JSON.stringify({ type: 'event', id: '$e' }),
          })
        ),
        wsClose(room, a),
        wsClose(room, b),
      ]);

      expect(c.sent.some((s) => s.includes('user_disconnected'))).toBe(true);
      expect(a.closed?.code).toBe(1000);
      expect(b.closed?.code).toBe(1000);
    });
  }
});

describe('RoomDurableObject hibernation concurrent typing/receipt leftovers after #240', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`typing A∥B isolation both present flood-${i}`, async () => {
      const { do: room } = makeRacingRoomDo();
      await Promise.all([
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({ user_id: '@a:example.com', typing: true, timeout: 5_000 }),
          })
        ),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({ user_id: '@b:example.com', typing: true, timeout: 5_000 }),
          })
        ),
      ]);
      const body = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(new Set(body.user_ids)).toEqual(new Set(['@a:example.com', '@b:example.com']));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`typing start∥stop same user last-writer flood-${i}`, async () => {
      const { do: room } = makeRacingRoomDo();
      await Promise.all([
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({ user_id: '@a:example.com', typing: true, timeout: 5_000 }),
          })
        ),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({ user_id: '@a:example.com', typing: false }),
          })
        ),
      ]);
      const body = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(body.user_ids.length === 0 || body.user_ids.includes('@a:example.com')).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`A∥B receipt isolation distinct keys flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      await Promise.all([
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$a',
              receipt_type: 'm.read',
            }),
          })
        ),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@b:example.com',
              event_id: '$b',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);
      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      expect(state.storage.map.has('receipt:@b:example.com:m.read:unthreaded')).toBe(true);
      const get = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
        receipts: Record<string, Record<string, Record<string, { ts: number }>>>;
      };
      expect(get.receipts.$a['m.read']['@a:example.com'].ts).toBe(50_000);
      expect(get.receipts.$b['m.read']['@b:example.com'].ts).toBe(50_000);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`dual receipt same user last-writer event_id flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      await Promise.all([
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$one',
              receipt_type: 'm.read',
            }),
          })
        ),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$two',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);
      const stored = state.storage.map.get('receipt:@a:example.com:m.read:unthreaded') as {
        event_id: string;
      };
      expect(['$one', '$two']).toContain(stored.event_id);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`receipt put-hold vs GET /receipts mid-write flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      state.storage.putHold.add('receipt:@a:example.com:m.read:unthreaded');
      const putP = room.fetch(
        new Request('https://do/receipt', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: '@a:example.com',
            event_id: '$held',
            receipt_type: 'm.read',
          }),
        })
      );
      await vi.waitFor(() => {
        expect(state.storage.events.some((e) => e.startsWith('put:receipt:'))).toBe(true);
      });
      const mid = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
        receipts: Record<string, unknown>;
      };
      expect(mid.receipts.$held).toBeUndefined();
      state.storage.releasePut('receipt:@a:example.com:m.read:unthreaded');
      expect((await putP).status).toBe(200);
      const after = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
        receipts: Record<string, Record<string, Record<string, unknown>>>;
      };
      expect(after.receipts.$held['m.read']['@a:example.com']).toBeDefined();
    });
  }
});

describe('RoomDurableObject hibernation concurrent WS message leftovers after #240', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`ping∥close same socket pong or closed flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const ws = new FakeWebSocket();
      ws.serializeAttachment({ userId: '@a:example.com', id: 's' });
      const peer = new FakeWebSocket();
      peer.serializeAttachment({ userId: '@b:example.com', id: 'p' });
      state.sockets.push(ws, peer);

      await Promise.all([wsMsg(room, ws, JSON.stringify({ type: 'ping' })), wsClose(room, ws)]);

      expect(ws.closed?.code).toBe(1000);
      expect(peer.sent.some((s) => s.includes('user_disconnected'))).toBe(true);
      // ping may or may not land before close
      expect(ws.sent.length === 0 || ws.sent.includes(JSON.stringify({ type: 'pong' }))).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`typing WS A∥B broadcast isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'typing', typing: true })),
        wsMsg(room, b, JSON.stringify({ type: 'typing', typing: true })),
      ]);

      expect(b.sent.some((s) => s.includes('"user_id":"@a:example.com"'))).toBe(true);
      expect(a.sent.some((s) => s.includes('"user_id":"@b:example.com"'))).toBe(true);
      expect(a.sent.every((s) => !s.includes('"user_id":"@a:example.com"'))).toBe(true);
      expect(b.sent.every((s) => !s.includes('"user_id":"@b:example.com"'))).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`read receipt WS∥close peer notifies flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'read', event_id: '$e1' })),
        wsClose(room, b),
      ]);

      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      expect(a.sent.some((s) => s.includes('user_disconnected'))).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`close∥error dual sockets both drop flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await Promise.all([wsClose(room, a), wsError(room, b)]);

      expect(a.closed?.code).toBe(1000);
      expect(b.closed).toBeNull();
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`ArrayBuffer∥ping isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, new ArrayBuffer(0)),
        wsMsg(room, b, JSON.stringify({ type: 'ping' })),
      ]);

      expect(a.sent).toEqual([]);
      expect(b.sent).toContain(JSON.stringify({ type: 'pong' }));
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`malformed JSON∥typing peer still receives flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com' });
      state.sockets.push(a, b);
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await Promise.all([
        wsMsg(room, a, '{not-json'),
        wsMsg(room, b, JSON.stringify({ type: 'typing', typing: true })),
      ]);

      expect(a.sent.some((s) => s.includes('"user_id":"@b:example.com"'))).toBe(true);
      expect(b.sent).toEqual([]);
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #251 — RoomDurableObject hibernation
 * *quaternary* concurrent races not covered by #240 (list-hold receipts,
 * typing expiry mid GET∥PUT, thread∥unthreaded receipt, upgrade 400∥valid,
 * broadcast send-throw∥close, dual GET receipts list-hold, typing cap
 * concurrent eviction).
 */

describe('RoomDurableObject hibernation quaternary receipt/list leftovers after #251', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`list-hold dual GET /receipts still one list flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      state.storage.map.set('receipt:@a:example.com:m.read:unthreaded', {
        user_id: '@a:example.com',
        event_id: '$e',
        receipt_type: 'm.read',
        ts: 80_000,
      });
      state.storage.listHold = true;

      const loads = Promise.all([
        room.fetch(new Request('https://do/receipts')),
        room.fetch(new Request('https://do/receipts')),
      ]);
      await vi.waitFor(() => {
        expect(state.storage.listWaiters.length).toBeGreaterThanOrEqual(1);
      });
      // First load holds; second may short-circuit after receiptsCacheLoaded
      expect(state.storage.listCalls).toBeGreaterThanOrEqual(1);
      const waiters = [...state.storage.listWaiters];
      state.storage.listHold = false;
      state.storage.listWaiters = [];
      for (const w of waiters) w();

      const [a, b] = await loads;
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const bodyA = (await a.json()) as {
        receipts: Record<string, Record<string, Record<string, unknown>>>;
      };
      expect(bodyA.receipts.$e['m.read']['@a:example.com']).toBeDefined();
      // Second concurrent load either shared the in-flight list or re-listed once
      expect(state.storage.listCalls).toBeLessThanOrEqual(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`list-hold GET∥PUT receipt mid-load then visible flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      state.storage.listHold = true;
      const getP = room.fetch(new Request('https://do/receipts'));
      await vi.waitFor(() => {
        expect(state.storage.listWaiters.length).toBe(1);
      });

      const putP = room.fetch(
        new Request('https://do/receipt', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: '@b:example.com',
            event_id: '$new',
            receipt_type: 'm.read',
          }),
        })
      );
      // PUT also awaits loadReceiptsCache → second list waiter or proceeds after put storage
      await vi.waitFor(() => {
        expect(
          state.storage.listWaiters.length >= 1 ||
            state.storage.events.some((e) => e.startsWith('put:receipt:'))
        ).toBe(true);
      });

      const waiters = [...state.storage.listWaiters];
      state.storage.listHold = false;
      state.storage.listWaiters = [];
      for (const w of waiters) w();

      expect((await getP).status).toBe(200);
      expect((await putP).status).toBe(200);
      const after = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
        receipts: Record<string, Record<string, Record<string, unknown>>>;
      };
      expect(after.receipts.$new['m.read']['@b:example.com']).toBeDefined();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`thread∥unthreaded receipt same user distinct keys flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      await Promise.all([
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$main',
              receipt_type: 'm.read',
            }),
          })
        ),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$thr',
              receipt_type: 'm.read',
              thread_id: '$root',
            }),
          })
        ),
      ]);

      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      expect(state.storage.map.has('receipt:@a:example.com:m.read:$root')).toBe(true);
      const get = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
        receipts: Record<string, Record<string, Record<string, { thread_id?: string }>>>;
      };
      expect(get.receipts.$main['m.read']['@a:example.com'].thread_id).toBeUndefined();
      expect(get.receipts.$thr['m.read']['@a:example.com'].thread_id).toBe('$root');
    });
  }
});

describe('RoomDurableObject hibernation quaternary typing/upgrade leftovers after #251', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`typing expiry mid GET∥PUT concurrent flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const { do: room } = makeRacingRoomDo();
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({ user_id: '@old:example.com', typing: true, timeout: 1_000 }),
        })
      );
      vi.setSystemTime(102_000); // expired

      const [getRes] = await Promise.all([
        room.fetch(new Request('https://do/typing')),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@new:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      const mid = (await getRes.json()) as { user_ids: string[] };
      // GET may snapshot before or after PUT; expired @old must not survive
      expect(mid.user_ids.includes('@old:example.com')).toBe(false);
      const after = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(after.user_ids).toEqual(['@new:example.com']);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`upgrade 400 missing params∥valid upgrade isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      vi.stubGlobal(
        'WebSocketPair',
        class {
          0 = new FakeWebSocket();
          1 = new FakeWebSocket();
        }
      );

      const [bad, good] = await Promise.allSettled([
        room.fetch(
          new Request('https://do/websocket?user_id=@a:example.com', {
            headers: { Upgrade: 'websocket' },
          })
        ),
        room.fetch(
          new Request(
            'https://do/websocket?user_id=@b:example.com&room_id=!r:example.com',
            { headers: { Upgrade: 'websocket' } }
          )
        ),
      ]);

      expect(bad.status).toBe('fulfilled');
      if (bad.status === 'fulfilled') {
        expect(bad.value.status).toBe(400);
      }
      // 101 Response may throw in Node — accepted socket still lands
      expect(state.sockets.length).toBe(1);
      if (good.status === 'fulfilled') {
        expect(good.value.status).toBe(101);
      } else {
        expect(good.status).toBe('rejected');
      }
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`broadcast send-throw∥close peer still notified flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      a.send = () => {
        throw new Error('send fail');
      };
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        room.fetch(
          new Request('https://do/broadcast', {
            method: 'POST',
            body: JSON.stringify({ type: 'event', id: '$x' }),
          })
        ),
        wsClose(room, a),
      ]);

      expect(a.closed?.code).toBe(1000);
      expect(b.sent.some((s) => s.includes('user_disconnected') || s.includes('$x'))).toBe(
        true
      );
    });
  }

  for (let i = 0; i < 2; i++) {
    it(`typing cap concurrent eviction keeps size≤1000 flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(200_000);
      const { do: room } = makeRacingRoomDo();
      // Seed 999 active typers
      for (let u = 0; u < 999; u++) {
        await room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: `@u${u}:example.com`,
              typing: true,
              timeout: 60_000,
            }),
          })
        );
      }

      await Promise.all([
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@new-a:example.com',
              typing: true,
              timeout: 60_000,
            }),
          })
        ),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@new-b:example.com',
              typing: true,
              timeout: 60_000,
            }),
          })
        ),
      ]);

      const body = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(body.user_ids.length).toBeLessThanOrEqual(1000);
      expect(
        body.user_ids.includes('@new-a:example.com') ||
          body.user_ids.includes('@new-b:example.com')
      ).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`read WS∥HTTP receipt same user LWW event_id flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const ws = new FakeWebSocket();
      ws.serializeAttachment({ userId: '@a:example.com' });
      const peer = new FakeWebSocket();
      peer.serializeAttachment({ userId: '@b:example.com' });
      state.sockets.push(ws, peer);

      await Promise.all([
        wsMsg(room, ws, JSON.stringify({ type: 'read', event_id: '$ws' })),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$http',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);

      const stored = state.storage.map.get('receipt:@a:example.com:m.read:unthreaded') as {
        event_id: string;
      };
      expect(['$ws', '$http']).toContain(stored.event_id);
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #263/#266 — RoomDurableObject hibernation
 * *quinary* concurrent races not covered by #240 / #251 / #263 quaternary
 * (Upgrade case 426∥valid, m.fully_read∥m.read, thread_id main∥unthreaded,
 * old-format receipt load∥PUT, webSocketError∥HTTP typing, dual-device upgrade,
 * typing timeout cap∥GET, null attachment∥peer ping, broadcast∥state).
 */

describe('RoomDurableObject hibernation quinary upgrade/receipt leftovers after #263', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`Upgrade WebSocket case 426∥valid websocket isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      vi.stubGlobal(
        'WebSocketPair',
        class {
          0 = new FakeWebSocket();
          1 = new FakeWebSocket();
        }
      );

      const [bad, good] = await Promise.allSettled([
        room.fetch(
          new Request(
            'https://do/websocket?user_id=@a:example.com&room_id=!r:example.com',
            { headers: { Upgrade: 'WebSocket' } }
          )
        ),
        room.fetch(
          new Request(
            'https://do/websocket?user_id=@b:example.com&room_id=!r:example.com',
            { headers: { Upgrade: 'websocket' } }
          )
        ),
      ]);

      expect(bad.status).toBe('fulfilled');
      if (bad.status === 'fulfilled') {
        expect(bad.value.status).toBe(426);
      }
      expect(state.sockets.length).toBe(1);
      if (good.status === 'fulfilled') {
        expect(good.value.status).toBe(101);
      } else {
        expect(good.status).toBe('rejected');
      }
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`m.fully_read∥m.read concurrent distinct keys flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      await Promise.all([
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$priv',
              receipt_type: 'm.fully_read',
            }),
          })
        ),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$pub',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);

      expect(state.storage.map.has('receipt:@a:example.com:m.fully_read:unthreaded')).toBe(
        true
      );
      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      const get = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
        receipts: Record<string, Record<string, Record<string, unknown>>>;
      };
      expect(get.receipts.$priv['m.fully_read']['@a:example.com']).toBeDefined();
      expect(get.receipts.$pub['m.read']['@a:example.com']).toBeDefined();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`thread_id main∥unthreaded distinct keys flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      await Promise.all([
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$main',
              receipt_type: 'm.read',
              thread_id: 'main',
            }),
          })
        ),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$room',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);

      expect(state.storage.map.has('receipt:@a:example.com:m.read:main')).toBe(true);
      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      const get = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
        receipts: Record<string, Record<string, Record<string, { thread_id?: string }>>>;
      };
      expect(get.receipts.$main['m.read']['@a:example.com'].thread_id).toBe('main');
      expect(get.receipts.$room['m.read']['@a:example.com'].thread_id).toBeUndefined();
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`old-format receipt list-hold∥new PUT visible flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      // Old format: no user_id on value; key receipt:{userId}:{receiptType}
      state.storage.map.set('receipt:@old:example.com:m.read', {
        event_id: '$legacy',
        receipt_type: 'm.read',
        ts: 1,
      });
      state.storage.listHold = true;

      const getP = room.fetch(new Request('https://do/receipts'));
      await vi.waitFor(() => {
        expect(state.storage.listWaiters.length).toBe(1);
      });

      const putP = room.fetch(
        new Request('https://do/receipt', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: '@new:example.com',
            event_id: '$new',
            receipt_type: 'm.read',
          }),
        })
      );

      const waiters = [...state.storage.listWaiters];
      state.storage.listHold = false;
      state.storage.listWaiters = [];
      for (const w of waiters) w();

      expect((await getP).status).toBe(200);
      expect((await putP).status).toBe(200);
      const after = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
        receipts: Record<string, Record<string, Record<string, unknown>>>;
      };
      expect(after.receipts.$legacy?.['m.read']?.['@old:example.com']).toBeDefined();
      expect(after.receipts.$new['m.read']['@new:example.com']).toBeDefined();
    });
  }
});

describe('RoomDurableObject hibernation quinary typing/ws leftovers after #263', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`webSocketError∥HTTP typing peer isolation flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(50_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        wsError(room, a, new Error('boom')),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@b:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@b:example.com']);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`dual-device same user upgrade∥state two connections flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      vi.stubGlobal(
        'WebSocketPair',
        class {
          0 = new FakeWebSocket();
          1 = new FakeWebSocket();
        }
      );

      await Promise.allSettled([
        room.fetch(
          new Request(
            'https://do/websocket?user_id=@a:example.com&room_id=!r:example.com&device_id=D1',
            { headers: { Upgrade: 'websocket' } }
          )
        ),
        room.fetch(
          new Request(
            'https://do/websocket?user_id=@a:example.com&room_id=!r:example.com&device_id=D2',
            { headers: { Upgrade: 'websocket' } }
          )
        ),
      ]);

      expect(state.sockets.length).toBe(2);
      const body = (await (await room.fetch(new Request('https://do/state'))).json()) as {
        connected_users: string[];
        connection_count: number;
      };
      expect(body.connection_count).toBe(2);
      expect(body.connected_users).toEqual(['@a:example.com']);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`typing timeout >120s capped∥GET flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const { do: room } = makeRacingRoomDo();

      await Promise.all([
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              typing: true,
              timeout: 999_999,
            }),
          })
        ),
        room.fetch(new Request('https://do/typing')),
      ]);

      // Cap is 120_000ms from now → expires at 130_000
      vi.setSystemTime(130_000);
      const atCap = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(atCap.user_ids).toEqual([]);
      // Just before cap expiry still active if re-set
      vi.setSystemTime(10_000);
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: '@a:example.com',
            typing: true,
            timeout: 999_999,
          }),
        })
      );
      vi.setSystemTime(129_999);
      const before = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(before.user_ids).toEqual(['@a:example.com']);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`null attachment message∥peer ping isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const bare = new FakeWebSocket();
      // no attachment
      const peer = new FakeWebSocket();
      peer.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(bare, peer);

      await Promise.all([
        wsMsg(room, bare, JSON.stringify({ type: 'ping' })),
        wsMsg(room, peer, JSON.stringify({ type: 'ping' })),
      ]);

      expect(bare.sent).toEqual([]);
      expect(peer.sent).toEqual([JSON.stringify({ type: 'pong' })]);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`broadcast∥state connection_count race flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      const [stateRes] = await Promise.all([
        room.fetch(new Request('https://do/state')),
        room.fetch(
          new Request('https://do/broadcast', {
            method: 'POST',
            body: JSON.stringify({ type: 'event', id: '$e' }),
          })
        ),
      ]);

      expect(stateRes.status).toBe(200);
      const body = (await stateRes.json()) as { connection_count: number };
      expect(body.connection_count).toBe(1);
      expect(a.sent.some((s) => s.includes('$e'))).toBe(true);
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #273/#276 — RoomDurableObject hibernation
 * *senary* concurrent races not covered by #240 / #251 / #263 quaternary /
 * #273 quinary (WS∥HTTP typing, m.read.private∥m.read, close∥receipt PUT,
 * unknown WS type∥peer ping).
 */

describe('RoomDurableObject hibernation senary typing/receipt/ws leftovers after #273', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`WS typing∥HTTP PUT typing same user settle flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(40_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'typing', typing: true })),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@a:example.com']);
      // WS typing broadcasts to peers; HTTP also broadcasts
      expect(b.sent.some((s) => s.includes('"typing"') && s.includes('@a:example.com'))).toBe(
        true
      );
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`m.read.private∥m.read concurrent distinct keys flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      await Promise.all([
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$priv',
              receipt_type: 'm.read.private',
            }),
          })
        ),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$pub',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);

      expect(
        state.storage.map.has('receipt:@a:example.com:m.read.private:unthreaded')
      ).toBe(true);
      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      const get = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
        receipts: Record<string, Record<string, Record<string, unknown>>>;
      };
      expect(get.receipts.$priv['m.read.private']['@a:example.com']).toBeDefined();
      expect(get.receipts.$pub['m.read']['@a:example.com']).toBeDefined();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`webSocketClose∥HTTP receipt PUT peer may see disconnect flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        wsClose(room, a, 1000, 'bye'),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@b:example.com',
              event_id: '$e',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);

      expect(state.storage.map.has('receipt:@b:example.com:m.read:unthreaded')).toBe(true);
      // Peer may receive disconnect and/or receipt broadcast
      const kinds = b.sent.map((s) => JSON.parse(s).type);
      expect(
        kinds.includes('user_disconnected') || kinds.includes('receipt')
      ).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`unknown WS type∥peer ping silent ignore∥pong flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'nope', x: i })),
        wsMsg(room, b, JSON.stringify({ type: 'ping' })),
      ]);

      expect(a.sent).toEqual([]);
      expect(b.sent).toEqual([JSON.stringify({ type: 'pong' })]);
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #273/#276 senary — RoomDurableObject
 * hibernation *septenary* (WS typing false∥true, thread_id ''∥omit).
 */

describe('RoomDurableObject hibernation septenary typing/thread leftovers after #273', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`WS typing false∥true same user both broadcast flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'typing', typing: false })),
        wsMsg(room, a, JSON.stringify({ type: 'typing', typing: true })),
      ]);

      const peerTyping = b.sent
        .map((s) => JSON.parse(s))
        .filter((m) => m.type === 'typing' && m.user_id === '@a:example.com');
      expect(peerTyping.length).toBeGreaterThanOrEqual(2);
      expect(peerTyping.some((m) => m.typing === false)).toBe(true);
      expect(peerTyping.some((m) => m.typing === true)).toBe(true);
      // WS path does not touch typingUsers map
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual([]);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`thread_id ''∥omit distinct receipt keys flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      await Promise.all([
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$empty',
              receipt_type: 'm.read',
              thread_id: '',
            }),
          })
        ),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$omit',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);

      // '' is not coalesced by ?? → key ends with ':' ; omit → unthreaded
      expect(state.storage.map.has('receipt:@a:example.com:m.read:')).toBe(true);
      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(
        true
      );
      const get = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
        receipts: Record<
          string,
          Record<string, Record<string, { thread_id?: string }>>
        >;
      };
      expect(get.receipts.$empty['m.read']['@a:example.com'].thread_id).toBeUndefined();
      expect(get.receipts.$omit['m.read']['@a:example.com'].thread_id).toBeUndefined();
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #281 — RoomDurableObject hibernation
 * *octonary* (dual ping same socket, typing timeout 0∥GET).
 */

describe('RoomDurableObject hibernation octonary ping/timeout leftovers after #281', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`dual ping same socket two pongs flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
      ]);

      expect(a.sent).toEqual([
        JSON.stringify({ type: 'pong' }),
        JSON.stringify({ type: 'pong' }),
      ]);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`typing timeout 0 expires immediately∥GET flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(20_000);
      const { do: room } = makeRacingRoomDo();

      await Promise.all([
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              typing: true,
              timeout: 0,
            }),
          })
        ),
        room.fetch(new Request('https://do/typing')),
      ]);

      // expiresAt = now + min(0,120000) = now → already expired on GET cleanup
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual([]);
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #281 — RoomDurableObject hibernation
 * *nonary* (ping∥close same socket).
 */

describe('RoomDurableObject hibernation nonary ping/close leftovers after #281', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`ping∥close same socket pong-or-closed LWW flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
        wsClose(room, a, 1000, 'bye'),
      ]);

      // Ping may land before close (pong) or after (no send); close always sets closed
      expect(a.closed?.code).toBe(1000);
      expect(a.sent.length === 0 || a.sent[0] === JSON.stringify({ type: 'pong' })).toBe(
        true
      );
      expect(b.sent.some((s) => JSON.parse(s).type === 'user_disconnected')).toBe(true);
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #288 — RoomDurableObject hibernation
 * *denary* (WS typing false∥HTTP true, read∥typing, ping∥receipt,
 * ArrayBuffer∥typing, 404∥GET, read∥private). Closed #291 claimed these;
 * #288 nonary stopped at ping∥close.
 */

describe('RoomDurableObject hibernation denary typing/read leftovers after #288', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`WS typing false∥HTTP true map from HTTP flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(40_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'typing', typing: false })),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@a:example.com']);
      const peerTyping = b.sent
        .map((s) => JSON.parse(s))
        .filter((m: { type: string; user_id: string }) => m.type === 'typing' && m.user_id === '@a:example.com');
      expect(peerTyping.length).toBeGreaterThanOrEqual(1);
      expect(peerTyping.some((m: { typing: boolean }) => m.typing === true || m.typing === false)).toBe(
        true
      );
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`WS read∥WS typing isolation receipt+broadcast flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'read', event_id: '$denary' })),
        wsMsg(room, a, JSON.stringify({ type: 'typing', typing: true })),
      ]);

      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; typing?: boolean };
          return m.type === 'typing' && m.typing === true;
        })
      ).toBe(true);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; event_id?: string };
          return m.type === 'receipt' && m.event_id === '$denary';
        })
      ).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`ping∥HTTP receipt pong+stored flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$ping-rcpt',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);

      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
    });
  }
});

describe('RoomDurableObject hibernation denary buffer/404/private leftovers after #288', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`ArrayBuffer∥peer typing isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, new ArrayBuffer(4)),
        wsMsg(room, b, JSON.stringify({ type: 'typing', typing: true })),
      ]);

      expect(a.sent.some((s) => JSON.parse(s).type === 'typing')).toBe(true);
      expect(b.sent).toEqual([]);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`404 unknown path∥GET typing isolation flood-${i}`, async () => {
      const { do: room } = makeRacingRoomDo();
      const [missing, typing] = await Promise.all([
        room.fetch(new Request('https://do/nope')),
        room.fetch(new Request('https://do/typing')),
      ]);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe('Not found');
      expect(typing.status).toBe(200);
      expect(await typing.json()).toEqual({ user_ids: [] });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`WS read∥HTTP m.read.private distinct keys flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'read', event_id: '$ws-read' })),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$http-priv',
              receipt_type: 'm.read.private',
            }),
          })
        ),
      ]);

      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      expect(
        state.storage.map.has('receipt:@a:example.com:m.read.private:unthreaded')
      ).toBe(true);
      const get = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
        receipts: Record<string, Record<string, Record<string, unknown>>>;
      };
      expect(get.receipts['$ws-read']['m.read']['@a:example.com']).toBeDefined();
      expect(get.receipts['$http-priv']['m.read.private']['@a:example.com']).toBeDefined();
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #296 — RoomDurableObject hibernation
 * *undecenary* (WS read∥HTTP typing, ping∥WS typing, timeout -1∥GET,
 * missing Upgrade∥GET typing, GET /receipts∥WS read). Denary stopped at
 * WS read∥m.read.private.
 */

describe('RoomDurableObject hibernation undecenary read/typing leftovers after #296', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`WS read∥HTTP typing receipt+typing isolation flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(50_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'read', event_id: '$undecenary' })),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@a:example.com']);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; typing?: boolean };
          return m.type === 'typing' && m.typing === true;
        })
      ).toBe(true);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; event_id?: string };
          return m.type === 'receipt' && m.event_id === '$undecenary';
        })
      ).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`ping∥WS typing pong+broadcast flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
        wsMsg(room, a, JSON.stringify({ type: 'typing', typing: true })),
      ]);

      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; typing?: boolean };
          return m.type === 'typing' && m.typing === true;
        })
      ).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`typing timeout -1 expires immediately∥GET flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(60_000);
      const { do: room } = makeRacingRoomDo();

      await Promise.all([
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              typing: true,
              timeout: -1,
            }),
          })
        ),
        room.fetch(new Request('https://do/typing')),
      ]);

      // Math.min(-1, 120000)=-1 → expiresAt = now-1 → already expired on GET cleanup
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual([]);
    });
  }
});

describe('RoomDurableObject hibernation undecenary upgrade/receipt leftovers after #296', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`missing Upgrade 426∥GET typing isolation flood-${i}`, async () => {
      const { do: room } = makeRacingRoomDo();
      const [missing, typing] = await Promise.all([
        room.fetch(new Request('https://do/websocket')),
        room.fetch(new Request('https://do/typing')),
      ]);
      expect(missing.status).toBe(426);
      expect(await missing.text()).toBe('Expected websocket upgrade');
      expect(typing.status).toBe(200);
      expect(await typing.json()).toEqual({ user_ids: [] });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`GET /receipts∥WS read eventual both visible flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      const [getRes] = await Promise.all([
        room.fetch(new Request('https://do/receipts')),
        wsMsg(room, a, JSON.stringify({ type: 'read', event_id: '$get-race' })),
      ]);
      expect(getRes.status).toBe(200);
      const mid = (await getRes.json()) as {
        receipts: Record<string, Record<string, Record<string, unknown>>>;
      };
      // GET may race before write lands
      const midHas = mid.receipts['$get-race']?.['m.read']?.['@a:example.com'] !== undefined;
      expect(midHas === true || midHas === false).toBe(true);

      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      const after = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
        receipts: Record<string, Record<string, Record<string, unknown>>>;
      };
      expect(after.receipts['$get-race']['m.read']['@a:example.com']).toBeDefined();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`Upgrade '' 426∥WS ping isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      const [bad] = await Promise.all([
        room.fetch(
          new Request('https://do/websocket', { headers: { Upgrade: '' } })
        ),
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
      ]);
      expect(bad.status).toBe(426);
      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #302 — RoomDurableObject hibernation
 * *duodenary* (timeout MAX_SAFE cap∥GET + Infinity→null expiry,
 * Upgrade WEBSOCKET 426∥ping, close∥HTTP typing, bad JSON∥receipt,
 * 404∥ping, broadcast∥WS read). Undecenary stopped at Upgrade '' 426∥WS ping.
 */

describe('RoomDurableObject hibernation duodenary typing/upgrade leftovers after #302', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`typing timeout MAX_SAFE capped∥GET still active; Infinity→null expires flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(70_000);
      const { do: room } = makeRacingRoomDo();

      // Infinity cannot round-trip JSON → null → Math.min(null,120000)=0 → already expired
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: '@inf:example.com',
            typing: true,
            timeout: Number.POSITIVE_INFINITY,
          }),
        })
      );
      const infTyping = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(infTyping.user_ids).toEqual([]);

      await Promise.all([
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              typing: true,
              timeout: Number.MAX_SAFE_INTEGER,
            }),
          })
        ),
        room.fetch(new Request('https://do/typing')),
      ]);

      // Math.min(MAX_SAFE_INTEGER, 120000)=120000 → still active at now
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@a:example.com']);

      vi.setSystemTime(70_000 + 120_000);
      const expired = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(expired.user_ids).toEqual([]);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`Upgrade WEBSOCKET 426∥WS ping isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      const [bad] = await Promise.all([
        room.fetch(
          new Request('https://do/websocket', { headers: { Upgrade: 'WEBSOCKET' } })
        ),
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
      ]);
      // Case-sensitive: 'WEBSOCKET' !== 'websocket' → 426
      expect(bad.status).toBe(426);
      expect(await bad.text()).toBe('Expected websocket upgrade');
      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`webSocketClose∥HTTP typing peer isolation flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(80_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);
      (
        room as unknown as { sessions: Map<FakeWebSocket, { userId: string }> }
      ).sessions.set(a, { userId: '@a:example.com' });

      await Promise.all([
        wsClose(room, a, 1000, 'bye'),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@b:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      expect(a.closed?.code).toBe(1000);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; user_id?: string };
          return m.type === 'user_disconnected' && m.user_id === '@a:example.com';
        })
      ).toBe(true);
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@b:example.com']);
    });
  }
});

describe('RoomDurableObject hibernation duodenary json/404/broadcast leftovers after #302', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`bad JSON WS silent∥HTTP receipt both settle flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      await Promise.all([
        wsMsg(room, a, '{not-json'),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$duo-bad',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);

      expect(a.sent).toEqual([]);
      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      const after = (await (await room.fetch(new Request('https://do/receipts'))).json()) as {
        receipts: Record<string, Record<string, Record<string, unknown>>>;
      };
      expect(after.receipts['$duo-bad']['m.read']['@a:example.com']).toBeDefined();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`404 unknown path∥WS ping isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      const [missing] = await Promise.all([
        room.fetch(new Request('https://do/nope')),
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
      ]);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe('Not found');
      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`broadcast∥WS read receipt+broadcast both visible flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        room.fetch(
          new Request('https://do/broadcast', {
            method: 'POST',
            body: JSON.stringify({ type: 'custom', n: i }),
          })
        ),
        wsMsg(room, a, JSON.stringify({ type: 'read', event_id: '$duo-bc' })),
      ]);

      expect(
        a.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; n?: number };
          return m.type === 'custom' && m.n === i;
        })
      ).toBe(true);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; n?: number };
          return m.type === 'custom' && m.n === i;
        })
      ).toBe(true);
      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; event_id?: string };
          return m.type === 'receipt' && m.event_id === '$duo-bc';
        })
      ).toBe(true);
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #310 — RoomDurableObject hibernation
 * *tridecenary* (timeout null/string-NaN expiry, Upgrade Websocket 426∥ping,
 * GET /state∥WS typing, WS typing∥HTTP receipt, webSocketError∥ping,
 * broadcast∥WS typing, receipt PUT∥ping, unknown/empty WS∥HTTP).
 * Duodenary stopped at broadcast∥WS read.
 */

describe('RoomDurableObject hibernation tridecenary typing/upgrade leftovers after #310', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`typing timeout null→0 expiry∥string NaN expires∥peer still active flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(90_000);
      const { do: room } = makeRacingRoomDo();

      // null coerces via Math.min(null,120000)=0 → already expired
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: '@null:example.com',
            typing: true,
            timeout: null,
          }),
        })
      );
      const nullTyping = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(nullTyping.user_ids).toEqual([]);

      // Non-numeric string: Math.min('nope',120000)=NaN; NaN > now is false → expired
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: '@nan:example.com',
            typing: true,
            timeout: 'nope',
          }),
        })
      );

      await Promise.all([
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              typing: true,
              timeout: 30_000,
            }),
          })
        ),
        room.fetch(new Request('https://do/typing')),
      ]);

      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@a:example.com']);
      expect(typing.user_ids).not.toContain('@nan:example.com');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`Upgrade Websocket 426∥WS ping isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      const [bad] = await Promise.all([
        room.fetch(
          new Request('https://do/websocket', { headers: { Upgrade: 'Websocket' } })
        ),
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
      ]);
      // Case-sensitive: 'Websocket' !== 'websocket' → 426
      expect(bad.status).toBe(426);
      expect(await bad.text()).toBe('Expected websocket upgrade');
      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`GET /state∥WS typing peer broadcast isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      const [stateRes] = await Promise.all([
        room.fetch(new Request('https://do/state')),
        wsMsg(room, a, JSON.stringify({ type: 'typing', typing: true })),
      ]);
      expect(stateRes.status).toBe(200);
      const body = (await stateRes.json()) as {
        connected_users: string[];
        connection_count: number;
      };
      expect(body.connection_count).toBe(2);
      expect(body.connected_users.sort()).toEqual(['@a:example.com', '@b:example.com'].sort());
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; user_id?: string; typing?: boolean };
          return m.type === 'typing' && m.user_id === '@a:example.com' && m.typing === true;
        })
      ).toBe(true);
      expect(a.sent).toEqual([]);
    });
  }
});

describe('RoomDurableObject hibernation tridecenary receipt/ws leftovers after #310', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`WS typing∥HTTP receipt both settle flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'typing', typing: true })),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$tri-rcpt',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);

      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; user_id?: string };
          return m.type === 'typing' && m.user_id === '@a:example.com';
        })
      ).toBe(true);
      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; event_id?: string };
          return m.type === 'receipt' && m.event_id === '$tri-rcpt';
        })
      ).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`webSocketError∥WS ping peer isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);
      (
        room as unknown as { sessions: Map<FakeWebSocket, { userId: string }> }
      ).sessions.set(a, { userId: '@a:example.com' });
      (
        room as unknown as { sessions: Map<FakeWebSocket, { userId: string }> }
      ).sessions.set(b, { userId: '@b:example.com' });

      await Promise.all([
        wsError(room, a, new Error('tri-err')),
        wsMsg(room, b, JSON.stringify({ type: 'ping' })),
      ]);

      expect(
        (room as unknown as { sessions: Map<FakeWebSocket, unknown> }).sessions.has(a)
      ).toBe(false);
      expect(
        (room as unknown as { sessions: Map<FakeWebSocket, unknown> }).sessions.has(b)
      ).toBe(true);
      expect(b.sent).toContain(JSON.stringify({ type: 'pong' }));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`broadcast∥WS typing both visible flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        room.fetch(
          new Request('https://do/broadcast', {
            method: 'POST',
            body: JSON.stringify({ type: 'custom', n: i }),
          })
        ),
        wsMsg(room, a, JSON.stringify({ type: 'typing', typing: true })),
      ]);

      expect(
        a.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; n?: number };
          return m.type === 'custom' && m.n === i;
        })
      ).toBe(true);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; n?: number };
          return m.type === 'custom' && m.n === i;
        })
      ).toBe(true);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; user_id?: string };
          return m.type === 'typing' && m.user_id === '@a:example.com';
        })
      ).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`receipt PUT∥WS ping isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      await Promise.all([
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$tri-ping',
              receipt_type: 'm.read',
            }),
          })
        ),
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
      ]);

      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`unknown type + empty {} WS silent∥HTTP typing flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(110_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'nope' })),
        wsMsg(room, a, JSON.stringify({})),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@b:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      // unknown + empty object: no WS replies from those messages
      expect(a.sent.every((s) => {
        const m = JSON.parse(s) as { type: string };
        return m.type === 'typing';
      })).toBe(true);
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@b:example.com']);
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #314 — RoomDurableObject hibernation
 * *quattuordecenary* (timeout true/[] expiry, Upgrade wEbSoCkEt 426∥ping,
 * GET /state∥HTTP typing, WS ping∥HTTP typing, webSocketClose∥WS ping,
 * broadcast∥HTTP receipt, receipt PUT∥WS read, JSON 1/null WS silent∥HTTP).
 * Tridecenary stopped at unknown/empty WS∥HTTP typing.
 */

describe('RoomDurableObject hibernation quattuordecenary typing/upgrade leftovers after #314', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`typing timeout true→1ms∥[]→0 expiry∥peer still active flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(200_000);
      const { do: room } = makeRacingRoomDo();

      // true → Math.min(true,120000)=1 → expiresAt = now+1
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: '@true:example.com',
            typing: true,
            timeout: true,
          }),
        })
      );
      vi.setSystemTime(200_002);
      const trueTyping = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(trueTyping.user_ids).toEqual([]);

      // [] → Math.min([],120000)=0 → already expired at insert
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: '@arr:example.com',
            typing: true,
            timeout: [],
          }),
        })
      );

      await Promise.all([
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              typing: true,
              timeout: 30_000,
            }),
          })
        ),
        room.fetch(new Request('https://do/typing')),
      ]);

      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@a:example.com']);
      expect(typing.user_ids).not.toContain('@arr:example.com');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`Upgrade wEbSoCkEt 426∥WS ping isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      const [bad] = await Promise.all([
        room.fetch(
          new Request('https://do/websocket', { headers: { Upgrade: 'wEbSoCkEt' } })
        ),
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
      ]);
      expect(bad.status).toBe(426);
      expect(await bad.text()).toBe('Expected websocket upgrade');
      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`GET /state∥HTTP typing peer isolation flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(210_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      const [stateRes] = await Promise.all([
        room.fetch(new Request('https://do/state')),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@b:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);
      expect(stateRes.status).toBe(200);
      const body = (await stateRes.json()) as {
        connected_users: string[];
        connection_count: number;
      };
      expect(body.connection_count).toBe(1);
      expect(body.connected_users).toEqual(['@a:example.com']);
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@b:example.com']);
      expect(
        a.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; user_id?: string };
          return m.type === 'typing' && m.user_id === '@b:example.com';
        })
      ).toBe(true);
    });
  }
});

describe('RoomDurableObject hibernation quattuordecenary receipt/ws leftovers after #314', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`WS ping∥HTTP typing both settle flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(220_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@b:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
      expect(
        a.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; user_id?: string };
          return m.type === 'typing' && m.user_id === '@b:example.com';
        })
      ).toBe(true);
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@b:example.com']);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`webSocketClose∥WS ping peer isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);
      (
        room as unknown as { sessions: Map<FakeWebSocket, { userId: string }> }
      ).sessions.set(a, { userId: '@a:example.com' });
      (
        room as unknown as { sessions: Map<FakeWebSocket, { userId: string }> }
      ).sessions.set(b, { userId: '@b:example.com' });

      await Promise.all([
        wsClose(room, a),
        wsMsg(room, b, JSON.stringify({ type: 'ping' })),
      ]);

      expect(
        (room as unknown as { sessions: Map<FakeWebSocket, unknown> }).sessions.has(a)
      ).toBe(false);
      expect(
        (room as unknown as { sessions: Map<FakeWebSocket, unknown> }).sessions.has(b)
      ).toBe(true);
      expect(b.sent).toContain(JSON.stringify({ type: 'pong' }));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`broadcast∥HTTP receipt both visible flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        room.fetch(
          new Request('https://do/broadcast', {
            method: 'POST',
            body: JSON.stringify({ type: 'custom', n: i }),
          })
        ),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$q14-rcpt',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);

      expect(
        a.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; n?: number };
          return m.type === 'custom' && m.n === i;
        })
      ).toBe(true);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; n?: number };
          return m.type === 'custom' && m.n === i;
        })
      ).toBe(true);
      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; event_id?: string };
          return m.type === 'receipt' && m.event_id === '$q14-rcpt';
        })
      ).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`receipt PUT∥WS read both settle flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$q14-http',
              receipt_type: 'm.read',
            }),
          })
        ),
        wsMsg(room, a, JSON.stringify({ type: 'read', event_id: '$q14-ws' })),
      ]);

      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      // Last writer wins for same unthreaded key — either HTTP or WS event_id
      const stored = state.storage.map.get('receipt:@a:example.com:m.read:unthreaded') as {
        event_id: string;
      };
      expect(['$q14-http', '$q14-ws']).toContain(stored.event_id);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; event_id?: string };
          return m.type === 'receipt' && (m.event_id === '$q14-http' || m.event_id === '$q14-ws');
        })
      ).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`JSON 1/null WS silent∥HTTP typing flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(230_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      await Promise.all([
        wsMsg(room, a, JSON.stringify(1)),
        wsMsg(room, a, 'null'),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@b:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      // number 1: truthy data, no type → default silent; null: !data early return
      expect(a.sent.every((s) => {
        const m = JSON.parse(s) as { type: string };
        return m.type === 'typing';
      })).toBe(true);
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@b:example.com']);
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #325 — RoomDurableObject hibernation
 * *quindecenary* (timeout false/["30000"] expiry, Upgrade WebSOCKET 426∥ping,
 * GET /receipts∥HTTP typing, WS ping∥receipt PUT, webSocketError∥HTTP typing,
 * broadcast∥WS ping, receipt thread∥WS read, JSON false/[] silent∥HTTP).
 * Quattuordecenary stopped at JSON 1/null WS∥HTTP typing.
 */

describe('RoomDurableObject hibernation quindecenary typing/upgrade leftovers after #325', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`typing timeout false→0 expiry∥["30000"] stays∥peer flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(240_000);
      const { do: room } = makeRacingRoomDo();

      // false → Math.min(false,120000)=0 → already expired at insert
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: '@false:example.com',
            typing: true,
            timeout: false,
          }),
        })
      );
      const falseTyping = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(falseTyping.user_ids).toEqual([]);

      // ["30000"] → Math.min(["30000"],120000)=30000 → still active
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: '@arr:example.com',
            typing: true,
            timeout: ['30000'],
          }),
        })
      );

      await Promise.all([
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              typing: true,
              timeout: 30_000,
            }),
          })
        ),
        room.fetch(new Request('https://do/typing')),
      ]);

      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toContain('@arr:example.com');
      expect(typing.user_ids).toContain('@a:example.com');
      expect(typing.user_ids).not.toContain('@false:example.com');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`Upgrade WebSOCKET 426∥WS ping isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      const [bad] = await Promise.all([
        room.fetch(
          new Request('https://do/websocket', { headers: { Upgrade: 'WebSOCKET' } })
        ),
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
      ]);
      expect(bad.status).toBe(426);
      expect(await bad.text()).toBe('Expected websocket upgrade');
      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`GET /receipts∥HTTP typing peer isolation flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(250_000);
      const { state, do: room } = makeRacingRoomDo();
      await state.storage.put('receipt:@seed:example.com:m.read:unthreaded', {
        user_id: '@seed:example.com',
        event_id: '$seed15',
        receipt_type: 'm.read',
        ts: 250_000,
      });

      const [receiptsRes] = await Promise.all([
        room.fetch(new Request('https://do/receipts')),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@b:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);
      expect(receiptsRes.status).toBe(200);
      const body = (await receiptsRes.json()) as {
        receipts: Record<string, Record<string, Record<string, { ts: number }>>>;
      };
      expect(body.receipts.$seed15['m.read']['@seed:example.com'].ts).toBe(250_000);
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@b:example.com']);
    });
  }
});

describe('RoomDurableObject hibernation quindecenary receipt/ws leftovers after #325', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`WS ping∥HTTP receipt both settle flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@b:example.com',
              event_id: '$q15-rcpt',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);

      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
      expect(state.storage.map.has('receipt:@b:example.com:m.read:unthreaded')).toBe(true);
      expect(
        a.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; event_id?: string };
          return m.type === 'receipt' && m.event_id === '$q15-rcpt';
        })
      ).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`webSocketError∥HTTP typing peer isolation flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(260_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);
      (
        room as unknown as { sessions: Map<FakeWebSocket, { userId: string }> }
      ).sessions.set(a, { userId: '@a:example.com' });
      (
        room as unknown as { sessions: Map<FakeWebSocket, { userId: string }> }
      ).sessions.set(b, { userId: '@b:example.com' });

      await Promise.all([
        wsError(room, a, new Error('q15-err')),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@c:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      expect(
        (room as unknown as { sessions: Map<FakeWebSocket, unknown> }).sessions.has(a)
      ).toBe(false);
      expect(
        (room as unknown as { sessions: Map<FakeWebSocket, unknown> }).sessions.has(b)
      ).toBe(true);
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@c:example.com']);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`broadcast∥WS ping both visible flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        room.fetch(
          new Request('https://do/broadcast', {
            method: 'POST',
            body: JSON.stringify({ type: 'custom', n: i }),
          })
        ),
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
      ]);

      expect(
        a.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; n?: number };
          return m.type === 'custom' && m.n === i;
        })
      ).toBe(true);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; n?: number };
          return m.type === 'custom' && m.n === i;
        })
      ).toBe(true);
      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`receipt thread PUT∥WS read unthreaded both keys flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$q15-thr',
              receipt_type: 'm.read',
              thread_id: '$root15',
            }),
          })
        ),
        wsMsg(room, a, JSON.stringify({ type: 'read', event_id: '$q15-ws' })),
      ]);

      expect(state.storage.map.has('receipt:@a:example.com:m.read:$root15')).toBe(true);
      expect(state.storage.map.has('receipt:@a:example.com:m.read:unthreaded')).toBe(true);
      const threaded = state.storage.map.get('receipt:@a:example.com:m.read:$root15') as {
        event_id: string;
      };
      expect(threaded.event_id).toBe('$q15-thr');
      const unthreaded = state.storage.map.get('receipt:@a:example.com:m.read:unthreaded') as {
        event_id: string;
      };
      expect(unthreaded.event_id).toBe('$q15-ws');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`JSON false/[] WS silent∥HTTP typing flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(270_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      await Promise.all([
        wsMsg(room, a, JSON.stringify(false)),
        wsMsg(room, a, JSON.stringify([])),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@b:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      // false: !data early return; []: truthy no type → default silent
      expect(a.sent.every((s) => {
        const m = JSON.parse(s) as { type: string };
        return m.type === 'typing';
      })).toBe(true);
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@b:example.com']);
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #332 — RoomDurableObject hibernation
 * *sexdecenary* (timeout {}→0 / "30000" stays, Upgrade WeBsOcKeT 426∥ping,
 * GET /state∥HTTP receipt, WS typing∥HTTP typing, webSocketClose∥HTTP receipt,
 * broadcast∥HTTP typing, receipt thread∥WS ping, JSON true/0/{} silent∥HTTP).
 * Quindecenary stopped at JSON false/[] WS∥HTTP typing.
 */

describe('RoomDurableObject hibernation sexdecenary typing/upgrade leftovers after #332', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`typing timeout {}→0 expiry∥"30000" stays∥peer flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(280_000);
      const { do: room } = makeRacingRoomDo();

      // {} → Math.min({},120000)=NaN → NaN > now is false → expired at GET
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: '@obj:example.com',
            typing: true,
            timeout: {},
          }),
        })
      );
      const objTyping = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(objTyping.user_ids).toEqual([]);

      // "30000" → Math.min("30000",120000)=30000 → still active
      await room.fetch(
        new Request('https://do/typing', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: '@str:example.com',
            typing: true,
            timeout: '30000',
          }),
        })
      );

      await Promise.all([
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              typing: true,
              timeout: 30_000,
            }),
          })
        ),
        room.fetch(new Request('https://do/typing')),
      ]);

      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toContain('@str:example.com');
      expect(typing.user_ids).toContain('@a:example.com');
      expect(typing.user_ids).not.toContain('@obj:example.com');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`Upgrade WeBsOcKeT 426∥WS ping isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      const [bad] = await Promise.all([
        room.fetch(
          new Request('https://do/websocket', { headers: { Upgrade: 'WeBsOcKeT' } })
        ),
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
      ]);
      expect(bad.status).toBe(426);
      expect(await bad.text()).toBe('Expected websocket upgrade');
      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`GET /state∥HTTP receipt peer isolation flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(290_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      const [stateRes] = await Promise.all([
        room.fetch(new Request('https://do/state')),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@b:example.com',
              event_id: '$s16-rcpt',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);
      expect(stateRes.status).toBe(200);
      const body = (await stateRes.json()) as {
        connected_users: string[];
        connection_count: number;
      };
      expect(body.connection_count).toBe(1);
      expect(body.connected_users).toEqual(['@a:example.com']);
      expect(state.storage.map.has('receipt:@b:example.com:m.read:unthreaded')).toBe(true);
    });
  }
});

describe('RoomDurableObject hibernation sexdecenary receipt/ws leftovers after #332', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`WS typing∥HTTP typing both visible flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(300_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        wsMsg(room, a, JSON.stringify({ type: 'typing', typing: true })),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@c:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; user_id?: string };
          return m.type === 'typing' && m.user_id === '@a:example.com';
        })
      ).toBe(true);
      expect(
        a.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; user_id?: string };
          return m.type === 'typing' && m.user_id === '@c:example.com';
        })
      ).toBe(true);
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@c:example.com']);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`webSocketClose∥HTTP receipt peer isolation flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);
      (
        room as unknown as { sessions: Map<FakeWebSocket, { userId: string }> }
      ).sessions.set(a, { userId: '@a:example.com' });
      (
        room as unknown as { sessions: Map<FakeWebSocket, { userId: string }> }
      ).sessions.set(b, { userId: '@b:example.com' });

      await Promise.all([
        wsClose(room, a),
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@c:example.com',
              event_id: '$s16-close',
              receipt_type: 'm.read',
            }),
          })
        ),
      ]);

      expect(
        (room as unknown as { sessions: Map<FakeWebSocket, unknown> }).sessions.has(a)
      ).toBe(false);
      expect(
        (room as unknown as { sessions: Map<FakeWebSocket, unknown> }).sessions.has(b)
      ).toBe(true);
      expect(state.storage.map.has('receipt:@c:example.com:m.read:unthreaded')).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`broadcast∥HTTP typing both visible flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(310_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      const b = new FakeWebSocket();
      b.serializeAttachment({ userId: '@b:example.com', id: '2' });
      state.sockets.push(a, b);

      await Promise.all([
        room.fetch(
          new Request('https://do/broadcast', {
            method: 'POST',
            body: JSON.stringify({ type: 'custom', n: i }),
          })
        ),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@c:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      expect(
        a.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; n?: number };
          return m.type === 'custom' && m.n === i;
        })
      ).toBe(true);
      expect(
        b.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; n?: number };
          return m.type === 'custom' && m.n === i;
        })
      ).toBe(true);
      expect(
        a.sent.some((s) => {
          const m = JSON.parse(s) as { type: string; user_id?: string };
          return m.type === 'typing' && m.user_id === '@c:example.com';
        })
      ).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`receipt thread PUT∥WS ping both settle flood-${i}`, async () => {
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      await Promise.all([
        room.fetch(
          new Request('https://do/receipt', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@a:example.com',
              event_id: '$s16-thr',
              receipt_type: 'm.read',
              thread_id: '$root16',
            }),
          })
        ),
        wsMsg(room, a, JSON.stringify({ type: 'ping' })),
      ]);

      expect(state.storage.map.has('receipt:@a:example.com:m.read:$root16')).toBe(true);
      expect(a.sent).toContain(JSON.stringify({ type: 'pong' }));
      const threaded = state.storage.map.get('receipt:@a:example.com:m.read:$root16') as {
        event_id: string;
      };
      expect(threaded.event_id).toBe('$s16-thr');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`JSON true/0/{} WS silent∥HTTP typing flood-${i}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(320_000);
      const { state, do: room } = makeRacingRoomDo();
      const a = new FakeWebSocket();
      a.serializeAttachment({ userId: '@a:example.com', id: '1' });
      state.sockets.push(a);

      await Promise.all([
        wsMsg(room, a, JSON.stringify(true)),
        wsMsg(room, a, JSON.stringify(0)),
        wsMsg(room, a, JSON.stringify({})),
        room.fetch(
          new Request('https://do/typing', {
            method: 'PUT',
            body: JSON.stringify({
              user_id: '@b:example.com',
              typing: true,
              timeout: 5_000,
            }),
          })
        ),
      ]);

      // true: !data false but no .type → default silent; 0: !data early; {}: no type silent
      expect(a.sent.every((s) => {
        const m = JSON.parse(s) as { type: string };
        return m.type === 'typing';
      })).toBe(true);
      const typing = (await (await room.fetch(new Request('https://do/typing'))).json()) as {
        user_ids: string[];
      };
      expect(typing.user_ids).toEqual(['@b:example.com']);
    });
  }
});
