import { describe, it, expect } from 'vitest';
import { buildStateMap, checkEventAuth, stateKey } from '../src/services/event-auth';
import type { PDU } from '../src/types';

function pdu(partial: Partial<PDU> & Pick<PDU, 'type' | 'sender' | 'event_id'>): PDU {
  return {
    room_id: '!room:example.com',
    content: {},
    origin_server_ts: 1,
    auth_events: [],
    prev_events: [],
    depth: 1,
    ...partial,
  };
}

function createEvent(creator = '@alice:example.com'): PDU {
  return pdu({
    type: 'm.room.create',
    event_id: '$create',
    sender: creator,
    state_key: '',
    prev_events: [],
    depth: 0,
    content: { creator, room_version: '10' },
  });
}

function memberEvent(
  userId: string,
  membership: 'join' | 'invite' | 'leave' | 'ban' | 'knock',
  sender = userId
): PDU {
  return pdu({
    type: 'm.room.member',
    event_id: `$member-${userId}-${membership}`,
    sender,
    state_key: userId,
    content: { membership },
  });
}

function powerLevels(users: Record<string, number>): PDU {
  return pdu({
    type: 'm.room.power_levels',
    event_id: '$pl',
    sender: '@alice:example.com',
    state_key: '',
    content: {
      users,
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
    },
  });
}

describe('stateKey / buildStateMap', () => {
  it('keys state events by type and state_key', () => {
    const create = createEvent();
    const join = memberEvent('@alice:example.com', 'join');
    const map = buildStateMap([create, join, pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: '@alice:example.com',
      content: { body: 'hi', msgtype: 'm.text' },
    })]);

    expect(map.get(stateKey('m.room.create', ''))).toBe(create);
    expect(map.get(stateKey('m.room.member', '@alice:example.com'))).toBe(join);
    expect(map.size).toBe(2);
  });
});

