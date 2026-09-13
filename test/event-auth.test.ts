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
});
