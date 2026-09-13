import { describe, it, expect } from 'vitest';
import {
  matchesRule,
  matchesCondition,
  getNestedValue,
  evaluatePushRules,
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

describe('push-rules TOKENMAXX edge paths after #50', () => {
  it('escapes literal ? and + in content patterns', () => {
    const rule: PushRule = {
      rule_id: 'q',
      default: false,
      enabled: true,
      pattern: 'a?b',
      actions: ['notify'],
    };
    expect(matchesRule(rule, { content: { body: 'axb' } }, userId, 2)).toBe(false);
    expect(matchesRule(rule, { content: { body: 'a?b' } }, userId, 2)).toBe(true);

    const plus: PushRule = {
      rule_id: 'plus',
      default: false,
      enabled: true,
      pattern: 'a+b',
      actions: ['notify'],
    };
    expect(matchesRule(plus, { content: { body: 'aab' } }, userId, 2)).toBe(false);
    expect(matchesRule(plus, { content: { body: 'a+b' } }, userId, 2)).toBe(true);
  });

  it('matches contains_display_name case-insensitively', () => {
    expect(
      matchesCondition(
        { kind: 'contains_display_name' },
        { content: { body: 'hello Alice there' } },
        userId,
        2,
        'ALICE'
      )
    ).toBe(true);
  });

  it('unescapes \\\\. in event_property_contains keys before nested lookup', () => {
    // replace(/\\\./g, '.') turns content.mentions\.user_ids into content.mentions.user_ids
    expect(
      matchesCondition(
        { kind: 'event_property_contains', key: 'content.mentions\\.user_ids', value: userId },
        { content: { mentions: { user_ids: [userId] } } },
        userId,
        2
      )
    ).toBe(true);
    expect(
      matchesCondition(
        { kind: 'event_property_contains', key: 'content.mentions.user_ids', value: userId },
        { content: { mentions: { user_ids: [userId] } } },
        userId,
        2
      )
    ).toBe(true);
  });

  it('stops getNestedValue on undefined mid-path', () => {
    expect(getNestedValue({ a: undefined }, 'a.b')).toBeUndefined();
  });
});


describe('push-rules TOKENMAXX edge paths after #52', () => {
  it('matches event_match and content patterns of lone * against anything', () => {
    expect(
      matchesCondition(
        { kind: 'event_match', key: 'type', pattern: '*' },
        message,
        userId,
        2
      )
    ).toBe(true);
    const rule: PushRule = {
      rule_id: 'star',
      default: false,
      enabled: true,
      pattern: '*',
      actions: ['notify'],
    };
    expect(matchesRule(rule, message, userId, 2)).toBe(true);
  });

  it('parses room_member_count ==02 with leading zeros as 2', () => {
    expect(
      matchesCondition({ kind: 'room_member_count', is: '==02' }, message, userId, 2)
    ).toBe(true);
    expect(
      matchesCondition({ kind: 'room_member_count', is: '==02' }, message, userId, 3)
    ).toBe(false);
  });

  it('coerces numeric event_match fields via String(value)', () => {
    expect(
      matchesCondition(
        { kind: 'event_match', key: 'depth', pattern: '5' },
        { ...message, depth: 5 },
        userId,
        2
      )
    ).toBe(true);
  });

  it('matches contains_display_name as a substring inside a longer token', () => {
    expect(
      matchesCondition(
        { kind: 'contains_display_name' },
        { content: { body: 'hello malice there' } },
        userId,
        2,
        'alice'
      )
    ).toBe(true);
  });

  it('walks array indices via numeric getNestedValue path segments', () => {
    expect(getNestedValue({ 0: { name: 'x' } }, '0.name')).toBe('x');
    expect(getNestedValue([{ name: 'y' }], '0.name')).toBe('y');
  });
});

describe('push-rules TOKENMAXX edge paths after #53', () => {
  it('uses strict equality for event_property_is (number !== string)', () => {
    expect(
      matchesCondition(
        { kind: 'event_property_is', key: 'content.count', value: 5 },
        { content: { count: '5' } },
        userId,
        2
      )
    ).toBe(false);
    expect(
      matchesCondition(
        { kind: 'event_property_is', key: 'content.count', value: 5 },
        { content: { count: 5 } },
        userId,
        2
      )
    ).toBe(true);
  });

  it('stops getNestedValue when a mid-path value is null', () => {
    expect(getNestedValue({ a: null }, 'a.b')).toBeUndefined();
    expect(
      matchesCondition(
        { kind: 'event_match', key: 'a.b', pattern: 'x' },
        { a: null },
        userId,
        2
      )
    ).toBe(false);
  });

  it('rejects room_member_count is: "==" with no digits', () => {
    expect(
      matchesCondition({ kind: 'room_member_count', is: '==' }, message, userId, 2)
    ).toBe(false);
  });
});

describe('evaluatePushRules TOKENMAXX edge paths after #54', () => {
  function pushDb(rows: Array<Record<string, unknown>> = []) {
    return {
      prepare() {
        return {
          bind() {
            return {
              async all<T>() {
                return { results: rows as T[] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
  }

  const roomId = '!r:example.com';

  it('notifies for ordinary m.room.message via .m.rule.message underride', async () => {
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      {
        type: 'm.room.message',
        sender: '@bob:example.com',
        room_id: roomId,
        content: { body: 'hi', msgtype: 'm.text' },
      },
      5
    );
    expect(result).toMatchObject({ notify: true, highlight: false });
  });

  it('suppresses member events that are not invite-for-me', async () => {
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      {
        type: 'm.room.member',
        sender: '@bob:example.com',
        room_id: roomId,
        state_key: '@carol:example.com',
        content: { membership: 'join' },
      },
      5
    );
    expect(result.notify).toBe(false);
  });

  it('suppresses reactions and notices via override rules', async () => {
    expect(
      (
        await evaluatePushRules(
          pushDb(),
          userId,
          {
            type: 'm.reaction',
            sender: '@bob:example.com',
            room_id: roomId,
            content: { 'm.relates_to': { rel_type: 'm.annotation', key: '👍' } },
          },
          5
        )
      ).notify
    ).toBe(false);

    expect(
      (
        await evaluatePushRules(
          pushDb(),
          userId,
          {
            type: 'm.room.message',
            sender: '@bob:example.com',
            room_id: roomId,
            content: { body: 'bot', msgtype: 'm.notice' },
          },
          5
        )
      ).notify
    ).toBe(false);
  });

  it('notifies invite-for-me when state_key matches the user', async () => {
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      {
        type: 'm.room.member',
        sender: '@bob:example.com',
        room_id: roomId,
        state_key: userId,
        content: { membership: 'invite' },
      },
      5
    );
    expect(result.notify).toBe(true);
  });

  it('highlights when the body contains the user localpart', async () => {
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      {
        type: 'm.room.message',
        sender: '@bob:example.com',
        room_id: roomId,
        content: { body: 'hey Alice check this', msgtype: 'm.text' },
      },
      5
    );
    expect(result).toMatchObject({ notify: true, highlight: true });
  });

  it('does not blanket-suppress when the master rule remains disabled', async () => {
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      {
        type: 'm.room.message',
        sender: '@bob:example.com',
        room_id: roomId,
        content: { body: 'still notify', msgtype: 'm.text' },
      },
      5
    );
    expect(result.notify).toBe(true);
  });

  it('ignores custom DB rules with enabled:0 and honors enabled:1 dont_notify overrides', async () => {
    const disabled = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.custom.disabled',
          conditions: null,
          actions: JSON.stringify(['dont_notify']),
          enabled: 0,
        },
      ]),
      userId,
      {
        type: 'm.room.message',
        sender: '@bob:example.com',
        room_id: roomId,
        content: { body: 'x', msgtype: 'm.text' },
      },
      5
    );
    expect(disabled.notify).toBe(true);

    const enabled = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.custom.quiet',
          conditions: null,
          actions: JSON.stringify(['dont_notify']),
          enabled: 1,
        },
      ]),
      userId,
      {
        type: 'm.room.message',
        sender: '@bob:example.com',
        room_id: roomId,
        content: { body: 'x', msgtype: 'm.text' },
      },
      5
    );
    expect(enabled.notify).toBe(false);
  });
});



