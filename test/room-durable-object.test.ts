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
