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

describe('validateEventSize TOKENMAXX residual quaternary leftovers after #310', () => {
  it('soft-cap exact boundary ok ∥ one-over reject under race with exact messages', async () => {
    const overhead = JSON.stringify({ body: '' }).length;
    const at = baseEvent({ body: 'y'.repeat(65_536 - overhead) });
    const over = baseEvent({ body: 'z'.repeat(65_536 - overhead + 1) });
    expect(JSON.stringify(at.content).length).toBe(65_536);
    expect(JSON.stringify(over.content).length).toBe(65_537);
    const beforeAt = JSON.stringify(at);
    const beforeOver = JSON.stringify(over);
    const [okResult, badResult] = await Promise.allSettled([
      Promise.resolve().then(() => {
        validateEventSize(at);
        return 'ok';
      }),
      Promise.resolve().then(() => {
        validateEventSize(over);
        return 'bad';
      }),
    ]);
    expect(okResult.status).toBe('fulfilled');
    expect(badResult.status).toBe('rejected');
    if (badResult.status === 'rejected') {
      const e = badResult.reason as MatrixApiError;
      expect(e.errcode).toBe('M_TOO_LARGE');
      expect(e.status).toBe(413);
      expect(e.message).toBe(
        'Event content exceeds 65536 byte limit (got 65537)'
      );
    }
    expect(JSON.stringify(at)).toBe(beforeAt);
    expect(JSON.stringify(over)).toBe(beforeOver);
  });

  it('string primitive content ok ∥ soft-reject neither mutates under race', async () => {
    const str = baseEvent({ body: 'x' });
    (str as { content: unknown }).content = 'plain-string';
    const overhead = JSON.stringify({ body: '' }).length;
    const bad = baseEvent({ body: 'z'.repeat(65_536 - overhead + 1) });
    const beforeStr = JSON.stringify(str);
    const beforeBad = JSON.stringify(bad);
    const [okResult, badResult] = await Promise.allSettled([
      Promise.resolve().then(() => {
        validateEventSize(str as PDU);
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
      expect((badResult.reason as MatrixApiError).message).toMatch(/content exceeds/);
    }
    expect(JSON.stringify(str)).toBe(beforeStr);
    expect(JSON.stringify(bad)).toBe(beforeBad);
    expect(str.content).toBe('plain-string');
  });

  it('soft-reject ∥ hard-reject exact messages stay isolated under race', async () => {
    const overhead = JSON.stringify({ body: '' }).length;
    const soft = baseEvent({ body: 'z'.repeat(65_536 - overhead + 1) });
    const hard = baseEvent({ body: 'ok' });
    hard.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    expect(JSON.stringify(soft.content).length).toBe(65_537);
    expect(JSON.stringify(hard.content).length).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(hard).length).toBeGreaterThan(921_600);
    const hardLen = JSON.stringify(hard).length;
    const [softResult, hardResult] = await Promise.allSettled([
      Promise.resolve().then(() => validateEventSize(soft)),
      Promise.resolve().then(() => validateEventSize(hard)),
    ]);
    expect(softResult.status).toBe('rejected');
    expect(hardResult.status).toBe('rejected');
    if (softResult.status === 'rejected') {
      expect((softResult.reason as MatrixApiError).message).toBe(
        'Event content exceeds 65536 byte limit (got 65537)'
      );
    }
    if (hardResult.status === 'rejected') {
      expect((hardResult.reason as MatrixApiError).message).toBe(
        `Serialized event exceeds 921600 byte D1 row limit (got ${hardLen})`
      );
    }
  });
});

describe('validateEventSize TOKENMAXX residual quinary leftovers after #319', () => {
  it('boolean/number primitive content ok ∥ soft-reject neither mutates under race', async () => {
    const boolEvt = baseEvent({ body: 'x' });
    (boolEvt as { content: unknown }).content = true;
    const numEvt = baseEvent({ body: 'x' });
    (numEvt as { content: unknown }).content = 0;
    const overhead = JSON.stringify({ body: '' }).length;
    const bad = baseEvent({ body: 'z'.repeat(65_536 - overhead + 1) });
    const beforeBool = JSON.stringify(boolEvt);
    const beforeNum = JSON.stringify(numEvt);
    const beforeBad = JSON.stringify(bad);
    const [okBool, okNum, badResult] = await Promise.allSettled([
      Promise.resolve().then(() => {
        validateEventSize(boolEvt as PDU);
        return 'ok-bool';
      }),
      Promise.resolve().then(() => {
        validateEventSize(numEvt as PDU);
        return 'ok-num';
      }),
      Promise.resolve().then(() => {
        validateEventSize(bad);
        return 'bad';
      }),
    ]);
    expect(okBool.status).toBe('fulfilled');
    expect(okNum.status).toBe('fulfilled');
    expect(badResult.status).toBe('rejected');
    if (badResult.status === 'rejected') {
      expect((badResult.reason as MatrixApiError).message).toBe(
        'Event content exceeds 65536 byte limit (got 65537)'
      );
    }
    expect(JSON.stringify(boolEvt)).toBe(beforeBool);
    expect(JSON.stringify(numEvt)).toBe(beforeNum);
    expect(JSON.stringify(bad)).toBe(beforeBad);
    expect(boolEvt.content).toBe(true);
    expect(numEvt.content).toBe(0);
  });

  it('empty {} content ok ∥ hard-reject exact message under race', async () => {
    const empty = baseEvent({});
    const hard = baseEvent({ body: 'ok' });
    hard.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    const hardLen = JSON.stringify(hard).length;
    expect(JSON.stringify(empty.content).length).toBe(2);
    expect(hardLen).toBeGreaterThan(921_600);
    const beforeEmpty = JSON.stringify(empty);
    const beforeHard = JSON.stringify(hard);
    const [okResult, badResult] = await Promise.allSettled([
      Promise.resolve().then(() => {
        validateEventSize(empty);
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
      expect((badResult.reason as MatrixApiError).message).toBe(
        `Serialized event exceeds 921600 byte D1 row limit (got ${hardLen})`
      );
    }
    expect(JSON.stringify(empty)).toBe(beforeEmpty);
    expect(JSON.stringify(hard)).toBe(beforeHard);
  });

  it('nested soft-over exact message ∥ soft exact-boundary ok under race', async () => {
    const nested = baseEvent({ nested: { blob: 'n'.repeat(65_536) } });
    const nestedLen = JSON.stringify(nested.content).length;
    expect(nestedLen).toBeGreaterThan(65_536);
    const overhead = JSON.stringify({ body: '' }).length;
    const at = baseEvent({ body: 'y'.repeat(65_536 - overhead) });
    expect(JSON.stringify(at.content).length).toBe(65_536);
    const beforeNested = JSON.stringify(nested);
    const beforeAt = JSON.stringify(at);
    const [badResult, okResult] = await Promise.allSettled([
      Promise.resolve().then(() => validateEventSize(nested)),
      Promise.resolve().then(() => {
        validateEventSize(at);
        return 'ok';
      }),
    ]);
    expect(okResult.status).toBe('fulfilled');
    expect(badResult.status).toBe('rejected');
    if (badResult.status === 'rejected') {
      expect((badResult.reason as MatrixApiError).message).toBe(
        `Event content exceeds 65536 byte limit (got ${nestedLen})`
      );
    }
    expect(JSON.stringify(nested)).toBe(beforeNested);
    expect(JSON.stringify(at)).toBe(beforeAt);
  });
});

describe('validateEventSize TOKENMAXX residual senary leftovers after #330', () => {
  it('missing content ∥ soft-over ∥ hard-over triple race pins errcode/status', async () => {
    const missing = baseEvent({ body: 'x' });
    delete (missing as { content?: unknown }).content;
    const overhead = JSON.stringify({ body: '' }).length;
    const soft = baseEvent({ body: 'z'.repeat(65_536 - overhead + 1) });
    const hard = baseEvent({ body: 'ok' });
    hard.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    const softLen = JSON.stringify(soft.content).length;
    const hardLen = JSON.stringify(hard).length;
    expect(softLen).toBe(65_537);
    expect(hardLen).toBeGreaterThan(921_600);
    const beforeMissing = JSON.stringify(missing);
    const beforeSoft = JSON.stringify(soft);
    const beforeHard = JSON.stringify(hard);
    const [okResult, softResult, hardResult] = await Promise.allSettled([
      Promise.resolve().then(() => {
        validateEventSize(missing as PDU);
        return 'ok';
      }),
      Promise.resolve().then(() => validateEventSize(soft)),
      Promise.resolve().then(() => validateEventSize(hard)),
    ]);
    expect(okResult.status).toBe('fulfilled');
    expect(softResult.status).toBe('rejected');
    expect(hardResult.status).toBe('rejected');
    if (softResult.status === 'rejected') {
      const e = softResult.reason as MatrixApiError;
      expect(e.errcode).toBe('M_TOO_LARGE');
      expect(e.status).toBe(413);
      expect(e.message).toBe(`Event content exceeds 65536 byte limit (got ${softLen})`);
    }
    if (hardResult.status === 'rejected') {
      const e = hardResult.reason as MatrixApiError;
      expect(e.errcode).toBe('M_TOO_LARGE');
      expect(e.status).toBe(413);
      expect(e.message).toBe(
        `Serialized event exceeds 921600 byte D1 row limit (got ${hardLen})`
      );
    }
    expect(JSON.stringify(missing)).toBe(beforeMissing);
    expect(JSON.stringify(soft)).toBe(beforeSoft);
    expect(JSON.stringify(hard)).toBe(beforeHard);
  });

  it('soft exact-boundary ok ∥ soft one-over ∥ hard reject under race', async () => {
    const overhead = JSON.stringify({ body: '' }).length;
    const at = baseEvent({ body: 'y'.repeat(65_536 - overhead) });
    const over = baseEvent({ body: 'z'.repeat(65_536 - overhead + 1) });
    const hard = baseEvent({ body: 'ok' });
    hard.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    expect(JSON.stringify(at.content).length).toBe(65_536);
    expect(JSON.stringify(over.content).length).toBe(65_537);
    const hardLen = JSON.stringify(hard).length;
    const beforeAt = JSON.stringify(at);
    const beforeOver = JSON.stringify(over);
    const beforeHard = JSON.stringify(hard);
    const [okResult, softResult, hardResult] = await Promise.allSettled([
      Promise.resolve().then(() => {
        validateEventSize(at);
        return 'ok';
      }),
      Promise.resolve().then(() => validateEventSize(over)),
      Promise.resolve().then(() => validateEventSize(hard)),
    ]);
    expect(okResult.status).toBe('fulfilled');
    expect(softResult.status).toBe('rejected');
    expect(hardResult.status).toBe('rejected');
    if (softResult.status === 'rejected') {
      expect((softResult.reason as MatrixApiError).message).toBe(
        'Event content exceeds 65536 byte limit (got 65537)'
      );
    }
    if (hardResult.status === 'rejected') {
      expect((hardResult.reason as MatrixApiError).message).toBe(
        `Serialized event exceeds 921600 byte D1 row limit (got ${hardLen})`
      );
    }
    expect(JSON.stringify(at)).toBe(beforeAt);
    expect(JSON.stringify(over)).toBe(beforeOver);
    expect(JSON.stringify(hard)).toBe(beforeHard);
  });

  it('string content ok ∥ soft-over exact message neither mutates under race', async () => {
    const strEvt = baseEvent({ body: 'x' });
    (strEvt as { content: unknown }).content = 'plain-string-senary';
    const overhead = JSON.stringify({ body: '' }).length;
    const bad = baseEvent({ body: 'q'.repeat(65_536 - overhead + 1) });
    const beforeStr = JSON.stringify(strEvt);
    const beforeBad = JSON.stringify(bad);
    const [okResult, badResult] = await Promise.allSettled([
      Promise.resolve().then(() => {
        validateEventSize(strEvt as PDU);
        return 'ok';
      }),
      Promise.resolve().then(() => validateEventSize(bad)),
    ]);
    expect(okResult.status).toBe('fulfilled');
    expect(badResult.status).toBe('rejected');
    if (badResult.status === 'rejected') {
      expect((badResult.reason as MatrixApiError).errcode).toBe('M_TOO_LARGE');
      expect((badResult.reason as MatrixApiError).status).toBe(413);
      expect((badResult.reason as MatrixApiError).message).toBe(
        'Event content exceeds 65536 byte limit (got 65537)'
      );
    }
    expect(JSON.stringify(strEvt)).toBe(beforeStr);
    expect(JSON.stringify(bad)).toBe(beforeBad);
    expect(strEvt.content).toBe('plain-string-senary');
  });
});
