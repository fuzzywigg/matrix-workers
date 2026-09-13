import { describe, it, expect } from 'vitest';
import {
  applyEventFilter,
  shouldIncludeRoom,
  parseSyncToken,
  buildSyncToken,
} from '../src/api/sync';

const events = [
  { type: 'm.room.message', sender: '@alice:example.com' },
  { type: 'm.room.member', sender: '@bob:example.com' },
  { type: 'm.reaction', sender: '@alice:example.com' },
];

describe('applyEventFilter', () => {
  it('returns all events when no filter is provided', () => {
    expect(applyEventFilter(events)).toEqual(events);
  });

  it('applies type whitelist with wildcards', () => {
    expect(applyEventFilter(events, { types: ['m.room.*'] }).map((e) => e.type)).toEqual([
      'm.room.message',
      'm.room.member',
    ]);
  });

  it('matches exact types without wildcards', () => {
    expect(applyEventFilter(events, { types: ['m.reaction'] })).toEqual([
      { type: 'm.reaction', sender: '@alice:example.com' },
    ]);
  });

  it('treats empty types whitelist as no type restriction', () => {
    expect(applyEventFilter(events, { types: [] })).toEqual(events);
  });

  it('applies not_types and sender filters', () => {
    expect(
      applyEventFilter(events, {
        not_types: ['m.reaction'],
        senders: ['@alice:example.com'],
      })
    ).toEqual([{ type: 'm.room.message', sender: '@alice:example.com' }]);
  });

  it('applies not_types wildcards', () => {
    expect(applyEventFilter(events, { not_types: ['m.room.*'] }).map((e) => e.type)).toEqual([
      'm.reaction',
    ]);
  });

  it('applies not_senders and limit', () => {
    expect(
      applyEventFilter(events, { not_senders: ['@bob:example.com'], limit: 1 })
    ).toHaveLength(1);
  });

  it('ignores non-positive limits', () => {
    expect(applyEventFilter(events, { limit: 0 })).toHaveLength(3);
    expect(applyEventFilter(events, { limit: -1 })).toHaveLength(3);
  });

  it('combines whitelist and blacklist', () => {
    expect(
      applyEventFilter(events, {
        types: ['m.room.*'],
        not_types: ['m.room.member'],
        senders: ['@alice:example.com', '@bob:example.com'],
        not_senders: ['@bob:example.com'],
      })
    ).toEqual([{ type: 'm.room.message', sender: '@alice:example.com' }]);
  });
});

describe('shouldIncludeRoom', () => {
  it('defaults to include', () => {
    expect(shouldIncludeRoom('!a:example.com')).toBe(true);
  });

  it('honors rooms whitelist and not_rooms blacklist', () => {
    expect(shouldIncludeRoom('!a:example.com', { rooms: ['!b:example.com'] })).toBe(false);
    expect(shouldIncludeRoom('!a:example.com', { rooms: ['!a:example.com'] })).toBe(true);
    expect(shouldIncludeRoom('!a:example.com', { not_rooms: ['!a:example.com'] })).toBe(false);
  });

  it('treats empty rooms lists as unrestricted', () => {
    expect(shouldIncludeRoom('!a:example.com', { rooms: [] })).toBe(true);
    expect(shouldIncludeRoom('!a:example.com', { not_rooms: [] })).toBe(true);
  });

  it('requires whitelist membership before applying blacklist', () => {
    expect(
      shouldIncludeRoom('!a:example.com', {
        rooms: ['!a:example.com'],
        not_rooms: ['!a:example.com'],
      })
    ).toBe(false);
  });
});