describe('evaluatePushRules TOKENMAXX edge paths after #55', () => {
  function pushDb(rows: Array<Record<string, unknown>> = []) {
    return {
      prepare() {
        return {
          bind() {
            return {
              async all<T>() {
                return { results: rows as T[] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
  }

  const roomId = '!room:example.com';

  it('treats contradictory notify+dont_notify actions as notify:false', async () => {
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.custom.both',
          conditions: null,
          actions: JSON.stringify(['notify', 'dont_notify']),
          enabled: 1,
        },
      ]),
      userId,
      {
        type: 'm.room.message',
        sender: '@bob:example.com',
        room_id: roomId,
        content: { body: 'x', msgtype: 'm.text' },
      },
      5
    );
    expect(result.notify).toBe(false);
  });

  it('highlights when set_tweak highlight omits value; value:false clears highlight', async () => {
    const highlighted = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.custom.hl',
          conditions: null,
          actions: JSON.stringify(['notify', { set_tweak: 'highlight' }]),
          enabled: 1,
        },
      ]),
      userId,
      {
        type: 'm.room.message',
        sender: '@bob:example.com',
        room_id: roomId,
        content: { body: 'x', msgtype: 'm.text' },
      },
      5
    );
    expect(highlighted).toMatchObject({ notify: true, highlight: true });

    const quiet = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.custom.nohl',
          conditions: null,
          actions: JSON.stringify([
            'notify',
            { set_tweak: 'highlight', value: false },
          ]),
          enabled: 1,
        },
      ]),
      userId,
      {
        type: 'm.room.message',
        sender: '@bob:example.com',
        room_id: roomId,
        content: { body: 'x', msgtype: 'm.text' },
      },
      5
    );
    expect(quiet).toMatchObject({ notify: true, highlight: false });
  });

  it('fires default contains_display_name when displayName is provided', async () => {
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      {
        type: 'm.room.message',
        sender: '@bob:example.com',
        room_id: roomId,
        content: { body: 'hey Display Name here', msgtype: 'm.text' },
      },
      5,
      'Display Name'
    );
    expect(result).toMatchObject({ notify: true, highlight: true });
  });

  it('does not highlight for sound-only tweaks; does for highlight value:true', async () => {
    const soundOnly = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.custom.sound',
          conditions: null,
          actions: JSON.stringify([
            'notify',
            { set_tweak: 'sound', value: 'default' },
          ]),
          enabled: 1,
        },
      ]),
      userId,
      {
        type: 'm.room.message',
        sender: '@bob:example.com',
        room_id: roomId,
        content: { body: 'x', msgtype: 'm.text' },
      },
      5
    );
    expect(soundOnly).toMatchObject({ notify: true, highlight: false });

    const explicit = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.custom.hltrue',
          conditions: null,
          actions: JSON.stringify([
            'notify',
            { set_tweak: 'highlight', value: true },
          ]),
          enabled: 1,
        },
      ]),
      userId,
      {
        type: 'm.room.message',
        sender: '@bob:example.com',
        room_id: roomId,
        content: { body: 'x', msgtype: 'm.text' },
      },
      5
    );
    expect(explicit).toMatchObject({ notify: true, highlight: true });
  });
});


