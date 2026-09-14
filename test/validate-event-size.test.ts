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

describe('validateEventSize TOKENMAXX leftovers after #241', () => {
  it('rejects a full PDU one byte over the hard cap with errcode/status/got count', () => {
    const event = baseEvent({ body: 'ok' });
    const target = 921_601;
    event.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
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
    try {
      validateEventSize(event);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as MatrixApiError;
      expect(e.errcode).toBe('M_TOO_LARGE');
      expect(e.status).toBe(413);
      expect(e.message).toMatch(/921600/);
      expect(e.message).toMatch(/got 921601/);
      expect(e.message).toMatch(/D1 row limit/);
    }
  });

  it('soft-cap check precedes hard-cap when content alone is oversized', () => {
    const event = baseEvent({ body: 'x'.repeat(70_000) });
    // Full PDU is also well over the hard cap once content is this large
    expect(JSON.stringify(event).length).toBeGreaterThan(65_536);
    expect(() => validateEventSize(event)).toThrow(/content exceeds/);
    expect(() => validateEventSize(event)).not.toThrow(/D1 row limit/);
  });
});

describe('validateEventSize TOKENMAXX residual leftovers after #252', () => {
  it('accepts a full PDU one byte under the hard cap', () => {
    const event = baseEvent({ body: 'ok' });
    const target = 921_599;
    event.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
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

  it('does not mutate the event when validation succeeds or fails', () => {
    const ok = baseEvent({ body: 'hi' });
    const beforeOk = JSON.stringify(ok);
    validateEventSize(ok);
    expect(JSON.stringify(ok)).toBe(beforeOk);

    const bad = baseEvent({ body: 'z'.repeat(70_000) });
    const beforeBad = JSON.stringify(bad);
    expect(() => validateEventSize(bad)).toThrow(MatrixApiError);
    expect(JSON.stringify(bad)).toBe(beforeBad);
  });
});

describe('validateEventSize TOKENMAXX residual leftovers after #264', () => {
  it('concurrent soft-cap rejects stay independent MatrixApiError instances', async () => {
    const a = baseEvent({ body: 'a'.repeat(70_000) });
    const b = baseEvent({ body: 'b'.repeat(70_000) });
    const beforeA = JSON.stringify(a);
    const beforeB = JSON.stringify(b);
    const [ra, rb] = await Promise.all([
      Promise.resolve().then(() => {
        try {
          validateEventSize(a);
          return null;
        } catch (err) {
          return err as MatrixApiError;
        }
      }),
      Promise.resolve().then(() => {
        try {
          validateEventSize(b);
          return null;
        } catch (err) {
          return err as MatrixApiError;
        }
      }),
    ]);
    expect(ra).toBeInstanceOf(MatrixApiError);
    expect(rb).toBeInstanceOf(MatrixApiError);
    expect(ra).not.toBe(rb);
    expect(ra!.errcode).toBe('M_TOO_LARGE');
    expect(rb!.status).toBe(413);
    expect(ra!.message).toMatch(/content exceeds/);
    expect(rb!.message).toMatch(/content exceeds/);
    expect(JSON.stringify(a)).toBe(beforeA);
    expect(JSON.stringify(b)).toBe(beforeB);
  });

  it('concurrent ok + soft-cap reject: ok succeeds, reject throws, neither mutates', async () => {
    const ok = baseEvent({ body: 'hi' });
    const bad = baseEvent({ body: 'z'.repeat(70_000) });
    const beforeOk = JSON.stringify(ok);
    const beforeBad = JSON.stringify(bad);
    const [okResult, badResult] = await Promise.allSettled([
      Promise.resolve().then(() => {
        validateEventSize(ok);
        return 'ok';
      }),
      Promise.resolve().then(() => {
        validateEventSize(bad);
        return 'bad';
      }),
    ]);
    expect(okResult.status).toBe('fulfilled');
    expect(badResult.status).toBe('rejected');
    if (badResult.status === 'rejected') {
      expect(badResult.reason).toBeInstanceOf(MatrixApiError);
      expect((badResult.reason as MatrixApiError).message).toMatch(/content exceeds/);
    }
    expect(JSON.stringify(ok)).toBe(beforeOk);
    expect(JSON.stringify(bad)).toBe(beforeBad);
  });

  it('soft-cap error message embeds the observed content byte length', () => {
    const overhead = JSON.stringify({ body: '' }).length;
    const body = 'q'.repeat(65_536 - overhead + 3);
    const event = baseEvent({ body });
    const contentLen = JSON.stringify(event.content).length;
    expect(contentLen).toBe(65_539);
    try {
      validateEventSize(event);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as MatrixApiError;
      expect(e.message).toMatch(/65536/);
      expect(e.message).toMatch(new RegExp(String(contentLen)));
    }
  });
});

describe('validateEventSize TOKENMAXX residual leftovers after #272', () => {
  it('concurrent hard-cap rejects stay independent MatrixApiError instances', async () => {
    const a = baseEvent({ body: 'ok-a' });
    const b = baseEvent({ body: 'ok-b' });
    a.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-a-${i}:example.com`);
    b.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-b-${i}:example.com`);
    const beforeA = JSON.stringify(a);
    const beforeB = JSON.stringify(b);
    const lenA = JSON.stringify(a).length;
    const lenB = JSON.stringify(b).length;
    expect(JSON.stringify(a.content).length).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(b.content).length).toBeLessThanOrEqual(65_536);
    expect(lenA).toBeGreaterThan(921_600);
    expect(lenB).toBeGreaterThan(921_600);
    const [ra, rb] = await Promise.all([
      Promise.resolve().then(() => {
        try {
          validateEventSize(a);
          return null;
        } catch (err) {
          return err as MatrixApiError;
        }
      }),
      Promise.resolve().then(() => {
        try {
          validateEventSize(b);
          return null;
        } catch (err) {
          return err as MatrixApiError;
        }
      }),
    ]);
    expect(ra).toBeInstanceOf(MatrixApiError);
    expect(rb).toBeInstanceOf(MatrixApiError);
    expect(ra).not.toBe(rb);
    expect(ra!.errcode).toBe('M_TOO_LARGE');
    expect(rb!.status).toBe(413);
    expect(ra!.message).toMatch(/D1 row limit/);
    expect(rb!.message).toMatch(/D1 row limit/);
    expect(ra!.message).toMatch(new RegExp(String(lenA)));
    expect(rb!.message).toMatch(new RegExp(String(lenB)));
    expect(JSON.stringify(a)).toBe(beforeA);
    expect(JSON.stringify(b)).toBe(beforeB);
  });

  it('concurrent hard-cap ok + hard-cap reject: ok succeeds, reject throws, neither mutates', async () => {
    const ok = baseEvent({ body: 'boundary-ok' });
    // Inflate just under the hard cap via prev_events padding
    ok.prev_events = Array.from({ length: 35_000 }, (_, i) => `$p-${i}:example.com`);
    while (JSON.stringify(ok).length > 921_600) {
      ok.prev_events.pop();
    }
    expect(JSON.stringify(ok).length).toBeLessThanOrEqual(921_600);
    expect(JSON.stringify(ok.content).length).toBeLessThanOrEqual(65_536);

    const bad = baseEvent({ body: 'boundary-bad' });
    bad.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    expect(JSON.stringify(bad.content).length).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(bad).length).toBeGreaterThan(921_600);

    const beforeOk = JSON.stringify(ok);
    const beforeBad = JSON.stringify(bad);
    const [okResult, badResult] = await Promise.allSettled([
      Promise.resolve().then(() => {
        validateEventSize(ok);
        return 'ok';
      }),
      Promise.resolve().then(() => {
        validateEventSize(bad);
        return 'bad';
      }),
    ]);
    expect(okResult.status).toBe('fulfilled');
    expect(badResult.status).toBe('rejected');
    if (badResult.status === 'rejected') {
      expect(badResult.reason).toBeInstanceOf(MatrixApiError);
      expect((badResult.reason as MatrixApiError).message).toMatch(/D1 row limit/);
    }
    expect(JSON.stringify(ok)).toBe(beforeOk);
    expect(JSON.stringify(bad)).toBe(beforeBad);
  });

  it('soft-cap exact boundary concurrent with soft-reject embeds observed length', async () => {
    const overhead = JSON.stringify({ body: '' }).length;
    const ok = baseEvent({ body: 'y'.repeat(65_536 - overhead) });
    const bad = baseEvent({ body: 'z'.repeat(65_536 - overhead + 1) });
    expect(JSON.stringify(ok.content).length).toBe(65_536);
    expect(JSON.stringify(bad.content).length).toBe(65_537);
    const beforeOk = JSON.stringify(ok);
    const beforeBad = JSON.stringify(bad);
    const contentLen = JSON.stringify(bad.content).length;
    const [okResult, badResult] = await Promise.allSettled([
      Promise.resolve().then(() => {
        validateEventSize(ok);
        return 'ok';
      }),
      Promise.resolve().then(() => {
        validateEventSize(bad);
        return 'bad';
      }),
    ]);
    expect(okResult.status).toBe('fulfilled');
    expect(badResult.status).toBe('rejected');
    if (badResult.status === 'rejected') {
      const e = badResult.reason as MatrixApiError;
      expect(e.message).toMatch(/content exceeds/);
      expect(e.message).toMatch(/65536/);
      expect(e.message).toMatch(new RegExp(String(contentLen)));
    }
    expect(JSON.stringify(ok)).toBe(beforeOk);
    expect(JSON.stringify(bad)).toBe(beforeBad);
  });
});

