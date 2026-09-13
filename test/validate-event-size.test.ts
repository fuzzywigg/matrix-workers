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


describe('validateEventSize TOKENMAXX edge paths after #49', () => {
  it('accepts empty content objects and array/null content JSON sizes', () => {
    expect(() => validateEventSize(baseEvent({}))).not.toThrow();
    expect(() => validateEventSize(baseEvent({ items: [] }))).not.toThrow();
  });

  it('rejects content that is over the soft cap even when nested', () => {
    const event = baseEvent({ nested: { blob: 'n'.repeat(65_536) } });
    expect(() => validateEventSize(event)).toThrow(/content exceeds/);
  });
});

describe('validateEventSize TOKENMAXX edge paths after #50', () => {
  it('accepts a full PDU exactly at the 921_600 hard-cap boundary', () => {
    const event = baseEvent({ body: 'ok' });
    const target = 921_600;
    // Inflate non-content fields so content stays under the soft cap
    event.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    expect(JSON.stringify(event.content).length).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(event).length).toBeGreaterThan(target);
    while (JSON.stringify(event).length > target) {
      event.auth_events.pop();
    }
    const need = target - JSON.stringify(event).length;
    if (need > 0) {
      event.auth_events.push(`$p${'x'.repeat(Math.max(0, need - 2))}`);
      while (JSON.stringify(event).length < target) {
        event.auth_events[event.auth_events.length - 1] += 'x';
      }
      while (JSON.stringify(event).length > target) {
        const last = event.auth_events[event.auth_events.length - 1];
        event.auth_events[event.auth_events.length - 1] = last.slice(0, -1);
      }
    }
    expect(JSON.stringify(event.content).length).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(event).length).toBe(target);
    expect(() => validateEventSize(event)).not.toThrow();
  });

  it('treats null content as {} for the soft-cap path', () => {
    const event = baseEvent();
    (event as { content: unknown }).content = null;
    expect(() => validateEventSize(event)).not.toThrow();
  });
});


describe('validateEventSize TOKENMAXX edge paths after #69', () => {
  it('includes the measured byte count in soft-cap and hard-cap error messages', () => {
    const soft = baseEvent({ body: 'x'.repeat(65_536) });
    const softLen = JSON.stringify(soft.content).length;
    try {
      validateEventSize(soft);
      expect.unreachable('soft cap');
    } catch (err) {
      const e = err as MatrixApiError;
      expect(e.message).toBe(
        `Event content exceeds 65536 byte limit (got ${softLen})`
      );
      expect(e.errcode).toBe('M_TOO_LARGE');
      expect(e.status).toBe(413);
    }

    const hard = baseEvent({ body: 'ok' });
    hard.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    const hardLen = JSON.stringify(hard).length;
    expect(hardLen).toBeGreaterThan(921_600);
    try {
      validateEventSize(hard);
      expect.unreachable('hard cap');
    } catch (err) {
      const e = err as MatrixApiError;
      expect(e.message).toBe(
        `Serialized event exceeds 921600 byte D1 row limit (got ${hardLen})`
      );
    }
  });

  it('treats undefined content like missing content (soft-cap uses {})', () => {
    const event = baseEvent();
    (event as { content?: unknown }).content = undefined;
    expect(() => validateEventSize(event)).not.toThrow();
  });

  it('accepts unicode content under the soft cap and rejects when over', () => {
    // Multi-byte UTF-8 still counts as JS string length in JSON.stringify
    const ok = baseEvent({ body: '😀'.repeat(100) });
    expect(() => validateEventSize(ok)).not.toThrow();
    const big = baseEvent({ body: 'あ'.repeat(65_536) });
    expect(() => validateEventSize(big)).toThrow(/content exceeds/);
  });

  it('rejects when soft cap passes but hard cap fails due to large prev_events', () => {
    const event = baseEvent({ body: 'small' });
    event.prev_events = Array.from({ length: 40_000 }, (_, i) => `$prev-${i}:example.com`);
    expect(JSON.stringify(event.content).length).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(event).length).toBeGreaterThan(921_600);
    expect(() => validateEventSize(event)).toThrow(/D1 row limit/);
  });

  it('accepts a PDU one byte under the hard cap', () => {
    const event = baseEvent({ body: 'ok' });
    const target = 921_599;
    event.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    while (JSON.stringify(event).length > target) {
      event.auth_events.pop();
    }
    while (JSON.stringify(event).length < target) {
      const gap = target - JSON.stringify(event).length;
      event.auth_events.push(`$p${'x'.repeat(Math.max(0, gap - 2))}`);
      while (JSON.stringify(event).length < target) {
        event.auth_events[event.auth_events.length - 1] += 'x';
      }
      while (JSON.stringify(event).length > target) {
        const last = event.auth_events[event.auth_events.length - 1];
        event.auth_events[event.auth_events.length - 1] = last.slice(0, -1);
      }
    }
    expect(JSON.stringify(event).length).toBe(target);
    expect(() => validateEventSize(event)).not.toThrow();
  });
});
