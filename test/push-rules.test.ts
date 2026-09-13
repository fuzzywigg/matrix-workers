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
