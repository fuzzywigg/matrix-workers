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

describe('event-auth TOKENMAXX edge paths after #53', () => {
  it('allows knocking while currently invited (only ban/join block knock)', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
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

  it('allows knocking with no prior membership on a knock room', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'knock' },
      }),
    ];
    expect(checkEventAuth(memberEvent('@carol:example.com', 'knock'), state, '10').allowed).toBe(
      true
    );
  });

  it('allows inviting a user who is currently knocking', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'knock'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'invite', '@alice:example.com'), state, '10')
        .allowed
    ).toBe(true);
  });

  it('rejects self-leave while banned', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'ban', '@alice:example.com'),
    ];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'leave'), state, '10').error).toMatch(
      /Not a member of the room/
    );
  });

  it('allows kicking a target with no membership when sender has kick power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(memberEvent('@ghost:example.com', 'leave', '@alice:example.com'), state, '10')
        .allowed
    ).toBe(true);
  });
});


describe('event-auth TOKENMAXX edge paths after #54', () => {
  it('rejects create events with omitted state_key (undefined !== empty string)', () => {
    const create = pdu({
      type: 'm.room.create',
      event_id: '$nocreatekey',
      sender: '@alice:example.com',
      prev_events: [],
      depth: 0,
      content: { creator: '@alice:example.com', room_version: '10' },
    });
    // intentionally omit state_key
    delete (create as { state_key?: string }).state_key;
    expect(checkEventAuth(create, []).error).toMatch(/empty state_key/);
  });

  it('allows re-join after leave on a public room', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'leave'),
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

  it('rejects re-join after leave when join_rule defaults to invite', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'leave'),
    ];
    expect(checkEventAuth(memberEvent('@bob:example.com', 'join'), state, '10').error).toMatch(
      /Not authorized to join/
    );
  });

  it('allows inviting a user who is already invited', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'invite', '@alice:example.com'), state, '10')
        .allowed
    ).toBe(true);
  });

  it('allows kicking and banning an invited target with sufficient power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'leave', '@alice:example.com'), state, '10')
        .allowed
    ).toBe(true);
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'ban', '@alice:example.com'), state, '10')
        .allowed
    ).toBe(true);
  });

  it('rejects first power_levels that set users_default above the sender level', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 50 }),
    ];
    const pl = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl2',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 50 },
        users_default: 60,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
    });
    expect(checkEventAuth(pl, state, '10').error).toMatch(/higher than own/);
  });

  it('allows lowering another user PL when sender power is strictly greater than old level', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100, '@bob:example.com': 50 }),
    ];
    const pl = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl3',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 100, '@bob:example.com': 20 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
    });
    expect(checkEventAuth(pl, state, '10').allowed).toBe(true);
  });
});


describe('checkEventAuth TOKENMAXX edge paths after #55', () => {
  it('rejects unknown membership values via the default arm', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    for (const membership of ['joined', 'foo'] as const) {
      const ev = pdu({
        type: 'm.room.member',
        event_id: `$bad-${membership}`,
        sender: '@alice:example.com',
        state_key: '@bob:example.com',
        content: { membership },
      });
      expect(checkEventAuth(ev, state, '10').error).toBe(`Unknown membership: ${membership}`);
    }
  });

  it('rejects restricted joins when the authorizer is invited but not joined', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'restricted' },
      }),
      powerLevels({ '@alice:example.com': 100, '@bob:example.com': 50 }),
    ];
    const join = pdu({
      type: 'm.room.member',
      event_id: '$join',
      sender: '@carol:example.com',
      state_key: '@carol:example.com',
      content: {
        membership: 'join',
        join_authorised_via_users_server: '@bob:example.com',
      },
    });
    expect(checkEventAuth(join, state, '10').error).toMatch(/Not authorized to join/);
  });

  it('rejects self-ban when sender power equals target power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(memberEvent('@alice:example.com', 'ban', '@alice:example.com'), state, '10')
        .error
    ).toMatch(/Cannot ban user with equal or higher power/);
  });

  it('rejects message sends from invited (non-joined) senders', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
    ];
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.message',
          event_id: '$msg',
          sender: '@bob:example.com',
          content: { msgtype: 'm.text', body: 'hi' },
        }),
        state,
        '10'
      ).error
    ).toMatch(/not joined/i);
  });

  it('allows restricted joins when authorizer invite PL equals the invite threshold', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'restricted' },
      }),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 100, '@bob:example.com': 50 },
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
    const join = pdu({
      type: 'm.room.member',
      event_id: '$join',
      sender: '@carol:example.com',
      state_key: '@carol:example.com',
      content: {
        membership: 'join',
        join_authorised_via_users_server: '@bob:example.com',
      },
    });
    expect(checkEventAuth(join, state, '10').allowed).toBe(true);
  });
});


