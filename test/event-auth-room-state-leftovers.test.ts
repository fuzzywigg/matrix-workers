/**
 * TOKENMAXX HEAVY leftovers — event-auth power-level / state_key / redaction edges.
 * Complements event-auth.test.ts (already deep). Orthogonal to oauth/voip/spaces/
 * keys-media/admin-fed/login-qr leftovers themes.
 * Focus: PL field matrix edges, state_key collisions in buildStateMap, redaction Rule 7.
 * Tests-only — no product inventing. Fixtures use example.com only.
 */
import { describe, expect, it } from 'vitest';
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

function powerLevels(
  users: Record<string, number>,
  extra: Record<string, unknown> = {}
): PDU {
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
      ...extra,
    },
  });
}

const ALICE = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';

describe('event-auth leftovers — buildStateMap state_key collisions', () => {
  it('last write wins for identical (type, state_key)', () => {
    const a = pdu({
      type: 'm.room.name',
      event_id: '$a',
      sender: ALICE,
      state_key: '',
      content: { name: 'a' },
    });
    const b = pdu({
      type: 'm.room.name',
      event_id: '$b',
      sender: ALICE,
      state_key: '',
      content: { name: 'b' },
    });
    const map = buildStateMap([a, b]);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe('$b');
    expect(map.size).toBe(1);
  });

  it('keeps distinct member state_keys as separate slots', () => {
    const map = buildStateMap([
      createEvent(),
      memberEvent(ALICE, 'join'),
      memberEvent(BOB, 'join'),
      memberEvent(CAROL, 'invite', ALICE),
    ]);
    expect(map.size).toBe(4);
    expect(map.get(stateKey('m.room.member', CAROL))?.content).toEqual({
      membership: 'invite',
    });
  });

  it('treats empty string state_key as distinct from omitted state_key', () => {
    const withKey = pdu({
      type: 'm.room.message',
      event_id: '$with',
      sender: ALICE,
      state_key: '',
      content: { body: 'x', msgtype: 'm.text' },
    });
    const without = pdu({
      type: 'm.room.message',
      event_id: '$without',
      sender: ALICE,
      content: { body: 'y', msgtype: 'm.text' },
    });
    const map = buildStateMap([withKey, without]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.message', ''))?.event_id).toBe('$with');
  });

  it('stateKey separator is a null byte (not pipe/colon)', () => {
    expect(stateKey('m.room.member', ALICE)).toBe(`m.room.member\0${ALICE}`);
    expect(stateKey('a', 'b').includes('|')).toBe(false);
  });
});

describe('event-auth leftovers — redaction Rule 7 PL edges', () => {
  it('allows redaction at exact redact threshold for non-own events (auth layer)', () => {
    const state = [createEvent(), memberEvent(ALICE, 'join'), powerLevels({ [ALICE]: 50 })];
    const redaction = pdu({
      type: 'm.room.redaction',
      event_id: '$r',
      sender: ALICE,
      content: { redacts: '$t' },
      redacts: '$t',
    });
    expect(checkEventAuth(redaction, state, '10').allowed).toBe(true);
  });

  it('rejects redaction one below redact threshold with exact error', () => {
    const state = [createEvent(), memberEvent(ALICE, 'join'), powerLevels({ [ALICE]: 49 })];
    const redaction = pdu({
      type: 'm.room.redaction',
      event_id: '$r',
      sender: ALICE,
      content: { redacts: '$t' },
      redacts: '$t',
    });
    expect(checkEventAuth(redaction, state, '10')).toEqual({
      allowed: false,
      error: 'Insufficient power level to redact (have 49, need 50)',
    });
  });

  it('uses custom redact threshold from PL content', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 80 }, { redact: 100 }),
    ];
    const redaction = pdu({
      type: 'm.room.redaction',
      event_id: '$r',
      sender: ALICE,
      content: { redacts: '$t' },
    });
    expect(checkEventAuth(redaction, state, '10').error).toBe(
      'Insufficient power level to redact (have 80, need 100)'
    );
  });

  it('defaults redact to 50 when PL omits redact field', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        sender: ALICE,
        state_key: '',
        content: { users: { [BOB]: 49 } },
      }),
    ];
    const redaction = pdu({
      type: 'm.room.redaction',
      event_id: '$r',
      sender: BOB,
      content: { redacts: '$t' },
    });
    expect(checkEventAuth(redaction, state, '10').error).toMatch(/need 50/);
  });

  it('rejects redaction from non-joined sender before PL check', () => {
    const state = [createEvent(), memberEvent(ALICE, 'join'), powerLevels({ [ALICE]: 100 })];
    const redaction = pdu({
      type: 'm.room.redaction',
      event_id: '$r',
      sender: BOB,
      content: { redacts: '$t' },
    });
    expect(checkEventAuth(redaction, state, '10').error).toBe('Sender is not joined to the room');
  });
});

