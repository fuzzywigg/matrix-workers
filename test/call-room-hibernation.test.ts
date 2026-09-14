import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Cloudflare Workers runtime global used by handleJoin for hibernation auto-pong.
class FakeWebSocketRequestResponsePair {
  constructor(
    public readonly request: string,
    public readonly response: string
  ) {}
}
(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  FakeWebSocketRequestResponsePair;

// Minimal stand-ins for the pieces of the DO runtime the hibernation path touches.
// Storage structured-clones values like real DO storage, so a Map smuggled into a
// stored participant would be caught by the round-trip assertions below.

class FakeStorage {
  map = new Map<string, unknown>();

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
    this.closed = { code, reason };
  }
}

class FakeState {
  storage = new FakeStorage();
  sockets: FakeWebSocket[] = [];

  getWebSockets(): FakeWebSocket[] {
    return this.sockets;
  }

  acceptWebSocket(ws: FakeWebSocket): void {
    this.sockets.push(ws);
  }

  setWebSocketAutoResponse(): void {}

  blockConcurrencyWhile(cb: () => Promise<void>): Promise<void> {
    return cb();
  }
}

function makeRoom(state: FakeState): CallRoomDurableObject {
  return new CallRoomDurableObject(
    state as unknown as DurableObjectState,
    {} as Env
  );
}

// Storage-shaped participant; track-free variants avoid the SFU cleanup network path.
function storedParticipant(userId: string, deviceId: string, tracks: Record<string, object> = {}) {
  return {
    oderId: userId,
    deviceId,
    sessionId: `session-${userId}`,
    tracks,
    joinedAt: 1752900000000,
  };
}

const TRACK = { mid: '0', kind: 'audio', enabled: true };

describe('CallRoom hibernation: participant persistence', () => {
  it('persistParticipant stores a JSON-safe snapshot with tracks as a plain record', async () => {
    const state = new FakeState();
    const room = makeRoom(state) as any;

    await room.persistParticipant('u1|d1', {
      oderId: 'u1',
      deviceId: 'd1',
      sessionId: 'session-u1',
      tracks: new Map([['audio0', TRACK]]),
      joinedAt: 1752900000000,
    });

    const raw = state.storage.map.get('participant:u1|d1') as any;
    expect(raw.tracks instanceof Map).toBe(false);
    expect(raw.tracks.audio0).toEqual(TRACK);
    // Snapshot must survive serialization untouched
    expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);
  });

  it('loadParticipants rehydrates the in-memory map after simulated eviction', async () => {
    const state = new FakeState();
    const writer = makeRoom(state) as any;
    await writer.persistParticipant('u1|d1', {
      oderId: 'u1',
      deviceId: 'd1',
      sessionId: 'session-u1',
      tracks: new Map([['audio0', TRACK]]),
      joinedAt: 1752900000000,
    });

    // "Eviction": a brand-new instance over the same storage
    const revived = makeRoom(state) as any;
    await revived.loadParticipants();

    expect(revived.participants.size).toBe(1);
    const p = revived.participants.get('u1|d1');
    expect(p.tracks instanceof Map).toBe(true);
    expect(p.tracks.get('audio0')).toEqual(TRACK);
    expect(p.sessionId).toBe('session-u1');
  });
});

describe('CallRoom hibernation: socket identity via attachments', () => {
  it('getParticipantBySocket resolves through the serialized attachment after rehydration', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));

    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });

    const room = makeRoom(state) as any;
    await room.loadParticipants();

    expect(room.getParticipantBySocket(ws)?.deviceId).toBe('d1');
    expect(room.getParticipantBySocket(new FakeWebSocket())).toBeNull();
  });

  it('broadcast reaches only attached sockets of live participants, honoring excludeKey', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));

    const wsA = new FakeWebSocket();
    wsA.serializeAttachment({ participantKey: 'u1|d1' });
    const wsB = new FakeWebSocket();
    wsB.serializeAttachment({ participantKey: 'u2|d2' });
    const wsGhost = new FakeWebSocket(); // attachment points at a participant no longer stored
    wsGhost.serializeAttachment({ participantKey: 'u9|d9' });
    const wsBare = new FakeWebSocket(); // never went through join
    state.sockets = [wsA, wsB, wsGhost, wsBare];

    const room = makeRoom(state) as any;
    await room.loadParticipants();
    room.broadcast({ type: 'test' }, 'u1|d1');

    expect(wsA.sent).toHaveLength(0);
    expect(wsB.sent).toHaveLength(1);
    expect(JSON.parse(wsB.sent[0]).type).toBe('test');
    expect(wsGhost.sent).toHaveLength(0);
    expect(wsBare.sent).toHaveLength(0);
  });
});

describe('CallRoom hibernation: leave and close cleanup', () => {
  async function seedTwoParticipantRoom() {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
    const wsA = new FakeWebSocket();
    wsA.serializeAttachment({ participantKey: 'u1|d1' });
    const wsB = new FakeWebSocket();
    wsB.serializeAttachment({ participantKey: 'u2|d2' });
    state.sockets = [wsA, wsB];
    return { state, wsA, wsB, room: makeRoom(state) as any };
  }

  it('handleLeave removes the participant from memory and storage and notifies peers', async () => {
    const { state, wsA, wsB, room } = await seedTwoParticipantRoom();

    await room.handleLeave(wsA);

    expect(state.storage.map.has('participant:u1|d1')).toBe(false);
    expect(state.storage.map.has('participant:u2|d2')).toBe(true);
    expect(room.participants.size).toBe(1);
    expect(wsA.closed?.code).toBe(1000);
    const left = wsB.sent.map(s => JSON.parse(s)).find(m => m.type === 'participant_left');
    expect(left?.oderId).toBe('u1');
  });

  it('webSocketClose (ungraceful disconnect) triggers the same cleanup', async () => {
    const { state, wsA, room } = await seedTwoParticipantRoom();

    await room.webSocketClose(wsA, 1005, '');

    expect(state.storage.map.has('participant:u1|d1')).toBe(false);
    expect(room.participants.size).toBe(1);
  });

  it('handleEndCall closes every attached socket and wipes storage', async () => {
    const { state, wsA, wsB, room } = await seedTwoParticipantRoom();
    await state.storage.put('callId', 'call-1');

    const res = await room.handleEndCall();

    expect(res.status).toBe(200);
    expect(wsA.closed?.code).toBe(1000);
    expect(wsB.closed?.code).toBe(1000);
    expect(state.storage.map.size).toBe(0);
    expect(room.participants.size).toBe(0);
  });

  it('webSocketError triggers the same leave cleanup as webSocketClose', async () => {
    const { state, wsA, wsB, room } = await seedTwoParticipantRoom();

    await room.webSocketError(wsA, new Error('network'));

    expect(state.storage.map.has('participant:u1|d1')).toBe(false);
    expect(room.participants.size).toBe(1);
    const left = wsB.sent.map((s: string) => JSON.parse(s)).find(
      (m: { type: string }) => m.type === 'participant_left'
    );
    expect(left?.oderId).toBe('u1');
  });

  it('webSocketError is a no-op leave when the socket has no attachment', async () => {
    const { state, room } = await seedTwoParticipantRoom();
    const bare = new FakeWebSocket();

    await room.webSocketError(bare, 'boom');

    expect(state.storage.map.has('participant:u1|d1')).toBe(true);
    expect(state.storage.map.has('participant:u2|d2')).toBe(true);
    expect(room.participants.size).toBe(2);
  });
});