describe('checkEventAuth TOKENMAXX edge paths after #57', () => {
  it('rejects PL updates that raise invite above the sender power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 50 }),
    ];
    const pl = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-invite',
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
        invite: 60,
      },
    });
    expect(checkEventAuth(pl, state, '10').error).toMatch(/higher than own/);
  });

  it('rejects first PL write when no prior PL exists (sender defaults to 0 < state_default 50)', () => {
    const state = [createEvent(), memberEvent('@alice:example.com', 'join')];
    const pl = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-first',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 100, '@bob:example.com': 10 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
    });
    expect(checkEventAuth(pl, state, '10').error).toMatch(
      /Insufficient power level for m\.room\.power_levels \(have 0, need 50\)/
    );
  });

  it('allows lowering a user from implicit users_default when currentPl.users omits them', () => {
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
        },
      }),
    ];
    const pl = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl2',
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
        invite: 0,
      },
    });
    expect(checkEventAuth(pl, state, '10').allowed).toBe(true);
  });
});

describe('checkEventAuth TOKENMAXX leftovers after #82/#83 (PL field matrix)', () => {
  function basePlContent(overrides: Record<string, unknown> = {}) {
    return {
      users: { '@alice:example.com': 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      ...overrides,
    };
  }

  it('rejects PL updates that raise redact / state_default / users_default / invite above sender power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 50 }),
    ];
    for (const field of ['redact', 'state_default', 'users_default', 'invite'] as const) {
      const pl = pdu({
        type: 'm.room.power_levels',
        event_id: `$pl-${field}`,
        sender: '@alice:example.com',
        state_key: '',
        content: basePlContent({ [field]: 51 }),
      });
      expect(checkEventAuth(pl, state, '10').error).toBe(
        'Cannot set power level higher than own (50)'
      );
    }
  });

  it('rejects PL updates that raise ban / kick / events_default above sender power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    for (const field of ['ban', 'kick', 'events_default'] as const) {
      const pl = pdu({
        type: 'm.room.power_levels',
        event_id: `$pl-${field}`,
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
          [field]: 101,
        },
      });
      expect(checkEventAuth(pl, state, '10').error).toBe(
        'Cannot set power level higher than own (100)'
      );
    }
  });

  it('allows PL content fields and events map values exactly equal to sender power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 80 }),
    ];
    for (const field of [
      'ban',
      'kick',
      'redact',
      'invite',
      'events_default',
      'state_default',
      'users_default',
    ] as const) {
      const pl = pdu({
        type: 'm.room.power_levels',
        event_id: `$pl-eq-${field}`,
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 80 },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 0,
          [field]: 80,
        },
      });
      expect(checkEventAuth(pl, state, '10').allowed).toBe(true);
    }
    const eventsEq = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-eq-events',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 80 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
        events: { 'm.room.name': 80, 'm.room.topic': 0 },
      },
    });
    expect(checkEventAuth(eventsEq, state, '10').allowed).toBe(true);
  });

  it('rejects v10+ non-integer values in the events map (distinct from users map float)', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    const floatEvents = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-float-events',
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
        events: { 'm.room.name': 50.5 },
      },
    });
    expect(checkEventAuth(floatEvents, state, '10').error).toBe(
      'Power levels must be integers in this room version'
    );
  });

  it('pins exact Cannot set user … higher than own error for users map escalation', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 50 }),
    ];
    const pl = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-user-hi',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 50, '@bob:example.com': 51 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
    });
    expect(checkEventAuth(pl, state, '10').error).toBe(
      'Cannot set user @bob:example.com power level higher than own (50)'
    );
  });

  it('pins exact Cannot change power of equal-or-higher peer in users map', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      powerLevels({ '@alice:example.com': 50, '@bob:example.com': 50 }),
    ];
    const pl = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-peer',
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
    expect(checkEventAuth(pl, state, '10').error).toBe(
      'Cannot change power of user with equal or higher power'
    );
  });

  it('allows sender to lower their own users-map power level', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    const pl = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-self-down',
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
    expect(checkEventAuth(pl, state, '10').allowed).toBe(true);
  });

  it('allows setting a lower-power peer when sender strictly outranks their old level', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100, '@bob:example.com': 20 }),
    ];
    const pl = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-peer-ok',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 100, '@bob:example.com': 30 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
    });
    expect(checkEventAuth(pl, state, '10').allowed).toBe(true);
  });

  it('rejects changing a peer whose old level equals sender power (users_default fallback)', () => {
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
          users: { '@alice:example.com': 50 },
          users_default: 50,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 0,
        },
      }),
    ];
    const pl = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl2',
      sender: '@alice:example.com',
      state_key: '',
      content: {
        users: { '@alice:example.com': 50, '@bob:example.com': 0 },
        users_default: 50,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
    });
    expect(checkEventAuth(pl, state, '10').error).toBe(
      'Cannot change power of user with equal or higher power'
    );
  });
});