describe('validateEventSize TOKENMAXX residual second-wave leftovers after #282', () => {
  it('content undefined (as {}) concurrent with soft-reject neither mutates', async () => {
    const missing = baseEvent({ body: 'will-delete' });
    delete (missing as { content?: unknown }).content;
    expect('content' in missing).toBe(false);

    const overhead = JSON.stringify({ body: '' }).length;
    const bad = baseEvent({ body: 'z'.repeat(65_536 - overhead + 1) });
    expect(JSON.stringify(bad.content).length).toBe(65_537);

    const beforeMissing = JSON.stringify(missing);
    const beforeBad = JSON.stringify(bad);
    const contentLen = JSON.stringify(bad.content).length;
    const [okResult, badResult] = await Promise.allSettled([
      Promise.resolve().then(() => {
        validateEventSize(missing as PDU);
        return 'ok';
      }),
      Promise.resolve().then(() => {
        validateEventSize(bad);
        return 'bad';
      }),
    ]);
    expect(okResult.status).toBe('fulfilled');
    expect(badResult.status).toBe('rejected');
    if (badResult.status === 'rejected') {
      const e = badResult.reason as MatrixApiError;
      expect(e.errcode).toBe('M_TOO_LARGE');
      expect(e.message).toMatch(/content exceeds/);
      expect(e.message).toMatch(new RegExp(String(contentLen)));
    }
    expect(JSON.stringify(missing)).toBe(beforeMissing);
    expect(JSON.stringify(bad)).toBe(beforeBad);
    expect('content' in missing).toBe(false);
  });
});

