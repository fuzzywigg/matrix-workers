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
