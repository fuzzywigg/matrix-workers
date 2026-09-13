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

describe('matchesCondition failure edges', () => {
  it('rejects event_match without key or when the path is missing', () => {
    expect(
      matchesCondition({ kind: 'event_match', pattern: 'x' }, message, userId, 2)
    ).toBe(false);
    expect(
      matchesCondition(
        { kind: 'event_match', key: 'content.nope', pattern: 'x' },
        message,
        userId,
        2
      )
    ).toBe(false);
  });

  it('treats bare member-count numbers as ==', () => {
    expect(matchesCondition({ kind: 'room_member_count', is: '2' }, message, userId, 2)).toBe(
      true
    );
    expect(matchesCondition({ kind: 'room_member_count', is: '3' }, message, userId, 2)).toBe(
      false
    );
  });

  it('rejects contains_display_name without a name or body', () => {
    expect(matchesCondition({ kind: 'contains_display_name' }, message, userId, 2)).toBe(false);
    expect(
      matchesCondition(
        { kind: 'contains_display_name' },
        { content: {} },
        userId,
        2,
        'alice'
      )
    ).toBe(false);
  });

  it('rejects event_property_is without a key and mismatches values', () => {
    expect(
      matchesCondition({ kind: 'event_property_is', value: 'm.text' }, message, userId, 2)
    ).toBe(false);
    expect(
      matchesCondition(
        { kind: 'event_property_is', key: 'content.msgtype', value: 'm.image' },
        message,
        userId,
        2
      )
    ).toBe(false);
  });

  it('defaults unknown condition kinds to true (lenient)', () => {
    expect(
      matchesCondition({ kind: 'not_a_real_kind' as 'event_match' }, message, userId, 2)
    ).toBe(true);
  });
});

describe('matchesRule content failure edges', () => {
  it('rejects content rules when body is missing or empty', () => {
    const rule: PushRule = {
      rule_id: 'body-required',
      default: false,
      enabled: true,
      pattern: 'alice',
      actions: ['notify'],
    };
    expect(matchesRule(rule, { content: { body: '' } }, userId, 2)).toBe(false);
    expect(matchesRule(rule, { content: null }, userId, 2)).toBe(false);
  });

  it('fails closed when any condition fails in an AND list', () => {
    const rule: PushRule = {
      rule_id: 'and',
      default: false,
      enabled: true,
      conditions: [
        { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
        { kind: 'event_match', key: 'sender', pattern: '@nobody:example.com' },
      ],
      actions: ['notify'],
    };
    expect(matchesRule(rule, message, userId, 2)).toBe(false);
  });

  it('prefers pattern matching over conditions when both are present', () => {
    const rule: PushRule = {
      rule_id: 'pattern-wins',
      default: false,
      enabled: true,
      pattern: 'zzz',
      conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }],
      actions: ['notify'],
    };
    // Body is "Hello Alice there" — pattern branch returns first and fails
    expect(matchesRule(rule, message, userId, 2)).toBe(false);
  });
});

describe('matchesCondition escaped property keys', () => {
  it('unescapes backslash-dot paths for event_property_is', () => {
    expect(
      matchesCondition(
        { kind: 'event_property_is', key: 'content\\.msgtype', value: 'm.text' },
        message,
        userId,
        2
      )
    ).toBe(true);
  });
});


describe('push rules TOKENMAXX edge paths after #49', () => {
  it('treats empty conditions arrays as vacuously matching', () => {
    const rule: PushRule = {
      rule_id: 'empty-conds',
      default: false,
      enabled: true,
      conditions: [],
      actions: ['notify'],
    };
    expect(matchesRule(rule, message, userId, 2)).toBe(true);
  });

  it('rejects event_property_contains without a key', () => {
    expect(
      matchesCondition(
        { kind: 'event_property_contains', value: userId },
        message,
        userId,
        2
      )
    ).toBe(false);
  });

  it('escapes literal dots in content patterns but still expands * globs', () => {
    const ruleDot: PushRule = {
      rule_id: 'dot',
      default: false,
      enabled: true,
      pattern: 'hello.',
      actions: ['notify'],
    };
    expect(matchesRule(ruleDot, { content: { body: 'helloX' } }, userId, 2)).toBe(false);
    expect(matchesRule(ruleDot, { content: { body: 'hello.' } }, userId, 2)).toBe(true);

    const ruleGlob: PushRule = {
      rule_id: 'glob',
      default: false,
      enabled: true,
      pattern: 'hel*o',
      actions: ['notify'],
    };
    expect(matchesRule(ruleGlob, { content: { body: 'hello' } }, userId, 2)).toBe(true);
  });

  it('returns the root object for an empty getNestedValue path', () => {
    expect(getNestedValue(message, '')).toBe(message['']);
    expect(getNestedValue({ a: { b: 1 } }, 'a.missing.x')).toBeUndefined();
  });
});
