import { describe, it, expect } from 'vitest';
import {
  matchesRule,
  matchesCondition,
  getNestedValue,
  type PushRule,
} from '../src/api/push';

const userId = '@alice:example.com';
const message = {
  type: 'm.room.message',
  sender: '@bob:example.com',
  content: { body: 'Hello Alice there', msgtype: 'm.text' },
};

describe('getNestedValue', () => {
  it('reads nested paths and returns undefined for missing keys', () => {
    expect(getNestedValue(message, 'content.body')).toBe('Hello Alice there');
    expect(getNestedValue(message, 'content.missing')).toBeUndefined();
  });
});

describe('matchesCondition', () => {
  it('matches event_match with globs; empty pattern is rejected by the guard', () => {
    expect(
      matchesCondition(
        { kind: 'event_match', key: 'content.body', pattern: 'Hello*' },
        message,
        userId,
        2
      )
    ).toBe(true);
    // `!condition.pattern` treats '' as missing, so the user_id placeholder is unreachable
    expect(
      matchesCondition(
        { kind: 'event_match', key: 'sender', pattern: '' },
        { ...message, sender: userId },
        userId,
        2
      )
    ).toBe(false);
    expect(
      matchesCondition(
        { kind: 'event_match', key: 'sender', pattern: userId },
        { ...message, sender: userId },
        userId,
        2
      )
    ).toBe(true);
  });

  it('evaluates room_member_count operators', () => {
    expect(matchesCondition({ kind: 'room_member_count', is: '==2' }, message, userId, 2)).toBe(
      true
    );
    expect(matchesCondition({ kind: 'room_member_count', is: '<3' }, message, userId, 2)).toBe(
      true
    );
    expect(matchesCondition({ kind: 'room_member_count', is: '>5' }, message, userId, 2)).toBe(
      false
    );
  });

  it('matches display name mentions', () => {
    expect(
      matchesCondition({ kind: 'contains_display_name' }, message, userId, 2, 'alice')
    ).toBe(true);
    expect(
      matchesCondition({ kind: 'contains_display_name' }, message, userId, 2, 'carol')
    ).toBe(false);
  });

  it('supports event_property_is and event_property_contains', () => {
    const withList = {
      ...message,
      content: { ...message.content, mentions: [userId, '@other:example.com'] },
    };
    expect(
      matchesCondition(
        { kind: 'event_property_is', key: 'content.msgtype', value: 'm.text' },
        withList,
        userId,
        2
      )
    ).toBe(true);
    expect(
      matchesCondition(
        {
          kind: 'event_property_contains',
          key: 'content.mentions',
          value: userId,
        },
        withList,
        userId,
        2
      )
    ).toBe(true);
  });

  it('evaluates <= and >= room_member_count operators', () => {
    expect(matchesCondition({ kind: 'room_member_count', is: '<=2' }, message, userId, 2)).toBe(
      true
    );
    expect(matchesCondition({ kind: 'room_member_count', is: '>=2' }, message, userId, 2)).toBe(
      true
    );
    expect(matchesCondition({ kind: 'room_member_count', is: '<=1' }, message, userId, 2)).toBe(
      false
    );
    expect(matchesCondition({ kind: 'room_member_count', is: '>=3' }, message, userId, 2)).toBe(
      false
    );
  });

  it('rejects malformed room_member_count specs and missing is', () => {
    expect(matchesCondition({ kind: 'room_member_count' }, message, userId, 2)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: '~~2' }, message, userId, 2)).toBe(
      false
    );
  });

  it('treats sender_notification_permission as always true (simplified)', () => {
    expect(
      matchesCondition({ kind: 'sender_notification_permission' }, message, userId, 2)
    ).toBe(true);
  });

  it('rejects event_property_contains when the value is not an array', () => {
    expect(
      matchesCondition(
        { kind: 'event_property_contains', key: 'content.body', value: 'Hello' },
        message,
        userId,
        2
      )
    ).toBe(false);
  });
});

describe('matchesRule', () => {
  it('matches content pattern rules', () => {
    const rule: PushRule = {
      rule_id: '.m.rule.contains_user_name',
      default: true,
      enabled: true,
      pattern: 'alice',
      actions: ['notify'],
    };
    expect(matchesRule(rule, message, userId, 2)).toBe(true);
    expect(matchesRule(rule, { content: {} }, userId, 2)).toBe(false);
  });

  it('requires every condition to match', () => {
    const rule: PushRule = {
      rule_id: 'custom',
      default: false,
      enabled: true,
      conditions: [
        { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
        { kind: 'room_member_count', is: '==2' },
      ],
      actions: ['notify'],
    };
    expect(matchesRule(rule, message, userId, 2)).toBe(true);
    expect(matchesRule(rule, message, userId, 9)).toBe(false);
  });

  it('matches rules with neither pattern nor conditions', () => {
    const rule: PushRule = {
      rule_id: '.m.rule.master',
      default: true,
      enabled: true,
      actions: ['dont_notify'],
    };
    expect(matchesRule(rule, message, userId, 2)).toBe(true);
  });

  it('matches glob content patterns case-insensitively', () => {
    const rule: PushRule = {
      rule_id: 'custom-glob',
      default: false,
      enabled: true,
      pattern: 'HELLO*',
      actions: ['notify'],
    };
    expect(matchesRule(rule, message, userId, 2)).toBe(true);
  });
});

describe('getNestedValue deeper paths', () => {
  it('walks multi-level paths and stops on null', () => {
    expect(getNestedValue({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
    expect(getNestedValue({ a: null }, 'a.b')).toBeUndefined();
  });
});