describe('checkEventAuth', () => {
  it('allows a well-formed create event', () => {
    expect(checkEventAuth(createEvent(), []).allowed).toBe(true);
  });

  it('rejects create events with prev_events or non-empty state_key', () => {
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.create',
          event_id: '$bad',
          sender: '@alice:example.com',
          state_key: '',
          prev_events: ['$other'],
          content: { creator: '@alice:example.com', room_version: '10' },
        }),
        []
      ).allowed
    ).toBe(false);

    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.create',
          event_id: '$bad2',
          sender: '@alice:example.com',
          state_key: 'not-empty',
          content: { creator: '@alice:example.com', room_version: '10' },
        }),
        []
      ).allowed
    ).toBe(false);
  });

  it('rejects non-create events without a create event in state', () => {
    const result = checkEventAuth(memberEvent('@alice:example.com', 'join'), []);
    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/create/i);
  });

  it('allows self-join to a public room', () => {
    const state = [
      createEvent(),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'public' },
      }),
    ];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'join'), state, '10').allowed).toBe(true);
  });

  it('rejects joining on behalf of another user', () => {
    const state = [
      createEvent(),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'public' },
      }),
    ];
    const result = checkEventAuth(
      memberEvent('@bob:example.com', 'join', '@alice:example.com'),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });

  it('allows invite when sender is joined with invite power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
        state,
        '10'
      ).allowed
    ).toBe(true);
  });

  it('rejects message sends from non-joined senders', () => {
    const state = [createEvent(), memberEvent('@alice:example.com', 'join')];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.message',
        event_id: '$msg',
        sender: '@bob:example.com',
        content: { msgtype: 'm.text', body: 'hi' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/not joined/i);
  });

  it('allows message sends from joined senders', () => {
    const state = [createEvent(), memberEvent('@alice:example.com', 'join')];
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.message',
          event_id: '$msg',
          sender: '@alice:example.com',
          content: { msgtype: 'm.text', body: 'hi' },
        }),
        state,
        '10'
      ).allowed
    ).toBe(true);
  });

  it('rejects unsupported room versions', () => {
    const result = checkEventAuth(
      pdu({
        type: 'm.room.message',
        event_id: '$msg',
        sender: '@alice:example.com',
        content: {},
      }),
      [createEvent()],
      '99'
    );
    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/Unsupported room version/);
  });

  it('rejects knocking on room versions that do not support it', () => {
    const state = [
      createEvent(),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'knock' },
      }),
    ];
    const result = checkEventAuth(memberEvent('@bob:example.com', 'knock'), state, '6');
    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/Knocking not supported/);
  });

  it('allows a joined user to leave', () => {
    const state = [createEvent(), memberEvent('@alice:example.com', 'join')];
    expect(
      checkEventAuth(memberEvent('@alice:example.com', 'leave'), state, '10').allowed
    ).toBe(true);
  });

  it('allows a high-power user to kick and ban', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'leave', '@alice:example.com'),
        state,
        '10'
      ).allowed
    ).toBe(true);
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'ban', '@alice:example.com'), state, '10')
        .allowed
    ).toBe(true);
  });

  it('rejects kicks from users without kick power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      memberEvent('@carol:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    const result = checkEventAuth(
      memberEvent('@carol:example.com', 'leave', '@bob:example.com'),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/kick/i);
  });

  it('rejects redactions from low-power senders', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$redact',
        sender: '@bob:example.com',
        content: {},
        redacts: '$msg',
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/redact/i);
  });

  it('allows knocking on v7+ knock rooms', () => {
    const state = [
      createEvent(),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'knock' },
      }),
    ];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'knock'), state, '10').allowed).toBe(
      true
    );
  });

  it('rejects non-integer power levels on v10+', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-bad',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 100, '@bob:example.com': 50.5 },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 0,
        },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/integers/i);
  });

  it('rejects power-level escalation above the sender own level', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-escalate',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 50, '@bob:example.com': 100 },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 0,
        },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/higher than own/i);
  });

  it('allows restricted joins with an authorizing joined inviter', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'restricted' },
      }),
    ];
    const join = memberEvent('@bob:example.com', 'join');
    join.content = {
      membership: 'join',
      join_authorised_via_users_server: '@alice:example.com',
    };
    expect(checkEventAuth(join, state, '10').allowed).toBe(true);
  });

  it('allows invite→join and rejects joining when banned', () => {
    const base = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    const invited = [...base, memberEvent('@bob:example.com', 'invite', '@alice:example.com')];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'join'), invited, '10').allowed).toBe(
      true
    );

    const banned = [...base, memberEvent('@bob:example.com', 'ban', '@alice:example.com')];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'join'), banned, '10').allowed).toBe(
      false
    );
  });

  it('allows unban via leave from a privileged sender', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'ban', '@alice:example.com'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'leave', '@alice:example.com'), state, '10')
        .allowed
    ).toBe(true);
  });

  it('rejects knocking when already joined or on behalf of another user', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'knock' },
      }),
    ];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'knock'), state, '10').allowed).toBe(
      false
    );
    expect(
      checkEventAuth(memberEvent('@carol:example.com', 'knock', '@alice:example.com'), state, '10')
        .allowed
    ).toBe(false);
  });

  it('rejects state events without sufficient power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.name',
        event_id: '$name',
        sender: '@bob:example.com',
        state_key: '',
        content: { name: 'Nope' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });

  it('rejects unknown membership values', () => {
    const state = [createEvent(), memberEvent('@alice:example.com', 'join')];
    const bad = memberEvent('@bob:example.com', 'join');
    bad.content = { membership: 'wat' };
    expect(checkEventAuth(bad, state, '10').allowed).toBe(false);
  });

  it('rejects invite of an already-joined or banned user', () => {
    const base = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
        [...base, memberEvent('@bob:example.com', 'join')],
        '10'
      ).allowed
    ).toBe(false);
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
        [...base, memberEvent('@bob:example.com', 'ban', '@alice:example.com')],
        '10'
      ).allowed
    ).toBe(false);
  });

  it('rejects invite without invite power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 100 },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 50,
        },
      }),
    ];
    expect(
      checkEventAuth(
        memberEvent('@carol:example.com', 'invite', '@bob:example.com'),
        state,
        '10'
      ).allowed
    ).toBe(false);
  });

  it('allows profile re-join when already joined', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'invite' },
      }),
    ];
    const rejoin = memberEvent('@alice:example.com', 'join');
    rejoin.content = { membership: 'join', displayname: 'Alice' };
    expect(checkEventAuth(rejoin, state, '10').allowed).toBe(true);
  });

  it('allows redaction when sender has redact power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.redaction',
          event_id: '$redact',
          sender: '@alice:example.com',
          content: {},
          redacts: '$msg',
        }),
        state,
        '10'
      ).allowed
    ).toBe(true);
  });

  it('rejects ban of equal-or-higher power users', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      powerLevels({ '@alice:example.com': 50, '@bob:example.com': 50 }),
    ];
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'ban', '@alice:example.com'), state, '10')
        .allowed
    ).toBe(false);
  });

  it('rejects knocking when join_rule is invite', () => {
    const state = [
      createEvent(),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'invite' },
      }),
    ];
    const result = checkEventAuth(memberEvent('@bob:example.com', 'knock'), state, '10');
    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/knocking/i);
  });

  it('allows declining an invite via self-leave', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'leave'), state, '10').allowed).toBe(
      true
    );
  });

  it('allows state events when sender meets state_default', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.name',
          event_id: '$name',
          sender: '@alice:example.com',
          state_key: '',
          content: { name: 'General' },
        }),
        state,
        '10'
      ).allowed
    ).toBe(true);
  });

  it('rejects create events missing both creator and room_version', () => {
    const bad = createEvent();
    bad.content = {};
    expect(checkEventAuth(bad, [], '10').allowed).toBe(false);
  });

  it('rejects member events with missing membership', () => {
    const state = [createEvent()];
    const bad = memberEvent('@bob:example.com', 'join');
    bad.content = {};
    expect(checkEventAuth(bad, state, '10').error).toMatch(/Missing membership/);
  });

  it('rejects invite when sender is not joined', () => {
    const state = [createEvent(), memberEvent('@alice:example.com', 'invite')];
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
        state,
        '10'
      ).error
    ).toMatch(/joined to invite/);
  });

  it('rejects self-leave when not a member', () => {
    const state = [createEvent(), memberEvent('@alice:example.com', 'join')];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'leave'), state, '10').error).toMatch(
      /Not a member/
    );
  });

  it('rejects kicks of equal-power users', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      powerLevels({ '@alice:example.com': 50, '@bob:example.com': 50 }),
    ];
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'leave', '@alice:example.com'), state, '10')
        .error
    ).toMatch(/equal or higher power/);
  });

  it('rejects ban when sender is not joined', () => {
    const state = [createEvent(), memberEvent('@alice:example.com', 'leave')];
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'ban', '@alice:example.com'), state, '10')
        .error
    ).toMatch(/joined to ban/);
  });

  it('rejects knocking when banned', () => {
    const state = [
      createEvent(),
      memberEvent('@bob:example.com', 'ban', '@alice:example.com'),
      memberEvent('@alice:example.com', 'join'),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'knock' },
      }),
    ];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'knock'), state, '10').error).toMatch(
      /Banned users cannot knock/
    );
  });

  it('allows third_party_invite for joined inviters and rejects others', () => {
    const base = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    const invite = pdu({
      type: 'm.room.third_party_invite',
      event_id: '$tpi',
      sender: '@alice:example.com',
      state_key: 'token',
      content: { display_name: 'Bob' },
    });
    expect(checkEventAuth(invite, base, '10').allowed).toBe(true);

    const notJoined = pdu({
      type: 'm.room.third_party_invite',
      event_id: '$tpi2',
      sender: '@eve:example.com',
      state_key: 'token2',
      content: { display_name: 'Eve' },
    });
    // Non-joined senders are rejected by Rule 4 before third_party_invite checks
    expect(checkEventAuth(notJoined, base, '10').error).toMatch(/not joined/i);
  });

  it('rejects changing power of an equal-power user', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      powerLevels({ '@alice:example.com': 50, '@bob:example.com': 50 }),
    ];
    const change = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl2',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 50, '@bob:example.com': 40 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
    });
    expect(checkEventAuth(change, state, '10').error).toMatch(/equal or higher power/);
  });

  it('rejects restricted joins without a joined authorizing user', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'restricted' },
      }),
    ];
    const join = memberEvent('@bob:example.com', 'join');
    join.content = {
      membership: 'join',
      join_authorised_via_users_server: '@missing:example.com',
    };
    expect(checkEventAuth(join, state, '10').error).toMatch(/Not authorized to join/);
  });

  it('allows rescinding a knock via self-leave on v7+', () => {
    const state = [
      createEvent(),
      memberEvent('@bob:example.com', 'knock'),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'knock' },
      }),
    ];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'leave'), state, '10').allowed).toBe(
      true
    );
  });

  it('rejects insufficient-power unban attempts', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      memberEvent('@carol:example.com', 'ban', '@alice:example.com'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 100, '@bob:example.com': 40 },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 0,
        },
      }),
    ];
    expect(
      checkEventAuth(memberEvent('@carol:example.com', 'leave', '@bob:example.com'), state, '10')
        .error
    ).toMatch(/unban/);
  });

  it('rejects restricted joins when the authorizing user lacks invite power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 100, '@bob:example.com': 0 },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 50,
        },
      }),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'restricted' },
      }),
    ];
    const join = memberEvent('@carol:example.com', 'join');
    join.content = {
      membership: 'join',
      join_authorised_via_users_server: '@bob:example.com',
    };
    expect(checkEventAuth(join, state, '10').error).toMatch(/Not authorized to join/);
  });

  it('allows knocking under knock_restricted on v7+', () => {
    const state = [
      createEvent(),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'knock_restricted' },
      }),
    ];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'knock'), state, '10').allowed).toBe(
      true
    );
  });

  it('rejects PL threshold escalation above the sender own level', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 50 },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 0,
        },
      }),
    ];
    const change = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl2',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 50 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 60,
        kick: 50,
        redact: 50,
        invite: 0,
      },
    });
    expect(checkEventAuth(change, state, '10').error).toMatch(
      /Cannot set power level higher than own \(50\)/
    );
  });

  it('rejects messages when events_default is above the sender power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 100 },
          users_default: 0,
          events_default: 50,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 0,
        },
      }),
    ];
    const msg = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: '@bob:example.com',
      content: { body: 'hi', msgtype: 'm.text' },
    });
    expect(checkEventAuth(msg, state, '10').error).toMatch(/Insufficient power level/);
  });
});