describe('checkEventAuth TOKENMAXX leftovers after #82/#83 (membership exact errors)', () => {
  it('pins exact Cannot invite banned user and User is already joined errors', () => {
    const base = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
        [...base, memberEvent('@bob:example.com', 'ban', '@alice:example.com')],
        '10'
      ).error
    ).toBe('Cannot invite banned user');
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
        [...base, memberEvent('@bob:example.com', 'join')],
        '10'
      ).error
    ).toBe('User is already joined');
  });

  it('pins exact Insufficient power level to kick when below kick threshold', () => {
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
      checkEventAuth(
        memberEvent('@carol:example.com', 'leave', '@bob:example.com'),
        state,
        '10'
      ).error
    ).toBe('Insufficient power level to kick');
  });

  it('pins exact Cannot kick user with equal or higher power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      powerLevels({ '@alice:example.com': 50, '@bob:example.com': 50 }),
    ];
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'leave', '@alice:example.com'),
        state,
        '10'
      ).error
    ).toBe('Cannot kick user with equal or higher power');
  });

  it('pins exact Insufficient power level to unban', () => {
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
      checkEventAuth(
        memberEvent('@carol:example.com', 'leave', '@bob:example.com'),
        state,
        '10'
      ).error
    ).toBe('Insufficient power level to unban');
  });

  it('allows unban when sender meets ban threshold exactly', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@mod:example.com', 'join'),
      memberEvent('@bob:example.com', 'ban', '@alice:example.com'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 100, '@mod:example.com': 50 },
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
      checkEventAuth(
        memberEvent('@bob:example.com', 'leave', '@mod:example.com'),
        state,
        '10'
      ).allowed
    ).toBe(true);
  });

  it('allows banning a never-membered target and an invited target', () => {
    const base = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.member',
          event_id: '$ban-stranger',
          sender: '@alice:example.com',
          state_key: '@stranger:example.com',
          content: { membership: 'ban' },
        }),
        base,
        '10'
      ).allowed
    ).toBe(true);
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'ban', '@alice:example.com'),
        [...base, memberEvent('@bob:example.com', 'invite', '@alice:example.com')],
        '10'
      ).allowed
    ).toBe(true);
  });

  it('allows kicking a knocking target and an invited target with kick power', () => {
    const base = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'leave', '@alice:example.com'),
        [...base, memberEvent('@bob:example.com', 'knock')],
        '10'
      ).allowed
    ).toBe(true);
    expect(
      checkEventAuth(
        memberEvent('@carol:example.com', 'leave', '@alice:example.com'),
        [...base, memberEvent('@carol:example.com', 'invite', '@alice:example.com')],
        '10'
      ).allowed
    ).toBe(true);
  });

  it('pins exact knock errors: on-behalf, wrong join_rule, already joined, banned', () => {
    const knockRules = pdu({
      type: 'm.room.join_rules',
      event_id: '$jr',
      sender: '@alice:example.com',
      state_key: '',
      content: { join_rule: 'knock' },
    });
    const inviteRules = pdu({
      type: 'm.room.join_rules',
      event_id: '$jr-invite',
      sender: '@alice:example.com',
      state_key: '',
      content: { join_rule: 'invite' },
    });
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'knock', '@alice:example.com'),
        [createEvent(), knockRules],
        '10'
      ).error
    ).toBe('Cannot knock on behalf of another user');
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'knock'), [createEvent(), inviteRules], '10')
        .error
    ).toBe('Room does not allow knocking');
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'knock'),
        [createEvent(), knockRules, memberEvent('@bob:example.com', 'join')],
        '10'
      ).error
    ).toBe('Already joined');
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'knock'),
        [
          createEvent(),
          knockRules,
          memberEvent('@bob:example.com', 'ban', '@alice:example.com'),
        ],
        '10'
      ).error
    ).toBe('Banned users cannot knock');
  });

  it('allows public re-join after leave; documents public re-join after ban is currently allowed', () => {
    const joinRules = pdu({
      type: 'm.room.join_rules',
      event_id: '$jr',
      sender: '@alice:example.com',
      state_key: '',
      content: { join_rule: 'public' },
    });
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'join'),
        [createEvent(), joinRules, memberEvent('@bob:example.com', 'leave')],
        '10'
      ).allowed
    ).toBe(true);
    // Spec ideally rejects banned users; this implementation only special-cases join/invite
    // before falling through to public join_rule — document the current gap.
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'join'),
        [
          createEvent(),
          joinRules,
          memberEvent('@bob:example.com', 'ban', '@alice:example.com'),
        ],
        '10'
      ).allowed
    ).toBe(true);
  });

  it('rejects invite-only join when prior membership is leave', () => {
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'join'),
        [createEvent(), memberEvent('@bob:example.com', 'leave')],
        '10'
      ).error
    ).toBe('Not authorized to join');
  });

  it('rejects restricted join when authorizer lacks invite power or is not joined', () => {
    const joinRules = pdu({
      type: 'm.room.join_rules',
      event_id: '$jr',
      sender: '@alice:example.com',
      state_key: '',
      content: { join_rule: 'restricted' },
    });
    const lowInvite = pdu({
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
    });
    const joinLow = memberEvent('@carol:example.com', 'join');
    joinLow.content = {
      membership: 'join',
      join_authorised_via_users_server: '@bob:example.com',
    };
    expect(
      checkEventAuth(
        joinLow,
        [
          createEvent(),
          joinRules,
          lowInvite,
          memberEvent('@alice:example.com', 'join'),
          memberEvent('@bob:example.com', 'join'),
        ],
        '10'
      ).error
    ).toBe('Not authorized to join');

    const joinNotJoined = memberEvent('@carol:example.com', 'join');
    joinNotJoined.content = {
      membership: 'join',
      join_authorised_via_users_server: '@dave:example.com',
    };
    expect(
      checkEventAuth(
        joinNotJoined,
        [createEvent(), joinRules, memberEvent('@alice:example.com', 'join'), lowInvite],
        '10'
      ).error
    ).toBe('Not authorized to join');
  });
});