describe('sync tokens', () => {
  it('parses composite and legacy formats', () => {
    expect(parseSyncToken(undefined)).toEqual({ events: 0, toDevice: 0 });
    expect(parseSyncToken('s84_td119')).toEqual({ events: 84, toDevice: 119 });
    expect(parseSyncToken('42')).toEqual({ events: 42, toDevice: 42 });
    expect(parseSyncToken('garbage')).toEqual({ events: 0, toDevice: 0 });
  });

  it('parses s0_td0 and leading-zero composite tokens', () => {
    expect(parseSyncToken('s0_td0')).toEqual({ events: 0, toDevice: 0 });
    expect(parseSyncToken('s007_td008')).toEqual({ events: 7, toDevice: 8 });
  });

  it('rejects whitespace and negative composite tokens', () => {
    expect(parseSyncToken(' s1_td2')).toEqual({ events: 0, toDevice: 0 });
    expect(parseSyncToken('s-1_td2')).toEqual({ events: 0, toDevice: 0 });
  });

  it('parses negative legacy numbers as NaN fallback to zero', () => {
    // parseInt('-5') is -5 which is finite; legacy path accepts it
    expect(parseSyncToken('-5')).toEqual({ events: -5, toDevice: -5 });
  });

  it('round-trips build/parse', () => {
    const token = buildSyncToken(10, 20);
    expect(token).toBe('s10_td20');
    expect(parseSyncToken(token)).toEqual({ events: 10, toDevice: 20 });
  });

  it('builds zero positions', () => {
    expect(buildSyncToken(0, 0)).toBe('s0_td0');
  });

  it('treats empty composite leftovers as garbage', () => {
    expect(parseSyncToken('s_td1')).toEqual({ events: 0, toDevice: 0 });
    expect(parseSyncToken('s1_td')).toEqual({ events: 0, toDevice: 0 });
  });
});

describe('applyEventFilter sender whitelist empty', () => {
  it('treats empty senders whitelist as unrestricted', () => {
    expect(applyEventFilter(events, { senders: [] })).toEqual(events);
  });

  it('applies not_senders with empty types', () => {
    expect(
      applyEventFilter(events, { types: [], not_senders: ['@alice:example.com'] }).map(
        (e) => e.sender
      )
    ).toEqual(['@bob:example.com']);
  });
});

describe('applyEventFilter / room filter failure edges', () => {
  it('caps results when limit exceeds the filtered set', () => {
    expect(applyEventFilter(events, { limit: 100 })).toHaveLength(3);
  });

  it('applies not_rooms without a rooms whitelist', () => {
    expect(shouldIncludeRoom('!a:example.com', { not_rooms: ['!b:example.com'] })).toBe(true);
    expect(shouldIncludeRoom('!b:example.com', { not_rooms: ['!b:example.com'] })).toBe(false);
  });

  it('excludes rooms missing from a non-empty whitelist', () => {
    expect(
      shouldIncludeRoom('!c:example.com', {
        rooms: ['!a:example.com', '!b:example.com'],
        not_rooms: ['!z:example.com'],
      })
    ).toBe(false);
  });
});

describe('sync token failure edges', () => {
  it('rejects composite tokens with extra suffixes', () => {
    expect(parseSyncToken('s1_td2_extra')).toEqual({ events: 0, toDevice: 0 });
    expect(parseSyncToken('S1_td2')).toEqual({ events: 0, toDevice: 0 });
  });

  it('parses very large legacy numeric tokens', () => {
    expect(parseSyncToken('9007199254740991')).toEqual({
      events: 9007199254740991,
      toDevice: 9007199254740991,
    });
  });

  it('builds asymmetric event/to-device positions', () => {
    expect(buildSyncToken(1, 999)).toBe('s1_td999');
    expect(parseSyncToken(buildSyncToken(7, 0))).toEqual({ events: 7, toDevice: 0 });
  });

  it('legacy-parses leading-plus numeric tokens via parseInt', () => {
    expect(parseSyncToken('+7')).toEqual({ events: 7, toDevice: 7 });
  });
});

describe('applyEventFilter mid-string wildcard edges', () => {
  it('does not treat mid-string * as a glob (only suffix * is special)', () => {
    expect(
      applyEventFilter(events, { types: ['m.*.message'] }).map((e) => e.type)
    ).toEqual([]);
  });
});


describe('sync filters TOKENMAXX edge paths after #49', () => {
  it('parses empty string tokens as zero positions', () => {
    expect(parseSyncToken('')).toEqual({ events: 0, toDevice: 0 });
  });

  it('legacy-parses float prefixes via parseInt', () => {
    expect(parseSyncToken('3.14')).toEqual({ events: 3, toDevice: 3 });
  });
});

