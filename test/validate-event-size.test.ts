import { describe, it, expect } from 'vitest';
import { validateEventSize } from '../src/services/database';
import { MatrixApiError } from '../src/utils/errors';
import type { PDU } from '../src/types';

function baseEvent(content: Record<string, unknown> = { body: 'hi' }): PDU {
  return {
    event_id: '$evt:example.com',
    type: 'm.room.message',
    room_id: '!room:example.com',
    sender: '@alice:example.com',
    content,
    origin_server_ts: 1,
    auth_events: [],
    prev_events: [],
    depth: 1,
  };
}

describe('validateEventSize', () => {
  it('accepts a normal-sized event', () => {
    expect(() => validateEventSize(baseEvent())).not.toThrow();
  });

  it('accepts missing content by treating it as {}', () => {
    const event = baseEvent();
    delete (event as { content?: unknown }).content;
    expect(() => validateEventSize(event as PDU)).not.toThrow();
  });

  it('rejects content larger than the 64KiB soft cap', () => {
    const event = baseEvent({ body: 'x'.repeat(65_536) });
    expect(() => validateEventSize(event)).toThrow(MatrixApiError);
    try {
      validateEventSize(event);
    } catch (err) {
      const e = err as MatrixApiError;
      expect(e.errcode).toBe('M_TOO_LARGE');
      expect(e.status).toBe(413);
      expect(e.message).toMatch(/content exceeds/);
    }
  });

  it('rejects a full PDU larger than the D1 hard cap even if content alone is under soft cap', () => {
    // Inflate non-content fields so content JSON stays under 65_536 but full JSON exceeds 921_600.
    const event = baseEvent({ body: 'ok' });
    event.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    expect(JSON.stringify(event.content).length).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(event).length).toBeGreaterThan(921_600);
    expect(() => validateEventSize(event)).toThrow(/D1 row limit/);
  });

  it('allows content exactly at the soft-cap boundary', () => {
    // JSON.stringify adds {"body":"..."} overhead; size the payload so content JSON length == 65536.
    const overhead = JSON.stringify({ body: '' }).length; // 11
    const body = 'y'.repeat(65_536 - overhead);
    const event = baseEvent({ body });
    expect(JSON.stringify(event.content).length).toBe(65_536);
    expect(() => validateEventSize(event)).not.toThrow();
  });

  it('rejects content one byte over the soft cap', () => {
    const overhead = JSON.stringify({ body: '' }).length;
    const body = 'z'.repeat(65_536 - overhead + 1);
    const event = baseEvent({ body });
    expect(JSON.stringify(event.content).length).toBe(65_537);
    expect(() => validateEventSize(event)).toThrow(/content exceeds/);
  });
});