describe('checkEventAuth TOKENMAXX leftovers after #82/#83 (power/redact/state helpers)', () => {
  it('allows redaction at exact redact threshold and rejects one below', () => {
    const makeState = (modPower: number) => [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@mod:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 100, '@mod:example.com': modPower },
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
    const redaction = pdu({
      type: 'm.room.redaction',
      event_id: '$redact',
      sender: '@mod:example.com',
      content: { redacts: '$msg' },
    });
    expect(checkEventAuth(redaction, makeState(50), '10').allowed).toBe(true);
    expect(checkEventAuth(redaction, makeState(49), '10').error).toBe(
      'Insufficient power level to redact (have 49, need 50)'
    );
  });

  it('rejects state events at required−1 and allows at exact state_default', () => {
    const makeState = (bobPower: number) => [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 100, '@bob:example.com': bobPower },
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
    const name = pdu({
      type: 'm.room.name',
      event_id: '$name',
      sender: '@bob:example.com',
      state_key: '',
      content: { name: 'x' },
    });
    expect(checkEventAuth(name, makeState(49), '10').error).toBe(
      'Insufficient power level for m.room.name (have 49, need 50)'
    );
    expect(checkEventAuth(name, makeState(50), '10').allowed).toBe(true);
  });

  it('allows state events when events[] override is below sender power', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
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
          events: { 'm.room.topic': 30 },
        },
      }),
    ];
    const topic = pdu({
      type: 'm.room.topic',
      event_id: '$topic',
      sender: '@alice:example.com',
      state_key: '',
      content: { topic: 'hi' },
    });
    expect(checkEventAuth(topic, state, '10').allowed).toBe(true);
  });

  it('allows encrypted non-state events under default events_default and rejects when override is high', () => {
    const joined = [createEvent(), memberEvent('@alice:example.com', 'join')];
    const enc = pdu({
      type: 'm.room.encrypted',
      event_id: '$enc',
      sender: '@alice:example.com',
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' },
    });
    expect(checkEventAuth(enc, joined, '10').allowed).toBe(true);

    const gated = [
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
          events: { 'm.room.encrypted': 50 },
        },
      }),
    ];
    const encBob = pdu({
      type: 'm.room.encrypted',
      event_id: '$enc2',
      sender: '@bob:example.com',
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'y' },
    });
    expect(checkEventAuth(encBob, gated, '10').error).toBe(
      'Insufficient power level for m.room.encrypted (have 0, need 50)'
    );
  });

  it('allows third_party_invite at exact invite threshold and rejects one below', () => {
    const makeState = (alicePower: number, invite: number) => [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': alicePower },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite,
        },
      }),
    ];
    const tpi = pdu({
      type: 'm.room.third_party_invite',
      event_id: '$tpi',
      sender: '@alice:example.com',
      state_key: 'token',
      content: {
        display_name: 'x',
        key_validity_url: 'https://example.com',
        public_key: 'k',
      },
    });
    expect(checkEventAuth(tpi, makeState(50, 50), '10').allowed).toBe(true);
    expect(checkEventAuth(tpi, makeState(49, 50), '10').error).toBe(
      'Insufficient power level for third party invite'
    );
  });

  it('buildStateMap skips non-state events and keeps last duplicate state key', () => {
    const create = createEvent();
    const msg = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: '@alice:example.com',
      content: { body: 'x', msgtype: 'm.text' },
    });
    const name1 = pdu({
      type: 'm.room.name',
      event_id: '$n1',
      sender: '@alice:example.com',
      state_key: '',
      content: { name: 'a' },
    });
    const name2 = pdu({
      type: 'm.room.name',
      event_id: '$n2',
      sender: '@alice:example.com',
      state_key: '',
      content: { name: 'b' },
    });
    const map = buildStateMap([create, msg, name1, name2]);
    expect(map.has(stateKey('m.room.message', ''))).toBe(false);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe('$n2');
  });

  it('stateKey joins type and state_key with a null byte separator', () => {
    expect(stateKey('m.room.member', '@u:ex.com')).toBe('m.room.member\0@u:ex.com');
    expect(stateKey('m.room.name', '')).toBe('m.room.name\0');
    expect(stateKey('a', 'b').includes('\0')).toBe(true);
  });

  it('rejects non-state messages when sender has left despite high power levels', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'leave'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    const msg = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: '@alice:example.com',
      content: { body: 'hi', msgtype: 'm.text' },
    });
    expect(checkEventAuth(msg, state, '10').error).toBe('Sender is not joined to the room');
  });

  it('rejects ban when sender is not joined (exact error)', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'ban', '@eve:example.com'), state, '10')
        .error
    ).toBe('Sender must be joined to ban');
  });

  it('allows self-leave from invite; rejects leave with no membership', () => {
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'leave'),
        [createEvent(), memberEvent('@bob:example.com', 'invite', '@alice:example.com')],
        '10'
      ).allowed
    ).toBe(true);
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'leave'), [createEvent()], '10').error
    ).toBe('Not a member of the room');
  });

  it('pins exact Unknown membership error string', () => {
    const state = [createEvent(), memberEvent('@alice:example.com', 'join')];
    const bad = memberEvent('@bob:example.com', 'join');
    bad.content = { membership: 'wat' };
    expect(checkEventAuth(bad, state, '10').error).toBe('Unknown membership: wat');
  });

  it('uses default power levels when m.room.power_levels is absent (invite=0, ban/kick/redact=50)', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
    ];
    expect(
      checkEventAuth(
        memberEvent('@carol:example.com', 'invite', '@alice:example.com'),
        state,
        '10'
      ).allowed
    ).toBe(true);
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'ban', '@alice:example.com'),
        state,
        '10'
      ).error
    ).toBe('Insufficient power level to ban');
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'leave', '@alice:example.com'),
        state,
        '10'
      ).error
    ).toBe('Insufficient power level to kick');
  });
});

