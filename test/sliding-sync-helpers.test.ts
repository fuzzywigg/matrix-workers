import { describe, it, expect } from 'vitest';
import {
  detectNSERequest,
  isDmRoom,
  matchesSlidingRoomFilters,
  resolveListRange,
} from '../src/api/sliding-sync';

describe('isDmRoom', () => {
  it('treats ≤2 members without a name as a DM', () => {
    expect(isDmRoom(1, null)).toBe(true);
    expect(isDmRoom(2, undefined)).toBe(true);
    expect(isDmRoom(2, '')).toBe(true);
  });

  it('rejects named rooms and larger rooms', () => {
    expect(isDmRoom(2, 'Alice & Bob')).toBe(false);
    expect(isDmRoom(3, null)).toBe(false);
    expect(isDmRoom(10, 'General')).toBe(false);
  });
});

describe('matchesSlidingRoomFilters', () => {
  it('passes when no filters are provided', () => {
    expect(matchesSlidingRoomFilters('Room', false)).toBe(true);
    expect(matchesSlidingRoomFilters(null, true, {})).toBe(true);
  });

  it('filters by room_name_like case-insensitively when a name exists', () => {
    expect(matchesSlidingRoomFilters('Matrix HQ', false, { room_name_like: 'hq' })).toBe(true);
    expect(matchesSlidingRoomFilters('Matrix HQ', false, { room_name_like: 'zzz' })).toBe(false);
  });

  it('skips room_name_like when the room has no name', () => {
    expect(matchesSlidingRoomFilters(null, true, { room_name_like: 'zzz' })).toBe(true);
  });

  it('filters by is_dm', () => {
    expect(matchesSlidingRoomFilters(null, true, { is_dm: true })).toBe(true);
    expect(matchesSlidingRoomFilters('Named', false, { is_dm: true })).toBe(false);
    expect(matchesSlidingRoomFilters('Named', false, { is_dm: false })).toBe(true);
    expect(matchesSlidingRoomFilters(null, true, { is_dm: false })).toBe(false);
  });

  it('requires both name and is_dm filters when both are set', () => {
    expect(
      matchesSlidingRoomFilters('Matrix HQ', true, { room_name_like: 'hq', is_dm: true })
    ).toBe(true);
    expect(
      matchesSlidingRoomFilters('Matrix HQ', false, { room_name_like: 'hq', is_dm: true })
    ).toBe(false);
    expect(
      matchesSlidingRoomFilters('Matrix HQ', true, { room_name_like: 'zzz', is_dm: true })
    ).toBe(false);
  });
});

describe('resolveListRange', () => {
  it('defaults to the full list when no range is set', () => {
    expect(resolveListRange({}, 5)).toEqual({ startIndex: 0, endIndex: 4 });
    expect(resolveListRange({}, 0)).toEqual({ startIndex: 0, endIndex: -1 });
  });

  it('prefers MSC3575 ranges when preferRangesFirst is true', () => {
    expect(resolveListRange({ ranges: [[1, 10]], range: [0, 1] }, 4, true)).toEqual({
      startIndex: 1,
      endIndex: 3,
    });
  });

  it('uses MSC4186 range when ranges are absent', () => {
    expect(resolveListRange({ range: [2, 50] }, 10, true)).toEqual({
      startIndex: 2,
      endIndex: 9,
    });
  });

  it('prefers MSC4186 range when preferRangesFirst is false', () => {
    expect(resolveListRange({ ranges: [[0, 1]], range: [2, 3] }, 10, false)).toEqual({
      startIndex: 2,
      endIndex: 3,
    });
  });

  it('falls back to ranges when preferRangesFirst is false and range is missing', () => {
    expect(resolveListRange({ ranges: [[0, 2]] }, 5, false)).toEqual({
      startIndex: 0,
      endIndex: 2,
    });
  });

  it('clamps endIndex to roomCount - 1 when the requested end overshoots', () => {
    expect(resolveListRange({ range: [0, 999] }, 3)).toEqual({
      startIndex: 0,
      endIndex: 2,
    });
  });

  it('uses the first MSC3575 range only', () => {
    expect(resolveListRange({ ranges: [[5, 7], [0, 1]] }, 20, true)).toEqual({
      startIndex: 5,
      endIndex: 7,
    });
  });
});