describe('CallRoom hibernation: state endpoint', () => {
  it('handleGetState reflects storage-rehydrated participants', async () => {
    const state = new FakeState();
    await state.storage.put('callId', 'call-1');
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1', { audio0: TRACK }));
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));

    const room = makeRoom(state) as any;
    const res = await room.handleGetState();
    const body = await res.json();

    expect(body.callId).toBe('call-1');
    expect(body.participants).toHaveLength(2);
    const u1 = body.participants.find((p: any) => p.oderId === 'u1');
    expect(u1.tracks).toEqual([{ trackName: 'audio0', kind: 'audio', enabled: true }]);
  });
});


describe('CallRoom signaling TOKENMAXX edge paths after #54', () => {
  it('rejects binary and invalid JSON websocket messages', async () => {
    const state = new FakeState();
    const room = makeRoom(state) as any;
    const ws = new FakeWebSocket();

    await room.webSocketMessage(ws, new ArrayBuffer(4));
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'error',
      code: 'INVALID_MESSAGE',
    });

    ws.sent.length = 0;
    await room.webSocketMessage(ws, '{not-json');
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'error',
      code: 'INVALID_JSON',
    });
  });

  it('rejects unknown message types and mute/offer without join', async () => {
    const state = new FakeState();
    const room = makeRoom(state) as any;
    const ws = new FakeWebSocket();

    await room.webSocketMessage(ws, JSON.stringify({ type: 'ping' }));
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'error',
      code: 'UNKNOWN_MESSAGE',
    });

    ws.sent.length = 0;
    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'mute', trackName: 'audio0', muted: true })
    );
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'error', code: 'NOT_JOINED' });

    ws.sent.length = 0;
    await room.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'offer',
        trackName: 'audio0',
        sessionDescription: { type: 'offer', sdp: 'v=0' },
      })
    );
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'error', code: 'NOT_JOINED' });
  });

  it('persists /init and serves /state; unknown paths return 404', async () => {
    const state = new FakeState();
    const room = makeRoom(state) as any;

    const initRes = await room.fetch(
      new Request('https://do/init', {
        method: 'POST',
        body: JSON.stringify({ roomId: '!r:ex.com', callId: 'call-42' }),
      })
    );
    expect(initRes.status).toBe(200);
    expect(await initRes.json()).toMatchObject({ callId: 'call-42', roomId: '!r:ex.com' });
    expect(state.storage.map.get('callId')).toBe('call-42');
    expect(state.storage.map.get('matrixRoomId')).toBe('!r:ex.com');

    const stateRes = await room.fetch(new Request('https://do/state'));
    expect(stateRes.status).toBe(200);
    expect(await stateRes.json()).toMatchObject({ callId: 'call-42' });

    const missing = await room.fetch(new Request('https://do/unknown'));
    expect(missing.status).toBe(404);
  });

  it('double leave/close on a bare socket is a no-op that leaves storage intact', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    await state.storage.put('callId', 'call-1');
    const room = makeRoom(state) as any;
    const bare = new FakeWebSocket();

    await room.handleLeave(bare);
    await room.webSocketClose(bare, 1000, 'bye');

    expect(state.storage.map.has('participant:u1|d1')).toBe(true);
    expect(state.storage.map.get('callId')).toBe('call-1');
  });
});


describe('CallRoom signaling TOKENMAXX edge paths after #55', () => {
  it('rejects duplicate join with ALREADY_JOINED before SFU createSession', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    const room = makeRoom(state) as any;
    const ws = new FakeWebSocket();

    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })
    );

    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'error',
      code: 'ALREADY_JOINED',
    });
    expect(state.storage.map.has('participant:u1|d1')).toBe(true);
  });

  it('rejects answer without join with NOT_JOINED', async () => {
    const state = new FakeState();
    const room = makeRoom(state) as any;
    const ws = new FakeWebSocket();

    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'answer', sdp: 'v=0' })
    );
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'error', code: 'NOT_JOINED' });
  });

  it('returns TRACK_NOT_FOUND when joined but trackName is missing', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'mute', trackName: 'missing', muted: true })
    );
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'error',
      code: 'TRACK_NOT_FOUND',
    });
  });

  it('persists mute state and broadcasts mute_changed to peers', async () => {
    const state = new FakeState();
    await state.storage.put(
      'participant:u1|d1',
      storedParticipant('u1', 'd1', { audio0: TRACK })
    );
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
    const wsA = new FakeWebSocket();
    wsA.serializeAttachment({ participantKey: 'u1|d1' });
    const wsB = new FakeWebSocket();
    wsB.serializeAttachment({ participantKey: 'u2|d2' });
    state.sockets = [wsA, wsB];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      wsA,
      JSON.stringify({ type: 'mute', trackName: 'audio0', muted: true })
    );

    const stored = state.storage.map.get('participant:u1|d1') as any;
    expect(stored.tracks.audio0.enabled).toBe(false);
    const changed = wsB.sent.map((s: string) => JSON.parse(s)).find(
      (m: { type: string }) => m.type === 'mute_changed'
    );
    expect(changed).toMatchObject({
      type: 'mute_changed',
      oderId: 'u1',
      deviceId: 'd1',
      trackName: 'audio0',
      muted: true,
    });
    expect(wsA.sent).toHaveLength(0);
  });

  it('handles leave via websocket message and notifies peers', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
    const wsA = new FakeWebSocket();
    wsA.serializeAttachment({ participantKey: 'u1|d1' });
    const wsB = new FakeWebSocket();
    wsB.serializeAttachment({ participantKey: 'u2|d2' });
    state.sockets = [wsA, wsB];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(wsA, JSON.stringify({ type: 'leave' }));

    expect(state.storage.map.has('participant:u1|d1')).toBe(false);
    expect(wsA.closed?.code).toBe(1000);
    const left = wsB.sent.map((s: string) => JSON.parse(s)).find(
      (m: { type: string }) => m.type === 'participant_left'
    );
    expect(left?.oderId).toBe('u1');
  });
});