describe('event-auth leftovers — state event PL edges', () => {
  it('pins exact have/need error for state_default gate', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 40 }),
    ];
    const name = pdu({
      type: 'm.room.name',
      event_id: '$n',
      sender: BOB,
      state_key: '',
      content: { name: 'x' },
    });
    expect(checkEventAuth(name, state, '10')).toEqual({
      allowed: false,
      error: 'Insufficient power level for m.room.name (have 40, need 50)',
    });
  });

  it('allows state at exact state_default', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 50 }),
    ];
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.topic',
          event_id: '$t',
          sender: BOB,
          state_key: '',
          content: { topic: 'ok' },
        }),
        state,
        '10'
      ).allowed
    ).toBe(true);
  });

  it('honors events[] override above state_default', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 60 }, { events: { 'm.room.name': 75 } }),
    ];
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.name',
          event_id: '$n',
          sender: BOB,
          state_key: '',
          content: { name: 'x' },
        }),
        state,
        '10'
      ).error
    ).toBe('Insufficient power level for m.room.name (have 60, need 75)');
  });

  it('honors events[] override below state_default', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 10 }, { events: { 'm.room.topic': 10 } }),
    ];
    expect(
      checkEventAuth(
        pdu({
          type: 'm.room.topic',
          event_id: '$t',
          sender: BOB,
          state_key: '',
          content: { topic: 'ok' },
        }),
        state,
        '10'
      ).allowed
    ).toBe(true);
  });

  it('rejects PL events map escalation above sender power', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 50 }),
    ];
    const pl = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl2',
      sender: ALICE,
      state_key: '',
      content: {
        users: { [ALICE]: 50 },
        events: { 'm.room.name': 51 },
      },
    });
    expect(checkEventAuth(pl, state, '10').error).toBe(
      'Cannot set power level higher than own (50)'
    );
  });

  it('allows PL events map values equal to sender power', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 50 }),
    ];
    const pl = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl2',
      sender: ALICE,
      state_key: '',
      content: {
        users: { [ALICE]: 50 },
        events: { 'm.room.name': 50, 'm.room.topic': 50 },
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
      },
    });
    expect(checkEventAuth(pl, state, '10').allowed).toBe(true);
  });
});