describe('detectNSERequest', () => {
  it('flags NSE User-Agent patterns', () => {
    const result = detectNSERequest('ElementX/NSE', {
      lists: { all: { range: [0, 10] } },
      extensions: {
        typing: { enabled: true },
        presence: { enabled: true },
        to_device: { enabled: true },
      },
    });
    expect(result.indicators).toContain('user-agent-nse');
    expect(result.isLikelyNSE).toBe(false);
  });

  it('flags NotificationService User-Agent', () => {
    expect(
      detectNSERequest('NotificationService/1.0', {}).indicators
    ).toContain('user-agent-nse');
  });

  it('flags non-Element iOS User-Agents', () => {
    expect(detectNSERequest('SomeApp iOS/1.0', {}).indicators).toContain(
      'user-agent-different-ios'
    );
    expect(detectNSERequest('Element X iOS/1.0', {}).indicators).not.toContain(
      'user-agent-different-ios'
    );
  });

  it('flags single-room subscription without lists', () => {
    const result = detectNSERequest(undefined, {
      room_subscriptions: { '!a:example.com': { timeline_limit: 10 } },
    });
    expect(result.indicators).toContain('single-room-subscription');
  });

  it('does not flag single-room when lists are also present', () => {
    const result = detectNSERequest(undefined, {
      room_subscriptions: { '!a:example.com': {} },
      lists: { all: { range: [0, 10] } },
    });
    expect(result.indicators).not.toContain('single-room-subscription');
  });

  it('flags no-extensions and minimal-extensions', () => {
    expect(detectNSERequest(undefined, {}).indicators).toContain('no-extensions');
    expect(
      detectNSERequest(undefined, { extensions: { to_device: { enabled: true } } }).indicators
    ).toContain('minimal-extensions');
    expect(
      detectNSERequest(undefined, {
        extensions: { typing: { enabled: true }, presence: { enabled: true } },
      }).indicators
    ).not.toContain('minimal-extensions');
  });

  it('flags small timeline limits', () => {
    const result = detectNSERequest(undefined, {
      room_subscriptions: {
        '!a:example.com': { timeline_limit: 3 },
        '!b:example.com': { timeline_limit: 5 },
      },
    });
    expect(result.indicators).toContain('small-timeline-limit');
  });

  it('marks isLikelyNSE when two or more indicators fire', () => {
    const result = detectNSERequest('NSE/1.0', {
      room_subscriptions: { '!a:example.com': { timeline_limit: 2 } },
    });
    expect(result.indicators.length).toBeGreaterThanOrEqual(2);
    expect(result.isLikelyNSE).toBe(true);
  });

  it('does not flag small-timeline-limit when any subscription exceeds 5', () => {
    const result = detectNSERequest(undefined, {
      room_subscriptions: {
        '!a:example.com': { timeline_limit: 3 },
        '!b:example.com': { timeline_limit: 20 },
      },
    });
    expect(result.indicators).not.toContain('small-timeline-limit');
  });

  it('returns empty indicators for a normal Element X request', () => {
    const result = detectNSERequest('Element X iOS/25.1', {
      lists: { all: { range: [0, 20] } },
      room_subscriptions: {
        '!a:example.com': { timeline_limit: 20 },
      },
      extensions: {
        typing: { enabled: true },
        presence: { enabled: true },
        to_device: { enabled: true },
      },
    });
    expect(result.indicators).toEqual([]);
    expect(result.isLikelyNSE).toBe(false);
  });
});

describe('isDmRoom / filter / range failure edges', () => {
  it('treats zero and negative member counts without a name as DMs', () => {
    expect(isDmRoom(0, null)).toBe(true);
    expect(isDmRoom(-1, '')).toBe(true);
  });

  it('skips room_name_like for empty-string names (falsy)', () => {
    expect(matchesSlidingRoomFilters('', false, { room_name_like: 'hq' })).toBe(true);
  });

  it('falls through empty ranges arrays to MSC4186 range when preferRangesFirst', () => {
    expect(resolveListRange({ ranges: [], range: [1, 2] }, 10, true)).toEqual({
      startIndex: 1,
      endIndex: 2,
    });
  });

  it('does not clamp startIndex when the requested window is past the end', () => {
    // Existing behavior: startIndex is not clamped; callers may get empty slices
    expect(resolveListRange({ range: [10, 20] }, 5)).toEqual({
      startIndex: 10,
      endIndex: 4,
    });
  });
});