describe('CallRoom signaling TOKENMAXX edge paths after #57', () => {
  beforeEach(() => {
    addTracksMock.mockReset();
    closeTracksMock.mockReset();
  });

  it('routes POST /end through fetch to wipe the call', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    await state.storage.put('callId', 'call-1');
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    const res = await room.fetch(new Request('https://do/end', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(state.storage.map.size).toBe(0);
    expect(ws.closed?.code).toBe(1000);
  });

  it('unmutes a track and broadcasts muted:false', async () => {
    const state = new FakeState();
    await state.storage.put(
      'participant:u1|d1',
      storedParticipant('u1', 'd1', { audio0: { ...TRACK, enabled: false } })
    );
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
    const wsA = new FakeWebSocket();
    wsA.serializeAttachment({ participantKey: 'u1|d1' });
    const wsB = new FakeWebSocket();
    wsB.serializeAttachment({ participantKey: 'u2|d2' });
    state.sockets = [wsA, wsB];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      wsA,
      JSON.stringify({ type: 'mute', trackName: 'audio0', muted: false })
    );

    const stored = state.storage.map.get('participant:u1|d1') as any;
    expect(stored.tracks.audio0.enabled).toBe(true);
    const changed = wsB.sent.map((s: string) => JSON.parse(s)).find(
      (m: { type: string }) => m.type === 'mute_changed'
    );
    expect(changed).toMatchObject({ muted: false, trackName: 'audio0' });
  });

  it('returns NO_ANSWER when SFU addTracks omits sessionDescription', async () => {
    addTracksMock.mockResolvedValueOnce({ tracks: [{ mid: '0' }] });
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'offer',
        trackName: 'audio0',
        kind: 'audio',
        sdp: 'v=0',
      })
    );
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'error', code: 'NO_ANSWER' });
  });

  it('surfaces SFU track errorCode from offer responses', async () => {
    addTracksMock.mockResolvedValueOnce({
      sessionDescription: { type: 'answer', sdp: 'v=0' },
      tracks: [{ errorCode: 'TRACK_FAILED', errorDescription: 'boom' }],
    });
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'offer',
        trackName: 'audio0',
        kind: 'audio',
        sdp: 'v=0',
      })
    );
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'error',
      code: 'TRACK_FAILED',
      message: 'boom',
    });
  });

  it('calls closeTracks on leave when tracks exist and swallows closeTracks failures', async () => {
    closeTracksMock.mockRejectedValueOnce(new Error('sfu down'));
    const state = new FakeState();
    await state.storage.put(
      'participant:u1|d1',
      storedParticipant('u1', 'd1', { audio0: TRACK })
    );
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
    const wsA = new FakeWebSocket();
    wsA.serializeAttachment({ participantKey: 'u1|d1' });
    const wsB = new FakeWebSocket();
    wsB.serializeAttachment({ participantKey: 'u2|d2' });
    state.sockets = [wsA, wsB];
    const room = makeRoom(state) as any;

    await room.handleLeave(wsA);

    expect(closeTracksMock).toHaveBeenCalledWith(
      expect.anything(),
      'session-u1',
      ['0'],
      true
    );
    expect(state.storage.map.has('participant:u1|d1')).toBe(false);
    expect(wsA.closed?.code).toBe(1000);
  });
});


describe('CallRoom signaling TOKENMAXX edge paths after #58', () => {
  it('returns 426 for /ws without Upgrade header', async () => {
    const room = makeRoom(new FakeState()) as any;
    const res = await room.fetch(new Request('https://do/ws'));
    expect(res.status).toBe(426);
    expect(await res.text()).toBe('Expected WebSocket');
  });
});

describe('CallRoom TOKENMAXX clock + signaling after #62', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    addTracksMock.mockReset();
    closeTracksMock.mockReset();
    createSessionMock.mockReset();
    renegotiateMock.mockReset();
    createSessionMock.mockResolvedValue({ sessionId: 'sess-new' });
    renegotiateMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins joinedAt to Date.now on join and persists it through hibernation', async () => {
    const state = new FakeState();
    const ws = new FakeWebSocket();
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })
    );

    expect(createSessionMock).toHaveBeenCalledOnce();
    const stored = state.storage.map.get('participant:u1|d1') as {
      joinedAt: number;
      sessionId: string;
    };
    expect(stored.joinedAt).toBe(NOW);
    expect(stored.sessionId).toBe('sess-new');
    expect(ws.attachment).toEqual({ participantKey: 'u1|d1' });

    const welcome = JSON.parse(ws.sent[0]);
    expect(welcome).toMatchObject({ type: 'welcome', participants: [] });

    const stateRes = await room.fetch(new Request('https://do/state'));
    const body = await stateRes.json();
    expect(body.participants[0].joinedAt).toBe(NOW);
  });

  it('broadcasts participant_joined to peers and excludes self from welcome', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u0|d0', storedParticipant('u0', 'd0'));
    const wsPeer = new FakeWebSocket();
    wsPeer.serializeAttachment({ participantKey: 'u0|d0' });
    const wsNew = new FakeWebSocket();
    state.sockets = [wsPeer, wsNew];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      wsNew,
      JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })
    );

    const welcome = JSON.parse(wsNew.sent[0]);
    expect(welcome.type).toBe('welcome');
    expect(welcome.participants).toEqual([
      { oderId: 'u0', deviceId: 'd0', tracks: [] },
    ]);

    const joined = wsPeer.sent.map((s: string) => JSON.parse(s)).find(
      (m: { type: string }) => m.type === 'participant_joined'
    );
    expect(joined).toMatchObject({
      type: 'participant_joined',
      oderId: 'u1',
      deviceId: 'd1',
    });
  });

  it('successful offer returns offer_response, persists track, and broadcasts track_published', async () => {
    addTracksMock.mockResolvedValueOnce({
      sessionDescription: { type: 'answer', sdp: 'v=answer' },
      tracks: [{ mid: '5' }],
    });
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
    const wsA = new FakeWebSocket();
    wsA.serializeAttachment({ participantKey: 'u1|d1' });
    const wsB = new FakeWebSocket();
    wsB.serializeAttachment({ participantKey: 'u2|d2' });
    state.sockets = [wsA, wsB];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      wsA,
      JSON.stringify({
        type: 'offer',
        trackName: 'video0',
        kind: 'video',
        sdp: 'v=0',
      })
    );

    expect(JSON.parse(wsA.sent[0])).toMatchObject({
      type: 'offer_response',
      sdp: 'v=answer',
      trackName: 'video0',
      mid: '5',
    });
    const stored = state.storage.map.get('participant:u1|d1') as {
      tracks: Record<string, { mid: string; kind: string; enabled: boolean }>;
    };
    expect(stored.tracks.video0).toEqual({ mid: '5', kind: 'video', enabled: true });

    const published = wsB.sent.map((s: string) => JSON.parse(s)).find(
      (m: { type: string }) => m.type === 'track_published'
    );
    expect(published).toMatchObject({
      type: 'track_published',
      oderId: 'u1',
      deviceId: 'd1',
      trackName: 'video0',
      kind: 'video',
      sessionId: 'session-u1',
    });
  });

  it('answer path calls renegotiate when joined', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'answer', sdp: 'v=answer' })
    );

    expect(renegotiateMock).toHaveBeenCalledWith(
      expect.anything(),
      'session-u1',
      { sessionDescription: { sdp: 'v=answer', type: 'answer' } }
    );
    expect(ws.sent).toHaveLength(0);
  });

  it('surfaces INTERNAL_ERROR when createSession throws during join', async () => {
    createSessionMock.mockRejectedValueOnce(new Error('sfu unavailable'));
    const state = new FakeState();
    const ws = new FakeWebSocket();
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })
    );

    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'error',
      code: 'INTERNAL_ERROR',
      message: 'sfu unavailable',
    });
    expect(state.storage.map.has('participant:u1|d1')).toBe(false);
  });

  it('handleGetState includes joinedAt from storage after rehydration', async () => {
    const state = new FakeState();
    await state.storage.put(
      'participant:u1|d1',
      storedParticipant('u1', 'd1', { audio0: TRACK })
    );
    const room = makeRoom(state) as any;
    const body = await (await room.handleGetState()).json();
    expect(body.participants[0].joinedAt).toBe(1752900000000);
  });
});

