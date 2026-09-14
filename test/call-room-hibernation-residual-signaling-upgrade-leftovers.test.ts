/**
 * TOKENMAXX HEAVY residual leftovers after #261 — CallRoom DO hibernation
 * sequential signaling/upgrade edges not covered by:
 *   - test/call-room-hibernation-residual-concurrent-leftovers.test.ts (#261):
 *     ping/pong, Upgrade ''/WEBSOCKET→426, join | / undefined|undefined,
 *     JSON null/[]/42, leave zero-tracks, rejoin, offer∥mute/end, …
 *   - test/call-room-hibernation.test.ts (#232/#240/#251): mute bool, track
 *     errorDescription:'boom', leave single-track, end close-throw
 *
 * This slice (unsaturated):
 *   - successful /ws upgrade under WebSocketPair stub (acceptWebSocket)
 *   - offer SFU errorCode with omitted/"" errorDescription → 'Track error'
 *   - welcome includes peer tracks after rehydration
 *   - constructor hydrates callId/matrixRoomId from storage into new instance
 *   - loadParticipants early-return (participantsLoaded) — sequential short-circuit
 *   - leave with multiple tracks → closeTracks([...mids], true)
 *   - handleLeave swallows ws.close throw
 *   - mute truthiness: muted:0 / omitted / "yes"
 *   - JSON root true/false/{} → UNKNOWN_MESSAGE (contrast null → INTERNAL_ERROR)
 *
 * Tests-only. Fixtures use example.com-shaped ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallRoomDurableObject } from '../src/durable-objects/call-room';
import type { Env } from '../src/types';

const { addTracksMock, closeTracksMock, createSessionMock, renegotiateMock } = vi.hoisted(() => ({
  addTracksMock: vi.fn(),
  closeTracksMock: vi.fn(),
  createSessionMock: vi.fn(),
  renegotiateMock: vi.fn(),
}));

vi.mock('../src/services/cloudflare-calls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/cloudflare-calls')>();
  return {
    ...actual,
    addTracks: addTracksMock,
    closeTracks: closeTracksMock,
    createSession: createSessionMock,
    renegotiate: renegotiateMock,
  };
});

class FakeWebSocketRequestResponsePair {
  constructor(
    public readonly request: string,
    public readonly response: string
  ) {}
}
(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  FakeWebSocketRequestResponsePair;

class FakeStorage {
  map = new Map<string, unknown>();
  listCalls = 0;

  async get(key: string): Promise<unknown> {
    return this.map.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.map.clear();
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    this.listCalls += 1;
    const out = new Map<string, T>();
    for (const [k, v] of [...this.map.entries()].sort()) {
      if (k.startsWith(options.prefix)) out.set(k, v as T);
    }
    return out;
  }
}

class FakeWebSocket {
  attachment: unknown = null;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  closeThrows = false;

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    if (this.closeThrows) throw new Error('already closed');
    this.closed = { code, reason };
  }
}

class FakeState {
  storage = new FakeStorage();
  sockets: FakeWebSocket[] = [];
  autoResponses: FakeWebSocketRequestResponsePair[] = [];

  getWebSockets(): FakeWebSocket[] {
    return this.sockets;
  }

  acceptWebSocket(ws: FakeWebSocket): void {
    this.sockets.push(ws);
  }

  setWebSocketAutoResponse(pair: FakeWebSocketRequestResponsePair): void {
    this.autoResponses.push(pair);
  }

  blockConcurrencyWhile(cb: () => Promise<void>): Promise<void> {
    return cb();
  }
}

function makeRoom(state: FakeState): CallRoomDurableObject {
  return new CallRoomDurableObject(state as unknown as DurableObjectState, {} as Env);
}

function storedParticipant(
  userId: string,
  deviceId: string,
  tracks: Record<string, object> = {}
) {
  return {
    oderId: userId,
    deviceId,
    sessionId: `session-${userId}`,
    tracks,
    joinedAt: 1752900000000,
  };
}

const TRACK = { mid: '0', kind: 'audio', enabled: true };

describe('CallRoom hibernation residual signaling/upgrade leftovers after #261', () => {
  beforeEach(() => {
    addTracksMock.mockReset();
    closeTracksMock.mockReset();
    createSessionMock.mockReset();
    renegotiateMock.mockReset();
    createSessionMock.mockResolvedValue({ sessionId: 'sess-new' });
    renegotiateMock.mockResolvedValue(undefined);
    addTracksMock.mockResolvedValue({
      sessionDescription: { type: 'answer', sdp: 'v=answer' },
      tracks: [{ mid: '7' }],
    });
    closeTracksMock.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('successful /ws upgrade under WebSocketPair stub accepts server socket', async () => {
    const state = new FakeState();
    const room = makeRoom(state) as any;
    const client = new FakeWebSocket();
    const server = new FakeWebSocket();
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = client;
        1 = server;
      }
    );

    // Workers Response with webSocket throws in Node; accept still runs first.
    await expect(
      room.fetch(new Request('https://do/ws', { headers: { Upgrade: 'websocket' } }))
    ).rejects.toThrow(/status/);

    expect(state.sockets).toHaveLength(1);
    expect(state.sockets[0]).toBe(server);
  });

  it('offer SFU errorCode with omitted errorDescription → message Track error', async () => {
    addTracksMock.mockResolvedValueOnce({
      sessionDescription: { type: 'answer', sdp: 'v=ans' },
      tracks: [{ mid: '9', errorCode: 'TRACK_FAILED' }],
    });
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'offer', sdp: 'v=0', trackName: 'a0', kind: 'audio' })
    );

    expect(JSON.parse(ws.sent[0])).toEqual({
      type: 'error',
      code: 'TRACK_FAILED',
      message: 'Track error',
    });
  });

  it('offer SFU errorCode with empty errorDescription → message Track error', async () => {
    addTracksMock.mockResolvedValueOnce({
      sessionDescription: { type: 'answer', sdp: 'v=ans' },
      tracks: [{ mid: '9', errorCode: 'TRACK_FAILED', errorDescription: '' }],
    });
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'offer', sdp: 'v=0', trackName: 'a0', kind: 'audio' })
    );

    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'error',
      code: 'TRACK_FAILED',
      message: 'Track error',
    });
  });

  it('welcome includes peer tracks after rehydration', async () => {
    const state = new FakeState();
    await state.storage.put(
      'participant:peer|d1',
      storedParticipant('peer', 'd1', {
        audio0: { mid: '1', kind: 'audio', enabled: true },
        video0: { mid: '2', kind: 'video', enabled: false },
      })
    );
    const ws = new FakeWebSocket();
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })
    );

    const welcome = JSON.parse(ws.sent[0]);
    expect(welcome.type).toBe('welcome');
    expect(welcome.participants).toHaveLength(1);
    expect(welcome.participants[0]).toMatchObject({
      oderId: 'peer',
      deviceId: 'd1',
    });
    expect(welcome.participants[0].tracks).toEqual(
      expect.arrayContaining([
        { trackName: 'audio0', kind: 'audio' },
        { trackName: 'video0', kind: 'video' },
      ])
    );
  });

  it('constructor hydrates callId/matrixRoomId from storage into new instance', async () => {
    const state = new FakeState();
    await state.storage.put('callId', 'call-from-storage');
    await state.storage.put('matrixRoomId', '!room:example.com');

    const room = makeRoom(state) as any;
    const res = await room.fetch(new Request('https://do/state', { method: 'GET' }));
    const body = await res.json();

    expect(body).toMatchObject({
      callId: 'call-from-storage',
      roomId: '!room:example.com',
      participants: [],
    });
  });

  it('loadParticipants early-returns after first load (no second list)', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    const room = makeRoom(state) as any;

    await room.loadParticipants();
    expect(state.storage.listCalls).toBe(1);

    await room.loadParticipants();
    expect(state.storage.listCalls).toBe(1);
  });

  it('leave with multiple tracks closes all mids', async () => {
    const state = new FakeState();
    await state.storage.put(
      'participant:u1|d1',
      storedParticipant('u1', 'd1', {
        audio0: { mid: 'mid-a', kind: 'audio', enabled: true },
        video0: { mid: 'mid-v', kind: 'video', enabled: true },
      })
    );
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.handleLeave(ws);

    expect(closeTracksMock).toHaveBeenCalledOnce();
    expect(closeTracksMock).toHaveBeenCalledWith(
      expect.anything(),
      'session-u1',
      expect.arrayContaining(['mid-a', 'mid-v']),
      true
    );
    expect(closeTracksMock.mock.calls[0][2]).toHaveLength(2);
    expect(state.storage.map.has('participant:u1|d1')).toBe(false);
    expect(ws.closed).toEqual({ code: 1000, reason: 'Left call' });
  });

  it('handleLeave swallows ws.close throw', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1', { a: TRACK }));
    const ws = new FakeWebSocket();
    ws.closeThrows = true;
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await expect(room.handleLeave(ws)).resolves.toBeUndefined();
    expect(state.storage.map.has('participant:u1|d1')).toBe(false);
    expect(ws.closed).toBeNull();
  });

  it('mute truthiness: muted:0 keeps enabled true; omitted keeps true; "yes" disables', async () => {
    const state = new FakeState();
    await state.storage.put(
      'participant:u1|d1',
      storedParticipant('u1', 'd1', { audio0: { ...TRACK } })
    );
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    // muted:0 is falsy → enabled = !0 = true
    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'mute', trackName: 'audio0', muted: 0 })
    );
    let stored = state.storage.map.get('participant:u1|d1') as {
      tracks: { audio0: { enabled: boolean } };
    };
    expect(stored.tracks.audio0.enabled).toBe(true);

    // muted omitted → undefined falsy → enabled stays true
    await room.webSocketMessage(ws, JSON.stringify({ type: 'mute', trackName: 'audio0' }));
    stored = state.storage.map.get('participant:u1|d1') as {
      tracks: { audio0: { enabled: boolean } };
    };
    expect(stored.tracks.audio0.enabled).toBe(true);

    // muted:"yes" truthy → enabled = false
    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'mute', trackName: 'audio0', muted: 'yes' })
    );
    stored = state.storage.map.get('participant:u1|d1') as {
      tracks: { audio0: { enabled: boolean } };
    };
    expect(stored.tracks.audio0.enabled).toBe(false);
  });

  it('JSON root true/false/{} → UNKNOWN_MESSAGE (boolean/object .type is undefined)', async () => {
    // null throws on .type → INTERNAL_ERROR (#261); boolean/{} do not throw
    for (const raw of ['true', 'false', '{}']) {
      const state = new FakeState();
      const ws = new FakeWebSocket();
      state.sockets = [ws];
      const room = makeRoom(state) as any;
      await room.webSocketMessage(ws, raw);
      expect(JSON.parse(ws.sent[0])).toMatchObject({
        type: 'error',
        code: 'UNKNOWN_MESSAGE',
        message: 'Unknown message type: undefined',
      });
    }
  });
});