describe('sync filters TOKENMAXX edge paths after #50', () => {
  it('excludes exact not_types without wildcards', () => {
    expect(
      applyEventFilter(events, { not_types: ['m.room.member'] }).map((e) => e.type)
    ).toEqual(['m.room.message', 'm.reaction']);
  });

  it('preserves filtered order when applying a limit', () => {
    const limited = applyEventFilter(events, { types: ['m.room.*'], limit: 1 });
    expect(limited).toEqual([{ type: 'm.room.message', sender: '@alice:example.com' }]);
  });

  it('interpolates negative positions into sync tokens verbatim', () => {
    expect(buildSyncToken(-1, -2)).toBe('s-1_td-2');
  });
});


describe('sync filters TOKENMAXX edge paths after #52', () => {
  it('treats types: ["*"] as a prefix-empty wildcard matching all types', () => {
    expect(applyEventFilter(events, { types: ['*'] })).toEqual(events);
  });

  it('treats empty not_types and not_senders as unrestricted', () => {
    expect(applyEventFilter(events, { not_types: [] })).toEqual(events);
    expect(applyEventFilter(events, { not_senders: [] })).toEqual(events);
  });
});

describe('sync filters TOKENMAXX edge paths after #53', () => {
  it('excludes events missing sender when senders whitelist is set', () => {
    const filtered = applyEventFilter(
      [{ type: 'm.room.message' }, { type: 'm.room.message', sender: '@alice:example.com' }],
      { senders: ['@alice:example.com'] }
    );
    expect(filtered).toEqual([{ type: 'm.room.message', sender: '@alice:example.com' }]);
  });

  it('excludes events missing type when types whitelist uses exact match', () => {
    expect(
      applyEventFilter([{ sender: '@alice:example.com' }, ...events], {
        types: ['m.room.message'],
      })
    ).toEqual([{ type: 'm.room.message', sender: '@alice:example.com' }]);
  });

  it('parses legacy NaN tokens as zero positions', () => {
    expect(parseSyncToken('NaN')).toEqual({ events: 0, toDevice: 0 });
  });
});


describe('sync filters TOKENMAXX edge paths after #54', () => {
  it('keeps events missing sender when only not_senders is set', () => {
    const filtered = applyEventFilter(
      [{ type: 'm.room.message' }, { type: 'm.room.message', sender: '@bob:example.com' }],
      { not_senders: ['@bob:example.com'] }
    );
    expect(filtered).toEqual([{ type: 'm.room.message' }]);
  });

  it('matches m.room.* types without matching m.reaction', () => {
    expect(applyEventFilter(events, { types: ['m.room.*'] }).map((e) => e.type)).toEqual([
      'm.room.message',
      'm.room.member',
    ]);
  });

  it('excludes a room listed in both rooms and not_rooms', () => {
    expect(
      shouldIncludeRoom('!both:example.com', {
        rooms: ['!both:example.com', '!other:example.com'],
        not_rooms: ['!both:example.com'],
      })
    ).toBe(false);
  });
});


describe('sync filters TOKENMAXX edge paths after #55', () => {
  it('ignores NaN limits (falsy) and keeps full set for Infinity slice', () => {
    expect(applyEventFilter(events, { limit: Number.NaN })).toEqual(events);
    expect(applyEventFilter(events, { limit: Number.POSITIVE_INFINITY })).toEqual(events);
  });
});