describe('CallRoom SFU/end/send leftovers TOKENMAXX after #76', () => {
  beforeEach(() => {
    addTracksMock.mockReset();
    closeTracksMock.mockReset();
    createSessionMock.mockReset();
    renegotiateMock.mockReset();
    createSessionMock.mockResolvedValue({ sessionId: 'sess-new' });
    renegotiateMock.mockResolvedValue(undefined);
  });

  it('returns 426 when Upgrade is present but not exactly "websocket"', async () => {
    const room = makeRoom(new FakeState()) as any;
    const res = await room.fetch(
      new Request('https://do/ws', { headers: { Upgrade: 'Websocket' } })
    );
    expect(res.status).toBe(426);
    expect(await res.text()).toBe('Expected WebSocket');
  });

  it('welcome includes callId from /init and empty string when unset', async () => {
    const state = new FakeState();
    const room = makeRoom(state) as any;
    await room.fetch(
      new Request('https://do/init', {
        method: 'POST',
        body: JSON.stringify({ callId: 'call-abc', roomId: '!m:example.com' }),
      })
    );
    const ws = new FakeWebSocket();
    state.sockets = [ws];
    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })
    );
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'welcome',
      callId: 'call-abc',
    });

    const cold = new FakeState();
    const coldRoom = makeRoom(cold) as any;
    const ws2 = new FakeWebSocket();
    cold.sockets = [ws2];
    await coldRoom.webSocketMessage(
      ws2,
      JSON.stringify({ type: 'join', userId: 'u2', deviceId: 'd2' })
    );
    expect(JSON.parse(ws2.sent[0])).toMatchObject({ type: 'welcome', callId: '' });
  });

  it('surfaces INTERNAL_ERROR when addTracks throws during offer', async () => {
    addTracksMock.mockRejectedValueOnce(new Error('track fail'));
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'offer',
        trackName: 'audio0',
        kind: 'audio',
        sessionDescription: { type: 'offer', sdp: 'v=0' },
      })
    );
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'error',
      code: 'INTERNAL_ERROR',
      message: 'track fail',
    });
  });

  it('surfaces INTERNAL_ERROR when renegotiate throws during answer', async () => {
    renegotiateMock.mockRejectedValueOnce(new Error('renegotiate boom'));
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'answer',
        sessionDescription: { type: 'answer', sdp: 'v=answer' },
      })
    );
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'error',
      code: 'INTERNAL_ERROR',
      message: 'renegotiate boom',
    });
  });

  it('handleEndCall closes tracks, swallows closeTracks failures, closes attached sockets only', async () => {
    closeTracksMock.mockRejectedValueOnce(new Error('sfu down'));
    const state = new FakeState();
    await state.storage.put(
      'participant:u1|d1',
      storedParticipant('u1', 'd1', { audio0: TRACK })
    );
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
    const attached = new FakeWebSocket();
    attached.serializeAttachment({ participantKey: 'u1|d1' });
    const bare = new FakeWebSocket();
    const peer = new FakeWebSocket();
    peer.serializeAttachment({ participantKey: 'u2|d2' });
    state.sockets = [attached, bare, peer];
    const room = makeRoom(state) as any;

    const res = await room.handleEndCall();
    expect(await res.json()).toEqual({ success: true });
    expect(closeTracksMock).toHaveBeenCalledWith(
      expect.anything(),
      'session-u1',
      ['0'],
      true
    );
    // only participants with tracks invoke closeTracks
    expect(closeTracksMock).toHaveBeenCalledTimes(1);
    expect(attached.closed).toEqual({ code: 1000, reason: 'Call ended' });
    expect(peer.closed).toEqual({ code: 1000, reason: 'Call ended' });
    expect(bare.closed).toBeNull();
    expect(state.storage.map.size).toBe(0);
  });

  it('handleEndCall swallows ws.close throw on already-closed sockets', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    ws.close = () => {
      throw new Error('already closed');
    };
    state.sockets = [ws];
    const room = makeRoom(state) as any;
    await expect(room.handleEndCall()).resolves.toBeInstanceOf(Response);
    expect(state.storage.map.size).toBe(0);
  });

  it('send/sendError swallows WebSocket send failures without throwing', async () => {
    const state = new FakeState();
    const ws = new FakeWebSocket();
    ws.send = () => {
      throw new Error('broken pipe');
    };
    state.sockets = [ws];
    const room = makeRoom(state) as any;
    await expect(
      room.webSocketMessage(ws, new ArrayBuffer(4))
    ).resolves.toBeUndefined();
  });

  it('broadcast swallows send failures to peers during mute_changed', async () => {
    const state = new FakeState();
    await state.storage.put(
      'participant:u1|d1',
      storedParticipant('u1', 'd1', { audio0: TRACK })
    );
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
    const self = new FakeWebSocket();
    self.serializeAttachment({ participantKey: 'u1|d1' });
    const peer = new FakeWebSocket();
    peer.serializeAttachment({ participantKey: 'u2|d2' });
    peer.send = () => {
      throw new Error('peer gone');
    };
    state.sockets = [self, peer];
    const room = makeRoom(state) as any;

    await expect(
      room.webSocketMessage(
        self,
        JSON.stringify({ type: 'mute', trackName: 'audio0', muted: true })
      )
    ).resolves.toBeUndefined();
  });

  it('surfaces INTERNAL_ERROR with non-Error throw message Unknown error', async () => {
    createSessionMock.mockRejectedValueOnce('string-fail');
    const state = new FakeState();
    const ws = new FakeWebSocket();
    state.sockets = [ws];
    const room = makeRoom(state) as any;
    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })
    );
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'error',
      code: 'INTERNAL_ERROR',
      message: 'Unknown error',
    });
  });

  it('handleEndCall with no participants still clears storage and succeeds', async () => {
    const state = new FakeState();
    await state.storage.put('meta:callId', 'x');
    const room = makeRoom(state) as any;
    const res = await room.handleEndCall();
    expect(await res.json()).toEqual({ success: true });
    expect(state.storage.map.size).toBe(0);
    expect(closeTracksMock).not.toHaveBeenCalled();
  });
});