describe('push-rules TOKENMAXX edge paths after #57', () => {
  function pushDb(rows: Array<Record<string, unknown>> = []) {
    return {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: rows }),
        }),
      }),
    } as unknown as D1Database;
  }

  const roomId = '!room:example.com';

  it('skips a failed override condition and falls through to a later matching rule', async () => {
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.custom.miss',
          conditions: JSON.stringify([
            { kind: 'event_match', key: 'type', pattern: 'm.room.encrypted' },
          ]),
          actions: JSON.stringify(['dont_notify']),
          enabled: 1,
        },
      ]),
      userId,
      {
        type: 'm.room.message',
        sender: '@bob:example.com',
        room_id: roomId,
        content: { body: 'hello there', msgtype: 'm.text' },
      },
      5
    );
    // Default .m.rule.message underride still notifies after the miss
    expect(result).toMatchObject({ notify: true, highlight: false });
  });

  it('treats event_property_is with value undefined as true when the key is missing', () => {
    expect(
      matchesCondition(
        { kind: 'event_property_is', key: 'content.missing', value: undefined },
        message,
        userId,
        2
      )
    ).toBe(true);
    expect(
      matchesCondition(
        { kind: 'event_property_is', key: 'content.msgtype', value: undefined },
        { ...message, content: { ...message.content, msgtype: null } },
        userId,
        2
      )
    ).toBe(false);
  });
});