describe('checkEventAuth TOKENMAXX edge paths after #49', () => {
  it('rejects invite-only cold joins without prior invite/membership', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'invite' },
      }),
    ];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'join'), state, '10').error).toMatch(
      /Not authorized to join/
    );
  });

  it('rejects restricted joins that omit join_authorised_via_users_server', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'restricted' },
      }),
    ];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'join'), state, '10').error).toMatch(
      /Not authorized to join/
    );
  });

  it('rejects third_party_invite when joined sender lacks invite power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 100, '@bob:example.com': 0 },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 50,
        },
      }),
    ];
    const invite = pdu({
      type: 'm.room.third_party_invite',
      event_id: '$tpi',
      sender: '@bob:example.com',
      state_key: 'token',
      content: { display_name: 'Carol' },
    });
    expect(checkEventAuth(invite, state, '10').error).toMatch(
      /Insufficient power level for third party invite/
    );
  });

  it('rejects kicks when the sender is not joined', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'leave', '@eve:example.com'), state, '10')
        .error
    ).toMatch(/Sender must be joined to kick/);
  });

  it('rejects bans when sender power is below the ban threshold', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      memberEvent('@carol:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 100, '@bob:example.com': 40 },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 0,
        },
      }),
    ];
    expect(
      checkEventAuth(memberEvent('@carol:example.com', 'ban', '@bob:example.com'), state, '10')
        .error
    ).toMatch(/Insufficient power level to ban/);
  });

  it('rejects PL escalation via the events map above the sender level', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 50 },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 0,
        },
      }),
    ];
    const change = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl2',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 50 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
        events: { 'm.room.name': 80 },
      },
    });
    expect(checkEventAuth(change, state, '10').error).toMatch(
      /Cannot set power level higher than own \(50\)/
    );
  });

  it('rejects v10+ non-integer notifications.room power levels', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    const change = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl2',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 100 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
        notifications: { room: 1.5 },
      },
    });
    expect(checkEventAuth(change, state, '10').error).toMatch(/integers/);
  });

  it('lets the last duplicate (type,state_key) win in buildStateMap', () => {
    const first = memberEvent('@bob:example.com', 'invite', '@alice:example.com');
    const second = memberEvent('@bob:example.com', 'join');
    const map = buildStateMap([createEvent(), first, second]);
    expect(map.get(stateKey('m.room.member', '@bob:example.com'))).toBe(second);
  });

  it('rejects messages when a per-type events override exceeds sender power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 100 },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 0,
          events: { 'm.room.message': 50 },
        },
      }),
    ];
    const msg = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: '@bob:example.com',
      content: { body: 'hi', msgtype: 'm.text' },
    });
    expect(checkEventAuth(msg, state, '10').error).toMatch(/Insufficient power level/);
  });

  it('allows messages when power levels are absent (defaults to events_default 0)', () => {
    const state = [createEvent(), memberEvent('@alice:example.com', 'join')];
    const msg = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: '@alice:example.com',
      content: { body: 'hi', msgtype: 'm.text' },
    });
    expect(checkEventAuth(msg, state, '10').allowed).toBe(true);
  });
});