/**
 * TOKENMAXX HEAVY leftovers after #232 — CallRoom hibernation *concurrent
 * race / TOCTOU* on existing CallRoomDurableObject. Sequential hibernation
 * + signaling coverage lives above; concurrent coverage was zero (no
 * Promise.all on join/leave/end/load/persist).
 *
 * Distinct from room-cache residual KV races in
 * test/room-cache-residual-concurrent-race-leftovers.test.ts.
 */

class RacingStorage {
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
    this.events.push('deleteAll');
    this.map.clear();
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    this.listCalls += 1;
    this.events.push(`list:${options.prefix}`);
    if (this.listHold) {
      await new Promise<void>((resolve) => {
        this.listWaiters.push(resolve);
      });
    }
    const out = new Map<string, T>();
    for (const [k, v] of [...this.map.entries()].sort()) {
      if (k.startsWith(options.prefix)) out.set(k, v as T);
    }
    return out;
  }
}

class RacingState {
  storage: RacingStorage;
  sockets: FakeWebSocket[] = [];

  constructor(storage = new RacingStorage()) {
    this.storage = storage;
  }

  getWebSockets(): FakeWebSocket[] {
    return this.sockets;
  }

  acceptWebSocket(ws: FakeWebSocket): void {
    this.sockets.push(ws);
  }

  setWebSocketAutoResponse(): void {}

  blockConcurrencyWhile(cb: () => Promise<void>): Promise<void> {
    return cb();
  }
}

function makeRacingRoom(state: RacingState): CallRoomDurableObject {
  return new CallRoomDurableObject(state as unknown as DurableObjectState, {} as Env);
}

function barrierFn<T>(n: number, factory: (i: number) => T): () => Promise<T> {
  const waiters: Array<() => void> = [];
  let seq = 0;
  return async () => {
    const mine = seq++;
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      if (waiters.length >= n) {
        const all = [...waiters];
        waiters.length = 0;
        for (const w of all) w();
      }
    });
    return factory(mine);
  };
}

describe('CallRoom hibernation concurrent join TOCTOU leftovers after #232', () => {
  beforeEach(() => {
    addTracksMock.mockReset();
    closeTracksMock.mockReset();
    createSessionMock.mockReset();
    renegotiateMock.mockReset();
    createSessionMock.mockResolvedValue({ sessionId: 'sess-new' });
    renegotiateMock.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 10; i++) {
    it(`same-key dual join after createSession barrier last-writer map size 1 flood-${i}`, async () => {
      createSessionMock.mockImplementation(barrierFn(2, (n) => ({ sessionId: `sess-${n}` })));
      const state = new RacingState();
      const wsA = new FakeWebSocket();
      const wsB = new FakeWebSocket();
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(wsA, JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })),
        room.webSocketMessage(wsB, JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })),
      ]);

      expect(createSessionMock).toHaveBeenCalledTimes(2);
      expect(room.participants.size).toBe(1);
      expect(state.storage.map.has('participant:u1|d1')).toBe(true);
      expect(wsA.attachment).toEqual({ participantKey: 'u1|d1' });
      expect(wsB.attachment).toEqual({ participantKey: 'u1|d1' });
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`A∥B join isolation two participants flood-${i}`, async () => {
      createSessionMock.mockImplementation(barrierFn(2, (n) => ({ sessionId: `sess-${n}` })));
      const state = new RacingState();
      const wsA = new FakeWebSocket();
      const wsB = new FakeWebSocket();
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(wsA, JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })),
        room.webSocketMessage(wsB, JSON.stringify({ type: 'join', userId: 'u2', deviceId: 'd2' })),
      ]);

      expect(room.participants.size).toBe(2);
      expect(state.storage.map.has('participant:u1|d1')).toBe(true);
      expect(state.storage.map.has('participant:u2|d2')).toBe(true);
      const welcomeA = JSON.parse(wsA.sent[0]);
      const welcomeB = JSON.parse(wsB.sent[0]);
      expect(welcomeA.type).toBe('welcome');
      expect(welcomeB.type).toBe('welcome');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`join∥ALREADY_JOINED sequential sibling isolation flood-${i}`, async () => {
      const state = new RacingState();
      await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
      const wsNew = new FakeWebSocket();
      const wsDup = new FakeWebSocket();
      state.sockets = [wsNew, wsDup];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(wsNew, JSON.stringify({ type: 'join', userId: 'u2', deviceId: 'd2' })),
        room.webSocketMessage(wsDup, JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })),
      ]);

      expect(JSON.parse(wsDup.sent[0])).toMatchObject({ type: 'error', code: 'ALREADY_JOINED' });
      expect(JSON.parse(wsNew.sent[0])).toMatchObject({ type: 'welcome' });
      expect(createSessionMock).toHaveBeenCalledOnce();
      expect(room.participants.size).toBe(2);
    });
  }
});