describe('detectNSERequest timeline and extension edges', () => {
  it('does not flag small-timeline-limit when timeline_limit is omitted (defaults to 10)', () => {
    const result = detectNSERequest(undefined, {
      room_subscriptions: { '!a:example.com': {} },
    });
    expect(result.indicators).not.toContain('small-timeline-limit');
    expect(result.indicators).toContain('single-room-subscription');
  });

  it('treats timeline_limit 0 as falsy (defaults to 10) but flags explicit 1', () => {
    expect(
      detectNSERequest(undefined, {
        room_subscriptions: { '!a:example.com': { timeline_limit: 0 } },
      }).indicators
    ).not.toContain('small-timeline-limit');
    expect(
      detectNSERequest(undefined, {
        room_subscriptions: { '!a:example.com': { timeline_limit: 1 } },
      }).indicators
    ).toContain('small-timeline-limit');
  });

  it('does not treat empty room_subscriptions as single-room', () => {
    const result = detectNSERequest(undefined, { room_subscriptions: {} });
    expect(result.indicators).not.toContain('single-room-subscription');
  });

  it('does not flag minimal-extensions when typing is present alone', () => {
    expect(
      detectNSERequest(undefined, { extensions: { typing: { enabled: true } } }).indicators
    ).not.toContain('minimal-extensions');
  });

  it('matches NSE User-Agent substrings case-sensitively', () => {
    expect(detectNSERequest('nse/1.0', {}).indicators).not.toContain('user-agent-nse');
    expect(detectNSERequest('NSE/1.0', {}).indicators).toContain('user-agent-nse');
  });
});


describe('sliding-sync TOKENMAXX edge paths after #49', () => {
  it('treats empty room_name_like as unset (falsy guard)', () => {
    // filters?.room_name_like && name — '' is falsy, so the includes check is skipped
    expect(matchesSlidingRoomFilters('Matrix HQ', false, { room_name_like: '' })).toBe(true);
  });

  it('falls through empty ranges to the full list when preferRangesFirst is false', () => {
    expect(resolveListRange({ ranges: [] }, 5, false)).toEqual({
      startIndex: 0,
      endIndex: 4,
    });
  });

  it('does not clamp negative range starts (documents current behavior)', () => {
    expect(resolveListRange({ range: [-1, 2] }, 5)).toEqual({
      startIndex: -1,
      endIndex: 2,
    });
  });

  it('does not flag single-room-subscription when two rooms are subscribed', () => {
    const result = detectNSERequest(undefined, {
      room_subscriptions: {
        '!a:example.com': { timeline_limit: 10 },
        '!b:example.com': { timeline_limit: 10 },
      },
    });
    expect(result.indicators).not.toContain('single-room-subscription');
  });
});

describe('sliding-sync TOKENMAXX edge paths after #50', () => {
  it('flags single-room-subscription when lists is an empty object', () => {
    const result = detectNSERequest(undefined, {
      lists: {},
      room_subscriptions: { '!a:example.com': { timeline_limit: 10 } },
    });
    expect(result.indicators).toContain('single-room-subscription');
  });

  it('rejects named one-member rooms as DMs', () => {
    expect(isDmRoom(1, 'Named')).toBe(false);
  });

  it('treats undefined filters like an empty filter object', () => {
    expect(matchesSlidingRoomFilters('Room', false, undefined)).toBe(true);
  });

  it('falls through empty ranges to the full list when preferRangesFirst is true', () => {
    expect(resolveListRange({ ranges: [] }, 5, true)).toEqual({
      startIndex: 0,
      endIndex: 4,
    });
  });

  it('marks NotificationService + single-room as likely NSE', () => {
    const result = detectNSERequest('NotificationService/1.0', {
      room_subscriptions: { '!a:example.com': { timeline_limit: 10 } },
    });
    expect(result.indicators).toContain('user-agent-nse');
    expect(result.indicators).toContain('single-room-subscription');
    expect(result.isLikelyNSE).toBe(true);
  });
});