// ---------------------------------------------------------------------------
// TOKENMAXX HEAVY after #87 — second lane (not versions/well-known):
// soft→exact pins + room-version flag boundaries + sparse PL defaults
// ---------------------------------------------------------------------------

describe('checkEventAuth TOKENMAXX HEAVY after #87 (soft→exact leftover pins)', () => {
  it('pins exact create / version / missing-create error strings', () => {
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.create',
          event_id: '$c-prev',
          sender: '@alice:example.com',
          state_key: '',
          prev_events: ['$x'],
          content: { creator: '@alice:example.com', room_version: '10' },
        }),
        [],
        '10'
      ).error
    ).toBe('m.room.create must have no prev_events');

    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.create',
          event_id: '$c-sk',
          sender: '@alice:example.com',
          state_key: 'not-empty',
          prev_events: [],
          content: { creator: '@alice:example.com', room_version: '10' },
        }),
        [],
        '10'
      ).error
    ).toBe('m.room.create must have empty state_key');

    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.create',
          event_id: '$c-bare',
          sender: '@alice:example.com',
          state_key: '',
          prev_events: [],
          content: {},
        }),
        [],
        '10'
      ).error
    ).toBe('m.room.create must have creator or room_version');

    expect(
      checkEventAuth(memberEvent('@alice:example.com', 'join'), [], '10').error
    ).toBe('No m.room.create event in room state');

    expect(
      checkEventAuth(memberEvent('@alice:example.com', 'join'), [createEvent()], '99').error
    ).toBe('Unsupported room version: 99');
  });

  it('pins exact join-on-behalf / missing-membership / invite sender errors', () => {
    const publicState = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'public' },
      }),
    ];
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'join', '@eve:example.com'),
        publicState,
        '10'
      ).error
    ).toBe('Cannot join on behalf of another user');

    const missing = pdu({
      type: 'm.room.member',
      event_id: '$miss',
      sender: '@alice:example.com',
      state_key: '@bob:example.com',
      content: {},
    });
    expect(
      checkEventAuth(missing, [createEvent(), memberEvent('@alice:example.com', 'join')], '10')
        .error
    ).toBe('Missing membership in content');

    const inviteOnly = [createEvent(), memberEvent('@bob:example.com', 'invite', '@alice:example.com')];
    expect(
      checkEventAuth(
        memberEvent('@carol:example.com', 'invite', '@bob:example.com'),
        inviteOnly,
        '10'
      ).error
    ).toBe('Sender must be joined to invite');
  });

  it('pins exact invite PL threshold (±0 / −1) and knock-unsupported on v6', () => {
    const highInvite = [
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
          invite: 50,
        },
      }),
    ];
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
        highInvite,
        '10'
      ).allowed
    ).toBe(true);

    const below = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: '@alice:example.com',
        state_key: '',
        content: {
          users: { '@alice:example.com': 49 },
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
        memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
        below,
        '10'
      ).error
    ).toBe('Insufficient power level to invite');

    // createEvent content room_version is ignored; auth uses the roomVersion arg
    expect(
      checkEventAuth(
        memberEvent('@bob:example.com', 'knock'),
        [
          createEvent(),
          pdu({
            type: 'm.room.join_rules',
            event_id: '$jr',
            sender: '@alice:example.com',
            state_key: '',
            content: { join_rule: 'knock' },
          }),
        ],
        '6'
      ).error
    ).toBe('Knocking not supported in this room version');
  });
});