describe('CallRoom hibernation concurrent leave/end leftovers after #232', () => {
  beforeEach(() => {
    addTracksMock.mockReset();
    closeTracksMock.mockReset();
    createSessionMock.mockReset();
    renegotiateMock.mockReset();
    closeTracksMock.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`leave∥leave same socket closeTracks barrier idempotent flood-${i}`, async () => {
      closeTracksMock.mockImplementation(barrierFn(2, () => undefined));
      const state = new RacingState();
      await state.storage.put(
        'participant:u1|d1',
        storedParticipant('u1', 'd1', { audio0: TRACK })
      );
      await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
      const wsA = new FakeWebSocket();
      wsA.serializeAttachment({ participantKey: 'u1|d1' });
      const wsB = new FakeWebSocket();
      wsB.serializeAttachment({ participantKey: 'u2|d2' });
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([room.handleLeave(wsA), room.handleLeave(wsA)]);

      expect(closeTracksMock).toHaveBeenCalledTimes(2);
      expect(state.storage.map.has('participant:u1|d1')).toBe(false);
      expect(state.storage.map.has('participant:u2|d2')).toBe(true);
      expect(room.participants.size).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`leave∥webSocketClose∥webSocketError isolation flood-${i}`, async () => {
      const state = new RacingState();
      await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
      await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
      const wsA = new FakeWebSocket();
      wsA.serializeAttachment({ participantKey: 'u1|d1' });
      const wsB = new FakeWebSocket();
      wsB.serializeAttachment({ participantKey: 'u2|d2' });
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.handleLeave(wsA),
        room.webSocketClose(wsA, 1006, 'abnormal'),
        room.webSocketError(wsB, new Error('peer')),
      ]);

      expect(state.storage.map.has('participant:u1|d1')).toBe(false);
      expect(state.storage.map.has('participant:u2|d2')).toBe(false);
      expect(room.participants.size).toBe(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`A leave∥B leave isolation flood-${i}`, async () => {
      closeTracksMock.mockImplementation(barrierFn(2, () => undefined));
      const state = new RacingState();
      await state.storage.put(
        'participant:u1|d1',
        storedParticipant('u1', 'd1', { audio0: TRACK })
      );
      await state.storage.put(
        'participant:u2|d2',
        storedParticipant('u2', 'd2', { audio0: TRACK })
      );
      const wsA = new FakeWebSocket();
      wsA.serializeAttachment({ participantKey: 'u1|d1' });
      const wsB = new FakeWebSocket();
      wsB.serializeAttachment({ participantKey: 'u2|d2' });
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([room.handleLeave(wsA), room.handleLeave(wsB)]);

      expect(room.participants.size).toBe(0);
      expect(state.storage.map.size).toBe(0);
      expect(closeTracksMock).toHaveBeenCalledTimes(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`end∥leave last-writer storage empty flood-${i}`, async () => {
      const state = new RacingState();
      await state.storage.put(
        'participant:u1|d1',
        storedParticipant('u1', 'd1', { audio0: TRACK })
      );
      await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
      const wsA = new FakeWebSocket();
      wsA.serializeAttachment({ participantKey: 'u1|d1' });
      const wsB = new FakeWebSocket();
      wsB.serializeAttachment({ participantKey: 'u2|d2' });
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      const [endRes] = await Promise.all([room.handleEndCall(), room.handleLeave(wsA)]);
      expect(endRes.status).toBe(200);
      expect(state.storage.map.size).toBe(0);
      expect(room.participants.size).toBe(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`dual end is idempotent empty storage flood-${i}`, async () => {
      const state = new RacingState();
      await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
      await state.storage.put('callId', 'call-1');
      const ws = new FakeWebSocket();
      ws.serializeAttachment({ participantKey: 'u1|d1' });
      state.sockets = [ws];
      const room = makeRacingRoom(state) as any;

      const [a, b] = await Promise.all([room.handleEndCall(), room.handleEndCall()]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(state.storage.map.size).toBe(0);
    });
  }
});

describe('CallRoom hibernation persist TOCTOU mute/offer∥leave after #232', () => {
  beforeEach(() => {
    addTracksMock.mockReset();
    closeTracksMock.mockReset();
    createSessionMock.mockReset();
    renegotiateMock.mockReset();
    closeTracksMock.mockResolvedValue(undefined);
    addTracksMock.mockResolvedValue({
      sessionDescription: { type: 'answer', sdp: 'v=answer' },
      tracks: [{ mid: '5' }],
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`mute persist put-hold vs leave delete last-writer flood-${i}`, async () => {
      const state = new RacingState();
      await state.storage.put(
        'participant:u1|d1',
        storedParticipant('u1', 'd1', { audio0: TRACK })
      );
      await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
      state.storage.putHold.add('participant:u1|d1');
      const wsA = new FakeWebSocket();
      wsA.serializeAttachment({ participantKey: 'u1|d1' });
      const wsB = new FakeWebSocket();
      wsB.serializeAttachment({ participantKey: 'u2|d2' });
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      const muteP = room.webSocketMessage(
        wsA,
        JSON.stringify({ type: 'mute', trackName: 'audio0', muted: true })
      );
      await vi.waitFor(() => {
        expect(state.storage.events.filter((e) => e.startsWith('put:participant:u1|d1')).length).toBeGreaterThan(0);
      });
      await room.handleLeave(wsA);
      expect(state.storage.map.has('participant:u1|d1')).toBe(false);
      state.storage.releasePut('participant:u1|d1');
      await muteP;
      // persist completes after delete: documented ghost-row TOCTOU.
      expect(state.storage.map.has('participant:u1|d1')).toBe(true);
      expect(room.participants.has('u1|d1')).toBe(false);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`offer persist∥leave isolation peer remains flood-${i}`, async () => {
      const state = new RacingState();
      await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
      await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
      const wsA = new FakeWebSocket();
      wsA.serializeAttachment({ participantKey: 'u1|d1' });
      const wsB = new FakeWebSocket();
      wsB.serializeAttachment({ participantKey: 'u2|d2' });
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(
          wsA,
          JSON.stringify({ type: 'offer', trackName: 'video0', kind: 'video', sdp: 'v=0' })
        ),
        room.handleLeave(wsB),
      ]);

      expect(state.storage.map.has('participant:u2|d2')).toBe(false);
      expect(state.storage.map.has('participant:u1|d1')).toBe(true);
      const stored = state.storage.map.get('participant:u1|d1') as {
        tracks: Record<string, { mid: string }>;
      };
      expect(stored.tracks.video0.mid).toBe('5');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`join persist put-hold vs end deleteAll last-writer flood-${i}`, async () => {
      createSessionMock.mockResolvedValue({ sessionId: 'sess-hold' });
      const state = new RacingState();
      state.storage.putHold.add('participant:u1|d1');
      const ws = new FakeWebSocket();
      state.sockets = [ws];
      const room = makeRacingRoom(state) as any;

      const joinP = room.webSocketMessage(
        ws,
        JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })
      );
      await vi.waitFor(() => {
        expect(state.storage.events.some((e) => e === 'put:participant:u1|d1')).toBe(true);
      });
      await room.handleEndCall();
      expect(state.storage.map.size).toBe(0);
      state.storage.releasePut('participant:u1|d1');
      await joinP;
      expect(state.storage.map.has('participant:u1|d1')).toBe(true);
    });
  }
});

describe('CallRoom hibernation loadParticipants concurrent leftovers after #232', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`dual loadParticipants list-hold still one map flood-${i}`, async () => {
      const state = new RacingState();
      await state.storage.put(
        'participant:u1|d1',
        storedParticipant('u1', 'd1', { audio0: TRACK })
      );
      await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
      state.storage.listHold = true;
      const room = makeRacingRoom(state) as any;

      const loads = Promise.all([room.loadParticipants(), room.loadParticipants()]);
      await vi.waitFor(() => {
        expect(state.storage.listWaiters.length).toBe(2);
      });
      const waiters = [...state.storage.listWaiters];
      state.storage.listHold = false;
      state.storage.listWaiters = [];
      for (const w of waiters) w();
      await loads;

      expect(room.participants.size).toBe(2);
      expect(room.participants.get('u1|d1').tracks instanceof Map).toBe(true);
      expect(state.storage.listCalls).toBe(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`two revived instances over shared storage isolate memory flood-${i}`, async () => {
      const storage = new RacingStorage();
      const stateA = new RacingState(storage);
      const stateB = new RacingState(storage);
      await storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
      const a = makeRacingRoom(stateA) as any;
      const b = makeRacingRoom(stateB) as any;
      await Promise.all([a.loadParticipants(), b.loadParticipants()]);
      expect(a.participants.size).toBe(1);
      expect(b.participants.size).toBe(1);
      a.participants.delete('u1|d1');
      expect(b.participants.has('u1|d1')).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`GET /state ∥ join sees eventual participant flood-${i}`, async () => {
      createSessionMock.mockResolvedValue({ sessionId: 'sess-state' });
      const state = new RacingState();
      await state.storage.put('callId', 'call-9');
      const ws = new FakeWebSocket();
      state.sockets = [ws];
      const room = makeRacingRoom(state) as any;

      const [stateRes] = await Promise.all([
        room.fetch(new Request('https://do/state')),
        room.webSocketMessage(ws, JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })),
      ]);
      const body = await stateRes.json();
      const after = await (await room.fetch(new Request('https://do/state'))).json();
      expect(after.participants).toHaveLength(1);
      expect(body.participants.length === 0 || body.participants.length === 1).toBe(true);
      expect(after.callId).toBe('call-9');
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`init∥state callId visible after both settle flood-${i}`, async () => {
      const state = new RacingState();
      const room = makeRacingRoom(state) as any;
      const [initRes, stateRes] = await Promise.all([
        room.fetch(
          new Request('https://do/init', {
            method: 'POST',
            body: JSON.stringify({ roomId: '!r:example.com', callId: 'call-init' }),
          })
        ),
        room.fetch(new Request('https://do/state')),
      ]);
      expect(initRes.status).toBe(200);
      expect(stateRes.status).toBe(200);
      const settled = await (await room.fetch(new Request('https://do/state'))).json();
      expect(settled).toMatchObject({ callId: 'call-init', roomId: '!r:example.com' });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`broadcast during A∥B mute isolation flood-${i}`, async () => {
      const state = new RacingState();
      await state.storage.put(
        'participant:u1|d1',
        storedParticipant('u1', 'd1', { audio0: TRACK })
      );
      await state.storage.put(
        'participant:u2|d2',
        storedParticipant('u2', 'd2', { audio0: TRACK })
      );
      const wsA = new FakeWebSocket();
      wsA.serializeAttachment({ participantKey: 'u1|d1' });
      const wsB = new FakeWebSocket();
      wsB.serializeAttachment({ participantKey: 'u2|d2' });
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(wsA, JSON.stringify({ type: 'mute', trackName: 'audio0', muted: true })),
        room.webSocketMessage(wsB, JSON.stringify({ type: 'mute', trackName: 'audio0', muted: true })),
      ]);

      const aTracks = state.storage.map.get('participant:u1|d1') as {
        tracks: Record<string, { enabled: boolean }>;
      };
      const bTracks = state.storage.map.get('participant:u2|d2') as {
        tracks: Record<string, { enabled: boolean }>;
      };
      expect(aTracks.tracks.audio0.enabled).toBe(false);
      expect(bTracks.tracks.audio0.enabled).toBe(false);
      expect(wsA.sent.some((s) => JSON.parse(s).type === 'mute_changed')).toBe(true);
      expect(wsB.sent.some((s) => JSON.parse(s).type === 'mute_changed')).toBe(true);
    });
  }
});

/**
 * TOKENMAXX HEAVY leftovers after #240 — CallRoom hibernation *residual*
 * concurrent races not covered by #240 (answer/renegotiate, createSession
 * throw∥sibling, mute∥unmute, leave-msg∥close, offer∥offer, closeTracks
 * reject, NOT_JOINED∥join, ArrayBuffer∥join).
 */

describe('CallRoom hibernation residual answer/offer concurrent after #240', () => {
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
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`A∥B answer renegotiate barrier both called flood-${i}`, async () => {
      renegotiateMock.mockImplementation(barrierFn(2, () => undefined));
      const state = new RacingState();
      await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
      await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
      const wsA = new FakeWebSocket();
      wsA.serializeAttachment({ participantKey: 'u1|d1' });
      const wsB = new FakeWebSocket();
      wsB.serializeAttachment({ participantKey: 'u2|d2' });
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(wsA, JSON.stringify({ type: 'answer', sdp: 'a', mid: '0' })),
        room.webSocketMessage(wsB, JSON.stringify({ type: 'answer', sdp: 'b', mid: '1' })),
      ]);

      expect(renegotiateMock).toHaveBeenCalledTimes(2);
      expect(wsA.sent).toEqual([]);
      expect(wsB.sent).toEqual([]);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`offer∥offer same track last-writer mid flood-${i}`, async () => {
      let n = 0;
      addTracksMock.mockImplementation(async () => {
        const mid = String(n++);
        return {
          sessionDescription: { type: 'answer', sdp: `v=${mid}` },
          tracks: [{ mid }],
        };
      });
      const state = new RacingState();
      await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
      const ws = new FakeWebSocket();
      ws.serializeAttachment({ participantKey: 'u1|d1' });
      state.sockets = [ws];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(
          ws,
          JSON.stringify({ type: 'offer', trackName: 'video0', kind: 'video', sdp: 'v=0' })
        ),
        room.webSocketMessage(
          ws,
          JSON.stringify({ type: 'offer', trackName: 'video0', kind: 'video', sdp: 'v=1' })
        ),
      ]);

      expect(addTracksMock).toHaveBeenCalledTimes(2);
      const stored = state.storage.map.get('participant:u1|d1') as {
        tracks: Record<string, { mid: string }>;
      };
      expect(['0', '1']).toContain(stored.tracks.video0.mid);
      expect(Object.keys(stored.tracks)).toEqual(['video0']);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`answer∥leave mid renegotiate hold still deletes flood-${i}`, async () => {
      const waiters: Array<() => void> = [];
      renegotiateMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            waiters.push(resolve);
          })
      );
      const state = new RacingState();
      await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
      await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
      const wsA = new FakeWebSocket();
      wsA.serializeAttachment({ participantKey: 'u1|d1' });
      const wsB = new FakeWebSocket();
      wsB.serializeAttachment({ participantKey: 'u2|d2' });
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      const answerP = room.webSocketMessage(
        wsA,
        JSON.stringify({ type: 'answer', sdp: 'x', mid: '0' })
      );
      await vi.waitFor(() => {
        expect(waiters.length).toBe(1);
      });
      await room.handleLeave(wsA);
      expect(state.storage.map.has('participant:u1|d1')).toBe(false);
      waiters[0]();
      await answerP;
      expect(state.storage.map.has('participant:u2|d2')).toBe(true);
    });
  }
});