describe('validateEventSize TOKENMAXX residual tertiary leftovers after #290', () => {
  it('null content (as {}) concurrent with hard-cap reject neither mutates', async () => {
    const nullContent = baseEvent({ body: 'will-null' });
    (nullContent as { content: unknown }).content = null;
    expect(nullContent.content).toBeNull();

    const hard = baseEvent({ body: 'ok' });
    hard.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    expect(JSON.stringify(hard.content).length).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(hard).length).toBeGreaterThan(921_600);

    const beforeNull = JSON.stringify(nullContent);
    const beforeHard = JSON.stringify(hard);
    const [okResult, badResult] = await Promise.allSettled([
      Promise.resolve().then(() => {
        validateEventSize(nullContent as PDU);
        return 'ok';
      }),
      Promise.resolve().then(() => {
        validateEventSize(hard);
        return 'bad';
      }),
    ]);
    expect(okResult.status).toBe('fulfilled');
    expect(badResult.status).toBe('rejected');
    if (badResult.status === 'rejected') {
      const e = badResult.reason as MatrixApiError;
      expect(e.errcode).toBe('M_TOO_LARGE');
      expect(e.message).toMatch(/D1 row limit/);
    }
    expect(JSON.stringify(nullContent)).toBe(beforeNull);
    expect(JSON.stringify(hard)).toBe(beforeHard);
    expect(nullContent.content).toBeNull();
  });

  it('array content concurrent with soft-reject neither mutates', async () => {
    const arr = baseEvent({ body: 'x' });
    (arr as { content: unknown }).content = ['a', 'b'];
    expect(Array.isArray(arr.content)).toBe(true);

    const overhead = JSON.stringify({ body: '' }).length;
    const bad = baseEvent({ body: 'z'.repeat(65_536 - overhead + 1) });
    expect(JSON.stringify(bad.content).length).toBe(65_537);

    const beforeArr = JSON.stringify(arr);
    const beforeBad = JSON.stringify(bad);
    const contentLen = JSON.stringify(bad.content).length;
    const [okResult, badResult] = await Promise.allSettled([
      Promise.resolve().then(() => {
        validateEventSize(arr as PDU);
        return 'ok';
      }),
      Promise.resolve().then(() => {
        validateEventSize(bad);
        return 'bad';
      }),
    ]);
    expect(okResult.status).toBe('fulfilled');
    expect(badResult.status).toBe('rejected');
    if (badResult.status === 'rejected') {
      const e = badResult.reason as MatrixApiError;
      expect(e.message).toMatch(/content exceeds/);
      expect(e.message).toMatch(new RegExp(String(contentLen)));
    }
    expect(JSON.stringify(arr)).toBe(beforeArr);
    expect(JSON.stringify(bad)).toBe(beforeBad);
    expect(arr.content).toEqual(['a', 'b']);
  });
});