describe('event-auth leftovers — redact threshold soft flood', () => {
  it('redact PL soft-0: have=0 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 0 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r0',
        sender: ALICE,
        content: { redacts: '$t0' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('redact PL soft-1: have=5 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 5 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r1',
        sender: ALICE,
        content: { redacts: '$t1' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('redact PL soft-2: have=10 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 10 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r2',
        sender: ALICE,
        content: { redacts: '$t2' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('redact PL soft-3: have=15 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 15 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r3',
        sender: ALICE,
        content: { redacts: '$t3' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('redact PL soft-4: have=20 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 20 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r4',
        sender: ALICE,
        content: { redacts: '$t4' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('redact PL soft-5: have=25 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 25 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r5',
        sender: ALICE,
        content: { redacts: '$t5' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('redact PL soft-6: have=30 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 30 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r6',
        sender: ALICE,
        content: { redacts: '$t6' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('redact PL soft-7: have=35 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 35 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r7',
        sender: ALICE,
        content: { redacts: '$t7' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('redact PL soft-8: have=40 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 40 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r8',
        sender: ALICE,
        content: { redacts: '$t8' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('redact PL soft-9: have=45 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 45 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r9',
        sender: ALICE,
        content: { redacts: '$t9' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('redact PL soft-10: have=50 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 50 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r10',
        sender: ALICE,
        content: { redacts: '$t10' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('redact PL soft-11: have=55 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 55 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r11',
        sender: ALICE,
        content: { redacts: '$t11' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('redact PL soft-12: have=60 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 60 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r12',
        sender: ALICE,
        content: { redacts: '$t12' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('redact PL soft-13: have=65 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 65 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r13',
        sender: ALICE,
        content: { redacts: '$t13' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('redact PL soft-14: have=70 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 70 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r14',
        sender: ALICE,
        content: { redacts: '$t14' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('redact PL soft-15: have=75 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 75 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r15',
        sender: ALICE,
        content: { redacts: '$t15' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('redact PL soft-16: have=80 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 80 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r16',
        sender: ALICE,
        content: { redacts: '$t16' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('redact PL soft-17: have=85 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 85 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r17',
        sender: ALICE,
        content: { redacts: '$t17' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('redact PL soft-18: have=90 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 90 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r18',
        sender: ALICE,
        content: { redacts: '$t18' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('redact PL soft-19: have=95 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 95 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r19',
        sender: ALICE,
        content: { redacts: '$t19' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('redact PL soft-20: have=100 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 100 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r20',
        sender: ALICE,
        content: { redacts: '$t20' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('redact PL soft-21: have=105 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 105 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r21',
        sender: ALICE,
        content: { redacts: '$t21' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('redact PL soft-22: have=110 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 110 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r22',
        sender: ALICE,
        content: { redacts: '$t22' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('redact PL soft-23: have=115 need=50', () => {
    const state = [
      createEvent(),
      memberEvent(ALICE, 'join'),
      powerLevels({ [ALICE]: 115 }, { redact: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.redaction',
        event_id: '$r23',
        sender: ALICE,
        content: { redacts: '$t23' },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
});

describe('event-auth leftovers — state_default soft flood', () => {
  it('state_default soft-0: m.room.name have=45', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 45 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.name',
        event_id: '$e0',
        sender: BOB,
        state_key: '',
        content: { v: 0 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-1: m.room.topic have=46', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 46 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.topic',
        event_id: '$e1',
        sender: BOB,
        state_key: '',
        content: { v: 1 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-2: m.room.avatar have=47', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 47 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.avatar',
        event_id: '$e2',
        sender: BOB,
        state_key: '',
        content: { v: 2 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-3: m.room.guest_access have=48', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 48 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.guest_access',
        event_id: '$e3',
        sender: BOB,
        state_key: '',
        content: { v: 3 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-4: org.example.x have=49', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 49 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'org.example.x',
        event_id: '$e4',
        sender: BOB,
        state_key: '',
        content: { v: 4 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-5: m.room.name have=50', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.name',
        event_id: '$e5',
        sender: BOB,
        state_key: '',
        content: { v: 5 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('state_default soft-6: m.room.topic have=51', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 51 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.topic',
        event_id: '$e6',
        sender: BOB,
        state_key: '',
        content: { v: 6 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('state_default soft-7: m.room.avatar have=52', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 52 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.avatar',
        event_id: '$e7',
        sender: BOB,
        state_key: '',
        content: { v: 7 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('state_default soft-8: m.room.guest_access have=53', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 53 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.guest_access',
        event_id: '$e8',
        sender: BOB,
        state_key: '',
        content: { v: 8 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('state_default soft-9: org.example.x have=54', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 54 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'org.example.x',
        event_id: '$e9',
        sender: BOB,
        state_key: '',
        content: { v: 9 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('state_default soft-10: m.room.name have=45', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 45 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.name',
        event_id: '$e10',
        sender: BOB,
        state_key: '',
        content: { v: 10 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-11: m.room.topic have=46', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 46 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.topic',
        event_id: '$e11',
        sender: BOB,
        state_key: '',
        content: { v: 11 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-12: m.room.avatar have=47', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 47 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.avatar',
        event_id: '$e12',
        sender: BOB,
        state_key: '',
        content: { v: 12 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-13: m.room.guest_access have=48', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 48 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.guest_access',
        event_id: '$e13',
        sender: BOB,
        state_key: '',
        content: { v: 13 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-14: org.example.x have=49', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 49 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'org.example.x',
        event_id: '$e14',
        sender: BOB,
        state_key: '',
        content: { v: 14 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-15: m.room.name have=50', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 50 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.name',
        event_id: '$e15',
        sender: BOB,
        state_key: '',
        content: { v: 15 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('state_default soft-16: m.room.topic have=51', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 51 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.topic',
        event_id: '$e16',
        sender: BOB,
        state_key: '',
        content: { v: 16 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('state_default soft-17: m.room.avatar have=52', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 52 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.avatar',
        event_id: '$e17',
        sender: BOB,
        state_key: '',
        content: { v: 17 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('state_default soft-18: m.room.guest_access have=53', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 53 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.guest_access',
        event_id: '$e18',
        sender: BOB,
        state_key: '',
        content: { v: 18 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('state_default soft-19: org.example.x have=54', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 54 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'org.example.x',
        event_id: '$e19',
        sender: BOB,
        state_key: '',
        content: { v: 19 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(true);
  });
  it('state_default soft-20: m.room.name have=45', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 45 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.name',
        event_id: '$e20',
        sender: BOB,
        state_key: '',
        content: { v: 20 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-21: m.room.topic have=46', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 46 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.topic',
        event_id: '$e21',
        sender: BOB,
        state_key: '',
        content: { v: 21 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-22: m.room.avatar have=47', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 47 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.avatar',
        event_id: '$e22',
        sender: BOB,
        state_key: '',
        content: { v: 22 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-23: m.room.guest_access have=48', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 48 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'm.room.guest_access',
        event_id: '$e23',
        sender: BOB,
        state_key: '',
        content: { v: 23 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
  it('state_default soft-24: org.example.x have=49', () => {
    const state = [
      createEvent(),
      memberEvent(BOB, 'join'),
      powerLevels({ [ALICE]: 100, [BOB]: 49 }),
    ];
    const result = checkEventAuth(
      pdu({
        type: 'org.example.x',
        event_id: '$e24',
        sender: BOB,
        state_key: '',
        content: { v: 24 },
      }),
      state,
      '10'
    );
    expect(result.allowed).toBe(false);
  });
});

describe('event-auth leftovers — buildStateMap collision soft flood', () => {
  it('collision soft-0', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-0-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-0-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-0-4`);
  });
  it('collision soft-1', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-1-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-1-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-1-4`);
  });
  it('collision soft-2', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-2-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-2-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-2-4`);
  });
  it('collision soft-3', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-3-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-3-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-3-4`);
  });
  it('collision soft-4', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-4-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-4-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-4-4`);
  });
  it('collision soft-5', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-5-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-5-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-5-4`);
  });
  it('collision soft-6', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-6-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-6-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-6-4`);
  });
  it('collision soft-7', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-7-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-7-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-7-4`);
  });
  it('collision soft-8', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-8-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-8-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-8-4`);
  });
  it('collision soft-9', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-9-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-9-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-9-4`);
  });
  it('collision soft-10', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-10-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-10-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-10-4`);
  });
  it('collision soft-11', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-11-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-11-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-11-4`);
  });
  it('collision soft-12', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-12-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-12-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-12-4`);
  });
  it('collision soft-13', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-13-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-13-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-13-4`);
  });
  it('collision soft-14', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-14-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-14-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-14-4`);
  });
  it('collision soft-15', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-15-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-15-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-15-4`);
  });
  it('collision soft-16', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-16-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-16-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-16-4`);
  });
  it('collision soft-17', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-17-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-17-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-17-4`);
  });
  it('collision soft-18', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-18-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-18-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-18-4`);
  });
  it('collision soft-19', () => {
    const events = [];
    for (let j = 0; j < 5; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$n-19-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-19-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-19-4`);
  });
});