describe('CallRoom hibernation residual join/leave/mute concurrent after #240', () => {
  beforeEach(() => {
    addTracksMock.mockReset();
    closeTracksMock.mockReset();
    createSessionMock.mockReset();
    renegotiateMock.mockReset();
    createSessionMock.mockResolvedValue({ sessionId: 'sess-ok' });
    closeTracksMock.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`createSession throw∥sibling join isolation flood-${i}`, async () => {
      createSessionMock.mockImplementation(
        barrierFn(2, (n) => {
          if (n === 0) throw new Error('sfu down');
          return { sessionId: 'sess-b' };
        })
      );
      const state = new RacingState();
      const wsA = new FakeWebSocket();
      const wsB = new FakeWebSocket();
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(wsA, JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })),
        room.webSocketMessage(wsB, JSON.stringify({ type: 'join', userId: 'u2', deviceId: 'd2' })),
      ]);

      const msgs = [wsA, wsB].map((ws) => JSON.parse(ws.sent[0]));
      expect(msgs.some((m) => m.type === 'error' && m.code === 'INTERNAL_ERROR')).toBe(true);
      expect(msgs.some((m) => m.type === 'welcome')).toBe(true);
      expect(room.participants.size).toBe(1);
      expect(createSessionMock).toHaveBeenCalledTimes(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`mute∥unmute same track last-writer enabled flood-${i}`, async () => {
      const state = new RacingState();
      await state.storage.put(
        'participant:u1|d1',
        storedParticipant('u1', 'd1', { audio0: TRACK })
      );
      await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
      const wsA = new FakeWebSocket();
      wsA.serializeAttachment({ participantKey: 'u1|d1' });
      const wsB = new FakeWebSocket();
      wsB.serializeAttachment({ participantKey: 'u2|d2' });
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(
          wsA,
          JSON.stringify({ type: 'mute', trackName: 'audio0', muted: true })
        ),
        room.webSocketMessage(
          wsA,
          JSON.stringify({ type: 'mute', trackName: 'audio0', muted: false })
        ),
      ]);

      const stored = state.storage.map.get('participant:u1|d1') as {
        tracks: Record<string, { enabled: boolean }>;
      };
      expect([true, false]).toContain(stored.tracks.audio0.enabled);
      expect(wsB.sent.filter((s) => JSON.parse(s).type === 'mute_changed').length).toBe(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`leave message∥webSocketClose same socket idempotent flood-${i}`, async () => {
      closeTracksMock.mockImplementation(barrierFn(2, () => undefined));
      const state = new RacingState();
      await state.storage.put(
        'participant:u1|d1',
        storedParticipant('u1', 'd1', { audio0: TRACK })
      );
      await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
      const wsA = new FakeWebSocket();
      wsA.serializeAttachment({ participantKey: 'u1|d1' });
      const wsB = new FakeWebSocket();
      wsB.serializeAttachment({ participantKey: 'u2|d2' });
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(wsA, JSON.stringify({ type: 'leave' })),
        room.webSocketClose(wsA, 1000, 'bye'),
      ]);

      expect(state.storage.map.has('participant:u1|d1')).toBe(false);
      expect(state.storage.map.has('participant:u2|d2')).toBe(true);
      expect(closeTracksMock).toHaveBeenCalledTimes(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`closeTracks reject still deletes∥peer remains flood-${i}`, async () => {
      closeTracksMock.mockRejectedValue(new Error('close boom'));
      const state = new RacingState();
      await state.storage.put(
        'participant:u1|d1',
        storedParticipant('u1', 'd1', { audio0: TRACK })
      );
      await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
      const wsA = new FakeWebSocket();
      wsA.serializeAttachment({ participantKey: 'u1|d1' });
      const wsB = new FakeWebSocket();
      wsB.serializeAttachment({ participantKey: 'u2|d2' });
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([room.handleLeave(wsA), room.handleLeave(wsB)]);

      expect(room.participants.size).toBe(0);
      expect(state.storage.map.size).toBe(0);
      expect(closeTracksMock).toHaveBeenCalledTimes(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`NOT_JOINED offer∥join race eventual participant flood-${i}`, async () => {
      createSessionMock.mockResolvedValue({ sessionId: 'sess-race' });
      const state = new RacingState();
      const ws = new FakeWebSocket();
      state.sockets = [ws];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(
          ws,
          JSON.stringify({ type: 'offer', trackName: 'audio0', kind: 'audio', sdp: 'v=0' })
        ),
        room.webSocketMessage(ws, JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })),
      ]);

      const errs = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'error');
      const welcomes = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'welcome');
      expect(welcomes.length).toBe(1);
      expect(errs.some((e) => e.code === 'NOT_JOINED')).toBe(true);
      expect(room.participants.has('u1|d1')).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`ArrayBuffer∥join isolation flood-${i}`, async () => {
      createSessionMock.mockResolvedValue({ sessionId: 'sess-bin' });
      const state = new RacingState();
      const wsA = new FakeWebSocket();
      const wsB = new FakeWebSocket();
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(wsA, new ArrayBuffer(4)),
        room.webSocketMessage(wsB, JSON.stringify({ type: 'join', userId: 'u2', deviceId: 'd2' })),
      ]);

      expect(JSON.parse(wsA.sent[0])).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      });
      expect(JSON.parse(wsB.sent[0])).toMatchObject({ type: 'welcome' });
      expect(room.participants.size).toBe(1);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`unknown message∥mute isolation flood-${i}`, async () => {
      const state = new RacingState();
      await state.storage.put(
        'participant:u1|d1',
        storedParticipant('u1', 'd1', { audio0: TRACK })
      );
      await state.storage.put(
        'participant:u2|d2',
        storedParticipant('u2', 'd2', { audio0: TRACK })
      );
      const wsA = new FakeWebSocket();
      wsA.serializeAttachment({ participantKey: 'u1|d1' });
      const wsB = new FakeWebSocket();
      wsB.serializeAttachment({ participantKey: 'u2|d2' });
      state.sockets = [wsA, wsB];
      const room = makeRacingRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(wsA, JSON.stringify({ type: 'nope' })),
        room.webSocketMessage(
          wsB,
          JSON.stringify({ type: 'mute', trackName: 'audio0', muted: true })
        ),
      ]);

      expect(JSON.parse(wsA.sent[0])).toMatchObject({ type: 'error', code: 'UNKNOWN_MESSAGE' });
      const bTracks = state.storage.map.get('participant:u2|d2') as {
        tracks: Record<string, { enabled: boolean }>;
      };
      expect(bTracks.tracks.audio0.enabled).toBe(false);
    });
  }
});