describe('evaluatePushRules default underrides/overrides TOKENMAXX after #76', () => {
  function pushDb(rows: Array<Record<string, unknown>> = []) {
    return {
      prepare() {
        return {
          bind() {
            return {
              async all<T>() {
                return { results: rows as T[] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
  }

  const roomId = '!r:example.com';
  const bob = '@bob:example.com';

  it('rings on m.call.invite via .m.rule.call underride', async () => {
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      { type: 'm.call.invite', sender: bob, room_id: roomId, content: { call_id: 'c1' } },
      5
    );
    expect(result).toMatchObject({
      notify: true,
      highlight: false,
      actions: ['notify', { set_tweak: 'sound', value: 'ring' }],
    });
  });

  it('notifies 1:1 encrypted with default sound via .m.rule.encrypted_room_one_to_one', async () => {
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      { type: 'm.room.encrypted', sender: bob, room_id: roomId, content: {} },
      2
    );
    expect(result).toMatchObject({
      notify: true,
      highlight: false,
      actions: ['notify', { set_tweak: 'sound', value: 'default' }],
    });
  });

  it('notifies 1:1 plaintext with sound via .m.rule.room_one_to_one (beats bare .m.rule.message)', async () => {
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      {
        type: 'm.room.message',
        sender: bob,
        room_id: roomId,
        content: { body: 'dm hi', msgtype: 'm.text' },
      },
      2
    );
    expect(result).toMatchObject({
      notify: true,
      highlight: false,
      actions: ['notify', { set_tweak: 'sound', value: 'default' }],
    });
  });

  it('notifies encrypted in >2-member rooms via .m.rule.encrypted without 1:1 sound', async () => {
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      { type: 'm.room.encrypted', sender: bob, room_id: roomId, content: {} },
      5
    );
    expect(result).toEqual({ notify: true, actions: ['notify'], highlight: false });
  });

  it('highlights is_user_mention when nested content.m.mentions.user_ids contains the user', async () => {
    // Default key is `content.m\\.mentions.user_ids`; after unescaping, getNestedValue
    // walks content → m → mentions → user_ids (not Matrix `content["m.mentions"]`).
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      {
        type: 'm.room.message',
        sender: bob,
        room_id: roomId,
        content: {
          body: 'ping',
          msgtype: 'm.text',
          m: { mentions: { user_ids: [userId] } },
        },
      },
      5
    );
    expect(result).toMatchObject({
      notify: true,
      highlight: true,
      actions: [
        'notify',
        { set_tweak: 'sound', value: 'default' },
        { set_tweak: 'highlight', value: true },
      ],
    });
  });

  it('does not fire is_user_mention for Matrix-shaped content["m.mentions"] keys', async () => {
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      {
        type: 'm.room.message',
        sender: bob,
        room_id: roomId,
        content: {
          body: 'no localpart match here',
          msgtype: 'm.text',
          'm.mentions': { user_ids: [userId] },
        },
      },
      5
    );
    // Falls through to .m.rule.message underride (notify, no highlight)
    expect(result).toMatchObject({ notify: true, highlight: false, actions: ['notify'] });
  });

  it('highlights is_room_mention when nested content.m.mentions.room is true', async () => {
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      {
        type: 'm.room.message',
        sender: bob,
        room_id: roomId,
        content: {
          body: 'attention all',
          msgtype: 'm.text',
          m: { mentions: { room: true } },
        },
      },
      5
    );
    expect(result).toMatchObject({
      notify: true,
      highlight: true,
      actions: ['notify', { set_tweak: 'highlight', value: true }],
    });
  });

  it('documents that default tombstone/server_acl never match (empty state_key pattern is falsy)', async () => {
    // event_match guards `!condition.pattern`, so pattern:'' never reaches the
    // user_id-placeholder branch. Defaults therefore fall through with no match.
    const tomb = await evaluatePushRules(
      pushDb(),
      userId,
      {
        type: 'm.room.tombstone',
        sender: bob,
        room_id: roomId,
        state_key: '',
        content: { body: 'room upgraded' },
      },
      5
    );
    expect(tomb).toEqual({ notify: false, actions: [], highlight: false });

    const acl = await evaluatePushRules(
      pushDb(),
      userId,
      {
        type: 'm.room.server_acl',
        sender: bob,
        room_id: roomId,
        state_key: '',
        content: { allow: ['*'] },
      },
      5
    );
    expect(acl).toEqual({ notify: false, actions: [], highlight: false });
  });

  it('fires custom tombstone override (type-only) with notify+highlight', async () => {
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.m.rule.tombstone',
          conditions: JSON.stringify([
            { kind: 'event_match', key: 'type', pattern: 'm.room.tombstone' },
          ]),
          actions: JSON.stringify([
            'notify',
            { set_tweak: 'highlight', value: true },
          ]),
          enabled: 1,
        },
      ]),
      userId,
      {
        type: 'm.room.tombstone',
        sender: bob,
        room_id: roomId,
        state_key: '',
        content: {},
      },
      5
    );
    expect(result).toMatchObject({ notify: true, highlight: true });
  });

  it('matches custom server_acl override with empty actions → notify:false', async () => {
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.m.rule.room.server_acl',
          conditions: JSON.stringify([
            { kind: 'event_match', key: 'type', pattern: 'm.room.server_acl' },
          ]),
          actions: JSON.stringify([]),
          enabled: 1,
        },
      ]),
      userId,
      {
        type: 'm.room.server_acl',
        sender: bob,
        room_id: roomId,
        state_key: '',
        content: {},
      },
      5
    );
    expect(result).toEqual({ notify: false, actions: [], highlight: false });
  });

  it('returns notify:false for unknown event types that match no default rule', async () => {
    const result = await evaluatePushRules(
      pushDb(),
      userId,
      {
        type: 'org.example.custom',
        sender: bob,
        room_id: roomId,
        content: { body: 'noop' },
      },
      5
    );
    expect(result).toEqual({ notify: false, actions: [], highlight: false });
  });

  it('bare room_member_count is:"2" equals ==2 for 1:1 underrides', () => {
    expect(matchesCondition({ kind: 'room_member_count', is: '2' }, message, userId, 2)).toBe(
      true
    );
    expect(matchesCondition({ kind: 'room_member_count', is: '2' }, message, userId, 3)).toBe(
      false
    );
  });
});