describe('sliding-sync TOKENMAXX edge paths after #52', () => {
  it('does not swap inverted ranges (endIndex may be less than startIndex)', () => {
    expect(resolveListRange({ range: [5, 1] }, 10)).toEqual({
      startIndex: 5,
      endIndex: 1,
    });
  });

  it('honors is_dm: undefined as unset even when the property is present', () => {
    expect(
      matchesSlidingRoomFilters('Room', false, { is_dm: undefined })
    ).toBe(true);
    expect(
      matchesSlidingRoomFilters('Room', true, { is_dm: undefined })
    ).toBe(true);
  });

  it('treats room_name_like as includes() not RegExp (metachars are literal)', () => {
    expect(
      matchesSlidingRoomFilters('Room (hq)', false, { room_name_like: '(hq)' })
    ).toBe(true);
    expect(
      matchesSlidingRoomFilters('Room hq', false, { room_name_like: 'h.q' })
    ).toBe(false);
  });
});

describe('detectNSERequest TOKENMAXX edge paths after #53', () => {
  it('does not mark isLikelyNSE for a single indicator', () => {
    const single = detectNSERequest(undefined, {
      extensions: { to_device: { enabled: true }, account_data: { enabled: true } },
    });
    expect(single.indicators).toEqual(['minimal-extensions']);
    expect(single.isLikelyNSE).toBe(false);
  });

  it('does not flag presence-only extensions as minimal-extensions', () => {
    expect(
      detectNSERequest(undefined, { extensions: { presence: { enabled: true } } }).indicators
    ).not.toContain('minimal-extensions');
  });

  it('flags two non-typing/non-presence extensions as minimal-extensions', () => {
    expect(
      detectNSERequest(undefined, {
        extensions: { to_device: { enabled: true }, account_data: { enabled: true } },
      }).indicators
    ).toContain('minimal-extensions');
  });
});


describe('sliding-sync TOKENMAXX edge paths after #54', () => {
  it('does not mark isLikelyNSE for a lone no-extensions indicator', () => {
    // Empty/omitted extensions always adds no-extensions; a single indicator is not NSE.
    const result = detectNSERequest(undefined, {
      lists: {},
      room_subscriptions: {},
      extensions: { typing: { enabled: true }, presence: { enabled: true }, to_device: { enabled: true } },
    });
    expect(result.indicators).not.toContain('no-extensions');
    expect(result.indicators).not.toContain('minimal-extensions');
    expect(result.isLikelyNSE).toBe(false);

    const bare = detectNSERequest(undefined, {});
    expect(bare.indicators).toEqual(['no-extensions']);
    expect(bare.isLikelyNSE).toBe(false);
  });

  it('does not treat Element X iOS alone as user-agent-different-ios', () => {
    // Gate: iOS without "Element X iOS" → user-agent-different-ios; Element X iOS exempt.
    const mainApp = detectNSERequest('Element X iOS/1.0', {});
    expect(mainApp.indicators).not.toContain('user-agent-different-ios');

    const otherIos = detectNSERequest('SomeOther iOS/1.0', {});
    expect(otherIos.indicators).toContain('user-agent-different-ios');
  });

  it('clamps range endIndex when roomCount is 0 even if range requests a window', () => {
    expect(resolveListRange({ range: [0, 10] }, 0)).toEqual({ startIndex: 0, endIndex: -1 });
  });

  it('requires both is_dm and room_name_like when both are set (AND)', () => {
    expect(
      matchesSlidingRoomFilters('Matrix HQ', true, {
        is_dm: true,
        room_name_like: 'hq',
      })
    ).toBe(true);
    expect(
      matchesSlidingRoomFilters('Matrix HQ', false, {
        is_dm: true,
        room_name_like: 'hq',
      })
    ).toBe(false);
  });
});