describe('checkEventAuth TOKENMAXX HEAVY after #87 (room-version + membership edges)', () => {
  function restrictedState(authorizer = '@alice:example.com') {
    return [
      createEvent(),
      memberEvent(authorizer, 'join'),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: authorizer,
        state_key: '',
        content: { join_rule: 'restricted' },
      }),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: authorizer,
        state_key: '',
        content: {
          users: { [authorizer]: 100 },
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
  }

  it('rejects restricted join on v7; allows same shape on v8 (restrictedJoinsSupported)', () => {
    const state = restrictedState();
    const join = pdu({
      type: 'm.room.member',
      event_id: '$join',
      sender: '@carol:example.com',
      state_key: '@carol:example.com',
      content: {
        membership: 'join',
        join_authorised_via_users_server: '@alice:example.com',
      },
    });
    expect(checkEventAuth(join, state, '7').error).toBe('Not authorized to join');
    expect(checkEventAuth(join, state, '8').allowed).toBe(true);
  });

  it('documents knock_restricted allow on v8 via restrictedJoinsSupported (not knockRestrictedSupported)', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        sender: '@alice:example.com',
        state_key: '',
        content: { join_rule: 'knock_restricted' },
      }),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    const join = pdu({
      type: 'm.room.member',
      event_id: '$join',
      sender: '@carol:example.com',
      state_key: '@carol:example.com',
      content: {
        membership: 'join',
        join_authorised_via_users_server: '@alice:example.com',
      },
    });
    // v8: knockRestrictedSupported=false but code gates only on restrictedJoinsSupported
    expect(checkEventAuth(join, state, '8').allowed).toBe(true);
    expect(checkEventAuth(join, state, '10').allowed).toBe(true);
  });

  it('rejects join while currently knocking (knock→join is not auto-allowed)', () => {
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
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'join'), state, '10').error
    ).toBe('Not authorized to join');
  });

  it('rejects float notifications.room on v11; allows float on v9', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      powerLevels({ '@alice:example.com': 100 }),
    ];
    const pl = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-notif',
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
        notifications: { room: 50.5 },
      },
    });
    expect(checkEventAuth(pl, state, '11').error).toBe(
      'Power levels must be integers in this room version'
    );
    expect(checkEventAuth(pl, state, '9').allowed).toBe(true);
  });

  it('uses sparse PL content ?? defaults (invite 0, ban/kick/state 50, events 0)', () => {
    const state = [
      createEvent(),
      memberEvent('@alice:example.com', 'join'),
      memberEvent('@bob:example.com', 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl-sparse',
        sender: '@alice:example.com',
        state_key: '',
        content: { users: { '@alice:example.com': 100 } },
      }),
    ];
    expect(
      checkEventAuth(
        memberEvent('@carol:example.com', 'invite', '@alice:example.com'),
        state,
        '10'
      ).allowed
    ).toBe(true);
    expect(
      checkEventAuth(memberEvent('@bob:example.com', 'ban', '@alice:example.com'), state, '10')
        .allowed
    ).toBe(true);
    // bob has implicit users_default 0 → cannot ban
    expect(
      checkEventAuth(memberEvent('@alice:example.com', 'ban', '@bob:example.com'), state, '10')
        .error
    ).toBe('Insufficient power level to ban');
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.name',
          event_id: '$name',
          sender: '@bob:example.com',
          state_key: '',
          content: { name: 'x' },
        }),
        state,
        '10'
      ).error
    ).toBe('Insufficient power level for m.room.name (have 0, need 50)');
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.message',
          event_id: '$msg',
          sender: '@bob:example.com',
          content: { msgtype: 'm.text', body: 'hi' },
        }),
        state,
        '10'
      ).allowed
    ).toBe(true);
  });

  it('documents Rule 4 ordering: third_party_invite never reaches Sender must be joined', () => {
    const state = [
      createEvent(),
      memberEvent('@bob:example.com', 'invite', '@alice:example.com'),
    ];
    const tpi = pdu({
      type: 'm.room.third_party_invite',
      event_id: '$tpi',
      sender: '@bob:example.com',
      state_key: 'token',
      content: { display_name: 'x' },
    });
    expect(checkEventAuth(tpi, state, '10').error).toBe('Sender is not joined to the room');
  });

  it('allows create with only creator (no room_version) and only room_version (no creator)', () => {
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.create',
          event_id: '$c1',
          sender: '@alice:example.com',
          state_key: '',
          prev_events: [],
          content: { creator: '@alice:example.com' },
        }),
        [],
        '10'
      ).allowed
    ).toBe(true);
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.create',
          event_id: '$c2',
          sender: '@alice:example.com',
          state_key: '',
          prev_events: [],
          content: { room_version: '10' },
        }),
        [],
        '10'
      ).allowed
    ).toBe(true);
  });
});