describe('getUserPushRules merge via evaluatePushRules TOKENMAXX after #76', () => {
  function pushDb(rows: Array<Record<string, unknown>> = []) {
    return {
      prepare() {
        return {
          bind() {
            return {
              async all<T>() {
                return { results: rows as T[] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
  }

  const roomId = '!merge:example.com';
  const bob = '@bob:example.com';
  const baseMsg = {
    type: 'm.room.message',
    sender: bob,
    room_id: roomId,
    content: { body: 'hello world', msgtype: 'm.text' },
  };

  it('treats malformed conditions JSON as undefined (vacuous match when no pattern)', async () => {
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.custom.bad-cond',
          conditions: '{not-json',
          actions: JSON.stringify(['dont_notify']),
          enabled: 1,
        },
      ]),
      userId,
      baseMsg,
      5
    );
    // No conditions + no pattern → matchesRule returns true → quiet
    expect(result.notify).toBe(false);
  });

  it('treats malformed actions JSON as [] → notify:false even when the rule matches', async () => {
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.custom.bad-act',
          conditions: null,
          actions: 'not-json-array',
          enabled: 1,
        },
      ]),
      userId,
      baseMsg,
      5
    );
    expect(result).toEqual({ notify: false, actions: [], highlight: false });
  });

  it('overrides an existing default rule_id in place (disables .m.rule.message)', async () => {
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'underride',
          rule_id: '.m.rule.message',
          conditions: JSON.stringify([
            { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
          ]),
          actions: JSON.stringify(['dont_notify']),
          enabled: 1,
        },
      ]),
      userId,
      baseMsg,
      5
    );
    expect(result.notify).toBe(false);
  });

  it('unshifts a new custom override ahead of defaults', async () => {
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: 'custom.quiet-all',
          conditions: null,
          actions: JSON.stringify(['dont_notify']),
          enabled: 1,
        },
      ]),
      userId,
      baseMsg,
      5
    );
    expect(result.notify).toBe(false);
  });

  it('honors kind:room custom rules between content and sender priority', async () => {
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'room',
          rule_id: 'room.!merge:example.com',
          conditions: JSON.stringify([
            { kind: 'event_match', key: 'room_id', pattern: roomId },
          ]),
          actions: JSON.stringify([
            'notify',
            { set_tweak: 'highlight', value: true },
          ]),
          enabled: 1,
        },
      ]),
      userId,
      baseMsg,
      5
    );
    expect(result).toMatchObject({ notify: true, highlight: true });
  });

  it('honors kind:sender custom rules before underride', async () => {
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'sender',
          rule_id: 'sender.@bob:example.com',
          conditions: JSON.stringify([
            { kind: 'event_match', key: 'sender', pattern: bob },
          ]),
          actions: JSON.stringify(['dont_notify']),
          enabled: 1,
        },
      ]),
      userId,
      baseMsg,
      5
    );
    expect(result.notify).toBe(false);
  });

  it('ignores unknown kind rows without throwing', async () => {
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'not-a-real-kind',
          rule_id: 'orphan',
          conditions: null,
          actions: JSON.stringify(['dont_notify']),
          enabled: 1,
        },
      ]),
      userId,
      baseMsg,
      5
    );
    // Defaults still apply → .m.rule.message notifies
    expect(result).toMatchObject({ notify: true, highlight: false });
  });

  it('treats enabled:2 as disabled (strict === 1)', async () => {
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.custom.enabled-two',
          conditions: null,
          actions: JSON.stringify(['dont_notify']),
          enabled: 2,
        },
      ]),
      userId,
      baseMsg,
      5
    );
    expect(result.notify).toBe(true);
  });

  it('marks .m.rule.* overrides as default:true while custom ids stay default:false', async () => {
    // Observable via merge: overriding .m.rule.message keeps rule_id and still matches
    const overridden = await evaluatePushRules(
      pushDb([
        {
          kind: 'underride',
          rule_id: '.m.rule.message',
          conditions: JSON.stringify([
            { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
          ]),
          actions: JSON.stringify(['notify', { set_tweak: 'sound', value: 'custom' }]),
          enabled: 1,
        },
      ]),
      userId,
      baseMsg,
      5
    );
    expect(overridden.actions).toEqual([
      'notify',
      { set_tweak: 'sound', value: 'custom' },
    ]);

    const custom = await evaluatePushRules(
      pushDb([
        {
          kind: 'content',
          rule_id: 'im.vector.custom.keyword',
          conditions: null,
          actions: JSON.stringify([
            'notify',
            { set_tweak: 'highlight', value: true },
          ]),
          enabled: 1,
          // content rules need pattern — without pattern+conditions matchesRule → true
        },
      ]),
      userId,
      baseMsg,
      5
    );
    expect(custom).toMatchObject({ notify: true, highlight: true });
  });

  it('null conditions column stays undefined and merges with preserved default fields on override', async () => {
    // Override .m.rule.master enabled:false → enabled:true dont_notify (blanket quiet)
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.m.rule.master',
          conditions: null,
          actions: JSON.stringify(['dont_notify']),
          enabled: 1,
        },
      ]),
      userId,
      baseMsg,
      5
    );
    expect(result.notify).toBe(false);
  });

  it('room rule that misses falls through to underride message', async () => {
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'room',
          rule_id: 'room.!other:example.com',
          conditions: JSON.stringify([
            { kind: 'event_match', key: 'room_id', pattern: '!other:example.com' },
          ]),
          actions: JSON.stringify(['dont_notify']),
          enabled: 1,
        },
      ]),
      userId,
      baseMsg,
      5
    );
    expect(result).toMatchObject({ notify: true, highlight: false, actions: ['notify'] });
  });

  it('conditions:null string parse path — empty string conditions → undefined', async () => {
    // row.conditions is truthy empty string? '' is falsy → undefined without parse
    const result = await evaluatePushRules(
      pushDb([
        {
          kind: 'override',
          rule_id: '.custom.empty-cond-str',
          conditions: '',
          actions: JSON.stringify(['dont_notify']),
          enabled: 1,
        },
      ]),
      userId,
      baseMsg,
      5
    );
    expect(result.notify).toBe(false);
  });
});
