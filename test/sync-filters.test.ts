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

  it('applies not_types and sender filters', () => {
    expect(
      applyEventFilter(events, {
        not_types: ['m.reaction'],
        senders: ['@alice:example.com'],
      })
    ).toEqual([{ type: 'm.room.message', sender: '@alice:example.com' }]);
  });

  it('applies not_senders and limit', () => {
    expect(
      applyEventFilter(events, { not_senders: ['@bob:example.com'], limit: 1 })
    ).toHaveLength(1);
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
});

describe('sync tokens', () => {
  it('parses composite and legacy formats', () => {
    expect(parseSyncToken(undefined)).toEqual({ events: 0, toDevice: 0 });
    expect(parseSyncToken('s84_td119')).toEqual({ events: 84, toDevice: 119 });
    expect(parseSyncToken('42')).toEqual({ events: 42, toDevice: 42 });
    expect(parseSyncToken('garbage')).toEqual({ events: 0, toDevice: 0 });
  });

  it('round-trips build/parse', () => {
    const token = buildSyncToken(10, 20);
    expect(token).toBe('s10_td20');
    expect(parseSyncToken(token)).toEqual({ events: 10, toDevice: 20 });
  });
});