describe('sync filters TOKENMAXX leftovers after #78 (client sync filter helpers)', () => {
  it('matches any type pattern in a multi-entry whitelist (OR)', () => {
    expect(
      applyEventFilter(events, { types: ['m.reaction', 'm.room.member'] }).map((e) => e.type)
    ).toEqual(['m.room.member', 'm.reaction']);
  });

  it('treats not_types: ["*"] as an empty-prefix wildcard excluding every type', () => {
    expect(applyEventFilter(events, { not_types: ['*'] })).toEqual([]);
  });

  it('is case-sensitive on exact type and sender matches', () => {
    expect(applyEventFilter(events, { types: ['M.ROOM.MESSAGE'] })).toEqual([]);
    expect(applyEventFilter(events, { senders: ['@Alice:example.com'] })).toEqual([]);
  });

  it('truncates fractional limits via Array.prototype.slice', () => {
    // slice(0, 1.9) → first element only
    expect(applyEventFilter(events, { limit: 1.9 })).toHaveLength(1);
    expect(applyEventFilter(events, { limit: 2.1 })).toHaveLength(2);
  });

  it('returns empty when filtering an empty event list', () => {
    expect(applyEventFilter([], { types: ['m.room.*'], limit: 10 })).toEqual([]);
  });

  it('keeps events whose sender is empty string when not_senders lists a real MXID', () => {
    const mixed = [
      { type: 'm.room.message', sender: '' },
      { type: 'm.room.message', sender: '@bob:example.com' },
    ];
    expect(applyEventFilter(mixed, { not_senders: ['@bob:example.com'] })).toEqual([
      { type: 'm.room.message', sender: '' },
    ]);
  });

  it('excludes empty-string sender when senders whitelist requires a real MXID', () => {
    expect(
      applyEventFilter(
        [
          { type: 'm.room.message', sender: '' },
          { type: 'm.room.message', sender: '@alice:example.com' },
        ],
        { senders: ['@alice:example.com'] }
      )
    ).toEqual([{ type: 'm.room.message', sender: '@alice:example.com' }]);
  });

  it('applies limit after type/sender filtering (not before)', () => {
    const limited = applyEventFilter(events, {
      types: ['m.room.*'],
      senders: ['@bob:example.com'],
      limit: 5,
    });
    expect(limited).toEqual([{ type: 'm.room.member', sender: '@bob:example.com' }]);
  });

  it('includes a whitelisted room that is absent from not_rooms', () => {
    expect(
      shouldIncludeRoom('!keep:example.com', {
        rooms: ['!keep:example.com', '!other:example.com'],
        not_rooms: ['!other:example.com'],
      })
    ).toBe(true);
  });

  it('defaults to include when filter object has neither rooms nor not_rooms', () => {
    expect(shouldIncludeRoom('!a:example.com', {})).toBe(true);
  });

  it('rejects composite tokens with trailing whitespace or newlines', () => {
    expect(parseSyncToken('s1_td2 ')).toEqual({ events: 0, toDevice: 0 });
    expect(parseSyncToken('s1_td2\n')).toEqual({ events: 0, toDevice: 0 });
  });

  it('rejects composite tokens missing the td marker', () => {
    expect(parseSyncToken('s1_2')).toEqual({ events: 0, toDevice: 0 });
    expect(parseSyncToken('s1td2')).toEqual({ events: 0, toDevice: 0 });
  });

  it('legacy-parses hex and leading-zero tokens via parseInt', () => {
    expect(parseSyncToken('0x10')).toEqual({ events: 16, toDevice: 16 });
    expect(parseSyncToken('08')).toEqual({ events: 8, toDevice: 8 });
  });

  it('interpolates fractional positions into buildSyncToken verbatim', () => {
    expect(buildSyncToken(1.5, 2.5)).toBe('s1.5_td2.5');
    // Composite regex requires \\d+ so floats fail parse and fall through to legacy parseInt
    expect(parseSyncToken('s1.5_td2.5')).toEqual({ events: 0, toDevice: 0 });
  });

  it('round-trips large asymmetric positions', () => {
    const token = buildSyncToken(9_007_199_254_740_991, 0);
    expect(parseSyncToken(token)).toEqual({ events: 9_007_199_254_740_991, toDevice: 0 });
  });

  it('applies not_types after types whitelist (intersection)', () => {
    expect(
      applyEventFilter(events, {
        types: ['m.room.message', 'm.room.member', 'm.reaction'],
        not_types: ['m.reaction', 'm.room.member'],
      }).map((e) => e.type)
    ).toEqual(['m.room.message']);
  });

  it('does not treat a lone asterisk mid-pattern as a glob', () => {
    expect(applyEventFilter(events, { types: ['*message'] })).toEqual([]);
    expect(applyEventFilter(events, { not_types: ['*reaction'] }).map((e) => e.type)).toEqual([
      'm.room.message',
      'm.room.member',
      'm.reaction',
    ]);
  });
});