describe('checkEventAuth TOKENMAXX edge paths after #50', () => {
  it('defaults to room version 10 when roomVersion is omitted', () => {
    const state = [createEvent(), memberEvent('@alice:example.com', 'join')];
    const msg = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: '@alice:example.com',
      content: { body: 'hi', msgtype: 'm.text' },
    });
    expect(checkEventAuth(msg, state).allowed).toBe(true);
  });

  it('allows create events that only include creator (no room_version)', () => {
    const create = pdu({
      type: 'm.room.create',
      event_id: '$create-only-creator',
      sender: '@alice:example.com',
      state_key: '',
      prev_events: [],
      depth: 0,
      content: { creator: '@alice:example.com' },
    });
    expect(checkEventAuth(create, []).allowed).toBe(true);
  });

  it('allows create events that only include room_version (no creator)', () => {
    const create = pdu({
      type: 'm.room.create',
      event_id: '$create-only-rv',
      sender: '@alice:example.com',
      state_key: '',
      prev_events: [],
      depth: 0,
      content: { room_version: '10' },
    });
    expect(checkEventAuth(create, []).allowed).toBe(true);
  });

  it('rejects create events missing both creator and room_version with exact error', () => {
    const create = pdu({
      type: 'm.room.create',
      event_id: '$create-empty',
      sender: '@alice:example.com',
      state_key: '',
      prev_events: [],
      depth: 0,
      content: {},
    });
    expect(checkEventAuth(create, []).error).toBe(
      'm.room.create must have creator or room_version'
    );
  });

  it('rejects restricted joins on v7 even when an authorizer is present', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'restricted' },
      }),
    ];
    const join = pdu({
      type: 'm.room.member',
      event_id: '$bob-join',
      sender: '@bob:example.com',
      state_key: '@bob:example.com',
      content: {
        membership: 'join',
        join_authorised_via_users_server: '@alice:example.com',
      },
    });
    expect(checkEventAuth(join, state, '7').error).toMatch(/Not authorized to join/);
  });

  it('allows knock_restricted joins on v10 when the authorizer is joined with invite power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'knock_restricted' },
      }),
    ];
    const join = pdu({
      type: 'm.room.member',
      event_id: '$bob-join',
      sender: '@bob:example.com',
      state_key: '@bob:example.com',
      content: {
        membership: 'join',
        join_authorised_via_users_server: '@alice:example.com',
      },
    });
    expect(checkEventAuth(join, state, '10').allowed).toBe(true);
  });

  it('rejects empty-string membership as missing', () => {
    const state = [createEvent(), memberEvent('@alice:example.com', 'join')];
    const bad = pdu({
      type: 'm.room.member',
      event_id: '$empty-mem',
      sender: '@alice:example.com',
      state_key: '@alice:example.com',
      content: { membership: '' },
    });
    expect(checkEventAuth(bad, state, '10').error).toMatch(/Missing membership/);
  });

  it('allows non-integer user power levels on v9 (integerPowerLevels false)', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    const change = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl2',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 100, '@bob:example.com': 50.5 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
    });
    expect(checkEventAuth(change, state, '9').allowed).toBe(true);
  });

  it('allows self power level changes that stay equal to sender power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 50 }),
    ];
    const change = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl2',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 50 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
    });
    expect(checkEventAuth(change, state, '10').allowed).toBe(true);
  });

  it('does not gate notifications.room via checkLevel (documents current gap)', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 50 }),
    ];
    const change = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl2',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 50 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
        notifications: { room: 80 },
      },
    });
    expect(checkEventAuth(change, state, '10').allowed).toBe(true);
  });

  it('allows invites when power levels are absent (invite defaults to 0)', () => {
    const state = [createEvent(), memberEvent('@alice:example.com', 'join')];
    const invite = memberEvent('@bob:example.com', 'invite', '@alice:example.com');
    expect(checkEventAuth(invite, state, '10').allowed).toBe(true);
  });

  it('rejects state events when events override exceeds sender power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 100 },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 0,
          events: { 'm.room.name': 80 },
        },
      }),
    ];
    const name = pdu({
      type: 'm.room.name',
      event_id: '$name',
      sender: '@bob:example.com',
      state_key: '',
      content: { name: 'Nope' },
    });
    expect(checkEventAuth(name, state, '10').error).toMatch(/Insufficient power level/);
  });

  it('rejects self-leave from knock on v6 where knocking is unsupported', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'knock'),
    ];
    const leave = memberEvent('@bob:example.com', 'leave');
    expect(checkEventAuth(leave, state, '6').error).toMatch(/Not a member of the room/);
  });
});
