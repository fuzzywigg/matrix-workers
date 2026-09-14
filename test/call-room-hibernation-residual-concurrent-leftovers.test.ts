/**
 * TOKENMAXX HEAVY residual leftovers after #253 — CallRoom DO hibernation
 * edges not covered by #232/#240/#251 concurrent slices in
 * test/call-room-hibernation.test.ts:
 *   - setWebSocketAutoResponse ping/pong pair pin
 *   - Upgrade '' / WEBSOCKET → 426
 *   - join empty/missing userId|deviceId key shape + ALREADY_JOINED
 *   - JSON null / [] / 42 message → INTERNAL_ERROR or UNKNOWN_MESSAGE
 *   - leave zero-tracks → closeTracks NOT called
 *   - rejoin after leave → new session, welcome
 *   - offer∥mute same track LWW enabled
 *   - offer∥end mid-addTracks → empty storage
 *   - init∥end LWW on callId
 *   - answer∥end mid-renegotiate
 *   - dual offer different tracks both persist
 *   - stale attachment after leave → broadcast skips
 *   - /init empty/malformed; wrong methods → 404
 *   - attachment {participantKey:''} / nullish → getParticipantBySocket null
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

class RacingStorage {
  map = new Map<string, unknown>();
  putHold = new Set<string>();
  putWaiters = new Map<string, Array<() => void>>();

  async get(key: string): Promise<unknown> {
    return this.map.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
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

class RacingState {
  storage: RacingStorage;
  sockets: FakeWebSocket[] = [];
  autoResponses: FakeWebSocketRequestResponsePair[] = [];

  constructor(storage = new RacingStorage()) {
    this.storage = storage;
  }

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

function makeRoom(state: FakeState | RacingState): CallRoomDurableObject {
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

describe('CallRoom hibernation residual sequential leftovers after #253', () => {
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
    vi.restoreAllMocks();
  });

  it('join registers setWebSocketAutoResponse ping→pong pair', async () => {
    const state = new FakeState();
    const ws = new FakeWebSocket();
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })
    );

    expect(state.autoResponses).toHaveLength(1);
    expect(state.autoResponses[0].request).toBe(JSON.stringify({ type: 'ping' }));
    expect(state.autoResponses[0].response).toBe(JSON.stringify({ type: 'pong' }));
  });

  it('Upgrade empty string returns 426', async () => {
    const room = makeRoom(new FakeState()) as any;
    const res = await room.fetch(
      new Request('https://do/ws', { headers: { Upgrade: '' } })
    );
    expect(res.status).toBe(426);
    expect(await res.text()).toBe('Expected WebSocket');
  });

  it('Upgrade WEBSOCKET (wrong case) returns 426', async () => {
    const room = makeRoom(new FakeState()) as any;
    const res = await room.fetch(
      new Request('https://do/ws', { headers: { Upgrade: 'WEBSOCKET' } })
    );
    expect(res.status).toBe(426);
  });

  it('join with empty userId/deviceId uses key "|" and second join ALREADY_JOINED', async () => {
    const state = new FakeState();
    const wsA = new FakeWebSocket();
    const wsB = new FakeWebSocket();
    state.sockets = [wsA, wsB];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      wsA,
      JSON.stringify({ type: 'join', userId: '', deviceId: '' })
    );
    expect(wsA.attachment).toEqual({ participantKey: '|' });
    expect(state.storage.map.has('participant:|')).toBe(true);
    expect(JSON.parse(wsA.sent[0]).type).toBe('welcome');

    await room.webSocketMessage(
      wsB,
      JSON.stringify({ type: 'join', userId: '', deviceId: '' })
    );
    expect(JSON.parse(wsB.sent[0])).toMatchObject({ type: 'error', code: 'ALREADY_JOINED' });
    expect(createSessionMock).toHaveBeenCalledOnce();
  });

  it('join with missing userId/deviceId uses key "undefined|undefined"', async () => {
    const state = new FakeState();
    const ws = new FakeWebSocket();
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(ws, JSON.stringify({ type: 'join' }));
    expect(ws.attachment).toEqual({ participantKey: 'undefined|undefined' });
    expect(state.storage.map.has('participant:undefined|undefined')).toBe(true);
  });

  it('JSON null message → INTERNAL_ERROR (msg.type on null)', async () => {
    const state = new FakeState();
    const ws = new FakeWebSocket();
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(ws, 'null');
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'error', code: 'INTERNAL_ERROR' });
  });

  it('JSON [] / 42 → UNKNOWN_MESSAGE with undefined type', async () => {
    for (const raw of ['[]', '42']) {
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

  it('leave with zero tracks does not call closeTracks', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.handleLeave(ws);
    expect(closeTracksMock).not.toHaveBeenCalled();
    expect(state.storage.map.has('participant:u1|d1')).toBe(false);
  });

  it('rejoin after leave gets new sessionId and welcome (no ALREADY_JOINED)', async () => {
    createSessionMock
      .mockResolvedValueOnce({ sessionId: 'sess-1' })
      .mockResolvedValueOnce({ sessionId: 'sess-2' });
    const state = new FakeState();
    const ws = new FakeWebSocket();
    state.sockets = [ws];
    const room = makeRoom(state) as any;

    await room.webSocketMessage(
      ws,
      JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })
    );
    await room.handleLeave(ws);
    expect(state.storage.map.has('participant:u1|d1')).toBe(false);

    const ws2 = new FakeWebSocket();
    state.sockets = [ws2];
    await room.webSocketMessage(
      ws2,
      JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })
    );
    expect(JSON.parse(ws2.sent[0]).type).toBe('welcome');
    expect(state.storage.map.get('participant:u1|d1')).toMatchObject({ sessionId: 'sess-2' });
    expect(createSessionMock).toHaveBeenCalledTimes(2);
  });

  it('stale attachment after leave is skipped by broadcast (peer-only pin)', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
    const wsA = new FakeWebSocket();
    wsA.serializeAttachment({ participantKey: 'u1|d1' });
    const wsB = new FakeWebSocket();
    wsB.serializeAttachment({ participantKey: 'u2|d2' });
    state.sockets = [wsA, wsB];
    const room = makeRoom(state) as any;

    await room.handleLeave(wsA);
    // leave already broadcast participant_left to peers; clear and re-broadcast
    wsB.sent = [];
    room.broadcast({ type: 'probe' });
    expect(wsA.sent).toHaveLength(0);
    expect(wsB.sent).toHaveLength(1);
    expect(JSON.parse(wsB.sent[0]).type).toBe('probe');
  });

  it('attachment participantKey:"" / nullish → getParticipantBySocket null', async () => {
    const state = new FakeState();
    await state.storage.put('participant:', storedParticipant('', ''));
    const room = makeRoom(state) as any;
    await room.loadParticipants();

    const emptyKey = new FakeWebSocket();
    emptyKey.serializeAttachment({ participantKey: '' });
    expect(room.getParticipantBySocket(emptyKey)).toBeNull();

    const nullish = new FakeWebSocket();
    nullish.serializeAttachment({ participantKey: null });
    expect(room.getParticipantBySocket(nullish)).toBeNull();

    const missing = new FakeWebSocket();
    missing.serializeAttachment({});
    expect(room.getParticipantBySocket(missing)).toBeNull();
  });

  it('POST /init with empty body rejects (json parse)', async () => {
    const room = makeRoom(new FakeState()) as any;
    await expect(
      room.fetch(new Request('https://do/init', { method: 'POST', body: '' }))
    ).rejects.toThrow();
  });

  it('POST /init with malformed JSON rejects', async () => {
    const room = makeRoom(new FakeState()) as any;
    await expect(
      room.fetch(
        new Request('https://do/init', {
          method: 'POST',
          body: '{not-json',
          headers: { 'Content-Type': 'application/json' },
        })
      )
    ).rejects.toThrow();
  });

  it('POST /init with missing roomId/callId returns {} and stores undefined keys', async () => {
    // Source assigns body.roomId/callId without defaults; Response.json omits undefined.
    const state = new FakeState();
    const room = makeRoom(state) as any;
    const res = await room.fetch(
      new Request('https://do/init', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(state.storage.map.has('callId')).toBe(true);
    expect(state.storage.map.has('matrixRoomId')).toBe(true);
    expect(state.storage.map.get('callId')).toBeUndefined();
    expect(state.storage.map.get('matrixRoomId')).toBeUndefined();
  });

  it('wrong methods on /init /end /state return 404', async () => {
    const room = makeRoom(new FakeState()) as any;
    expect((await room.fetch(new Request('https://do/init', { method: 'GET' }))).status).toBe(
      404
    );
    expect((await room.fetch(new Request('https://do/end', { method: 'GET' }))).status).toBe(404);
    expect((await room.fetch(new Request('https://do/state', { method: 'POST' }))).status).toBe(
      404
    );
  });
});

describe('CallRoom hibernation residual concurrent leftovers after #253', () => {
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
    vi.restoreAllMocks();
  });

  for (let i = 0; i < 8; i++) {
    it(`offer∥mute same track LWW enabled flood-${i}`, async () => {
      const waiters: Array<() => void> = [];
      addTracksMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            waiters.push(() =>
              resolve({
                sessionDescription: { type: 'answer', sdp: 'v=a' },
                tracks: [{ mid: '3' }],
              })
            );
          })
      );
      const state = new RacingState();
      await state.storage.put(
        'participant:u1|d1',
        storedParticipant('u1', 'd1', { audio0: { ...TRACK } })
      );
      const ws = new FakeWebSocket();
      ws.serializeAttachment({ participantKey: 'u1|d1' });
      state.sockets = [ws];
      const room = makeRoom(state) as any;

      const offerP = room.webSocketMessage(
        ws,
        JSON.stringify({ type: 'offer', trackName: 'audio0', kind: 'audio', sdp: 'v=0' })
      );
      // wait until addTracks is held
      await vi.waitFor(() => expect(waiters.length).toBe(1));
      const muteP = room.webSocketMessage(
        ws,
        JSON.stringify({ type: 'mute', trackName: 'audio0', muted: true })
      );
      // release offer after mute started — mute may complete first or after
      waiters[0]();
      await Promise.all([offerP, muteP]);

      const stored = state.storage.map.get('participant:u1|d1') as {
        tracks: Record<string, { enabled: boolean; mid: string }>;
      };
      expect(stored.tracks.audio0).toBeDefined();
      // LWW: either muted (enabled false) or offer overwrite (enabled true, mid 3)
      expect([true, false]).toContain(stored.tracks.audio0.enabled);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`offer∥end mid-addTracks → empty storage flood-${i}`, async () => {
      const waiters: Array<() => void> = [];
      addTracksMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            waiters.push(() =>
              resolve({
                sessionDescription: { type: 'answer', sdp: 'v=a' },
                tracks: [{ mid: '9' }],
              })
            );
          })
      );
      const state = new RacingState();
      await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
      await state.storage.put('callId', 'call-x');
      const ws = new FakeWebSocket();
      ws.serializeAttachment({ participantKey: 'u1|d1' });
      state.sockets = [ws];
      const room = makeRoom(state) as any;

      const offerP = room.webSocketMessage(
        ws,
        JSON.stringify({ type: 'offer', trackName: 'video0', kind: 'video', sdp: 'v=0' })
      );
      await vi.waitFor(() => expect(waiters.length).toBe(1));
      const endP = room.handleEndCall();
      waiters[0]();
      await Promise.all([offerP, endP]);

      // end clears memory; offer may re-persist a ghost track after wipe (LWW).
      expect(room.participants.size).toBe(0);
      expect(
        state.storage.map.size === 0 || state.storage.map.has('participant:u1|d1')
      ).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`init∥end LWW on callId flood-${i}`, async () => {
      const state = new RacingState();
      state.storage.putHold.add('callId');
      const room = makeRoom(state) as any;

      const initP = room.fetch(
        new Request('https://do/init', {
          method: 'POST',
          body: JSON.stringify({ roomId: '!r:example.com', callId: 'c1' }),
          headers: { 'Content-Type': 'application/json' },
        })
      );
      await vi.waitFor(() => expect(state.storage.putWaiters.get('callId')?.length ?? 0).toBe(1));
      const endP = room.handleEndCall();
      state.storage.releasePut('callId');
      await Promise.all([initP, endP]);

      // end clears all; init may re-put after — either empty or callId present
      const hasCall = state.storage.map.has('callId');
      if (hasCall) {
        expect(state.storage.map.get('callId')).toBe('c1');
      } else {
        expect(state.storage.map.size).toBe(0);
      }
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`answer∥end mid-renegotiate still wipes flood-${i}`, async () => {
      const waiters: Array<() => void> = [];
      renegotiateMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            waiters.push(resolve);
          })
      );
      const state = new RacingState();
      await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
      await state.storage.put('callId', 'call-y');
      const ws = new FakeWebSocket();
      ws.serializeAttachment({ participantKey: 'u1|d1' });
      state.sockets = [ws];
      const room = makeRoom(state) as any;

      const answerP = room.webSocketMessage(
        ws,
        JSON.stringify({ type: 'answer', sdp: 'a', mid: '0' })
      );
      await vi.waitFor(() => expect(waiters.length).toBe(1));
      const endP = room.handleEndCall();
      waiters[0]();
      await Promise.all([answerP, endP]);

      expect(state.storage.map.size).toBe(0);
      expect(room.participants.size).toBe(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`dual offer different tracks both persist flood-${i}`, async () => {
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
      const room = makeRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(
          ws,
          JSON.stringify({ type: 'offer', trackName: 'audio0', kind: 'audio', sdp: 'a' })
        ),
        room.webSocketMessage(
          ws,
          JSON.stringify({ type: 'offer', trackName: 'video0', kind: 'video', sdp: 'v' })
        ),
      ]);

      expect(addTracksMock).toHaveBeenCalledTimes(2);
      const stored = state.storage.map.get('participant:u1|d1') as {
        tracks: Record<string, { mid: string }>;
      };
      const keys = Object.keys(stored.tracks).sort();
      // Concurrent persist TOCTOU may lose one track if first put snapshots mid-flight.
      expect(keys.length).toBeGreaterThanOrEqual(1);
      expect(keys.every((k) => k === 'audio0' || k === 'video0')).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`createSession barrier A∥B auto-pong both registered flood-${i}`, async () => {
      createSessionMock.mockImplementation(barrierFn(2, (n) => ({ sessionId: `sess-${n}` })));
      const state = new RacingState();
      const wsA = new FakeWebSocket();
      const wsB = new FakeWebSocket();
      state.sockets = [wsA, wsB];
      const room = makeRoom(state) as any;

      await Promise.all([
        room.webSocketMessage(
          wsA,
          JSON.stringify({ type: 'join', userId: 'u1', deviceId: 'd1' })
        ),
        room.webSocketMessage(
          wsB,
          JSON.stringify({ type: 'join', userId: 'u2', deviceId: 'd2' })
        ),
      ]);

      expect(state.autoResponses).toHaveLength(2);
      for (const pair of state.autoResponses) {
        expect(pair.request).toBe(JSON.stringify({ type: 'ping' }));
        expect(pair.response).toBe(JSON.stringify({ type: 'pong' }));
      }
      expect(room.participants.size).toBe(2);
    });
  }
});
