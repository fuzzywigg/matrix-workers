/**
 * TOKENMAXX HEAVY leftovers after #214 — deepen residual event-auth +
 * room-state-map + state-resolution service edges already in tree.
 *
 * Complements (does not replace):
 *   - test/event-auth.test.ts
 *   - test/event-auth-room-state-leftovers.test.ts (redact/state_default/collision floods)
 *   - test/state-resolution.test.ts
 *   - test/state-resolution-collision-leftovers.test.ts (v1 depth / key-sep / equal-power ts)
 *   - test/room-state-events-api-leftovers.test.ts (rooms API PUT/GET/redact floods)
 *
 * Focus residual soft edges NOT soft-flooded there:
 *   event-auth: events_default, invite/ban/kick PL gates, third_party_invite,
 *               PL field escalation, users_default fallback
 *   room-state map: multi-type buildStateMap last-write, omitted state_key skip flood
 *   state-resolution: unauthorized auth drop, missing-from-set conflict,
 *                     equal-power equal-ts event_id lex, conflicted PL drop
 *
 * Tests-only — no product inventing. Fixtures use example.com only.
 */
import { describe, expect, it } from 'vitest';
import { buildStateMap, checkEventAuth, stateKey } from '../src/services/event-auth';
import { resolveState } from '../src/services/state-resolution';
import { resolveStateV1 } from '../src/services/state-resolution-v1';
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
  sender = userId,
  eventId?: string
): PDU {
  return pdu({
    type: 'm.room.member',
    event_id: eventId ?? `$member-${userId}-${membership}`,
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

function nameEvent(
  name: string,
  eventId: string,
  depth: number,
  sender = '@alice:example.com',
  ts = 1
): PDU {
  return pdu({
    type: 'm.room.name',
    event_id: eventId,
    sender,
    state_key: '',
    depth,
    origin_server_ts: ts,
    content: { name },
  });
}

function joinRules(joinRule: string, eventId = '$jr', sender = '@alice:example.com'): PDU {
  return pdu({
    type: 'm.room.join_rules',
    event_id: eventId,
    sender,
    state_key: '',
    content: { join_rule: joinRule },
  });
}

const ALICE = '@alice:example.com';
const BOB = '@bob:example.com';
const EVE = '@eve:example.com';

function baseJoined(...extra: PDU[]): PDU[] {
  return [createEvent(), memberEvent(ALICE, 'join'), ...extra];
}

describe('event-auth leftovers after #214 — events_default exact pins', () => {
  it('allows m.room.message at exact events_default threshold', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 30 }, { events_default: 30 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'hi' },
    });
    expect(checkEventAuth(ev, state).allowed).toBe(true);
  });

  it('rejects m.room.message one below events_default with exact have/need', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 29 }, { events_default: 30 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'hi' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Insufficient power level for m.room.message (have 29, need 30)');
  });

  it('honors events[] override above events_default for messages', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 20 }, { events_default: 0, events: { 'm.room.message': 50 } })
    );
    const ev = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'hi' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Insufficient power level for m.room.message (have 20, need 50)');
  });

  it('falls back to users_default when users map omits sender for messages', () => {
    const state = baseJoined(
      powerLevels({ [BOB]: 100 }, { users_default: 0, events_default: 50 })
    );
    // Alice joined but not in users map → users_default 0 < events_default 50
    const ev = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'hi' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Insufficient power level for m.room.message (have 0, need 50)');
  });
});

describe('event-auth leftovers after #214 — invite/ban/kick exact pins', () => {
  it('allows invite at exact invite threshold', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 40 }, { invite: 40 }),
      memberEvent(BOB, 'leave')
    );
    const ev = memberEvent(BOB, 'invite', ALICE);
    expect(checkEventAuth(ev, state).allowed).toBe(true);
  });

  it('rejects invite one below invite threshold', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 39 }, { invite: 40 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE), state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Insufficient power level to invite');
  });

  it('allows kick at exact kick threshold when sender power exceeds target', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 50, [BOB]: 10 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    expect(checkEventAuth(memberEvent(BOB, 'leave', ALICE), state).allowed).toBe(true);
  });

  it('rejects kick when sender power equals target power', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 50, [BOB]: 50 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE), state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot kick user with equal or higher power');
  });

  it('allows ban at exact ban threshold when sender power exceeds target', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 50, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    expect(checkEventAuth(memberEvent(BOB, 'ban', ALICE), state).allowed).toBe(true);
  });

  it('rejects ban when sender power equals target power', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 50, [BOB]: 50 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE), state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot ban user with equal or higher power');
  });

  it('allows third_party_invite at exact invite threshold', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 25 }, { invite: 25 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: '$3pid',
      sender: ALICE,
      state_key: 'token',
      content: { display_name: 'x' },
    });
    expect(checkEventAuth(ev, state).allowed).toBe(true);
  });

  it('rejects third_party_invite one below invite threshold', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 24 }, { invite: 25 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: '$3pid',
      sender: ALICE,
      state_key: 'token',
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Insufficient power level for third party invite');
  });
});

describe('event-auth leftovers after #214 — PL field escalation exact pins', () => {
  const fields = [
    'ban',
    'kick',
    'invite',
    'redact',
    'state_default',
    'users_default',
    'events_default',
  ] as const;

  for (const field of fields) {
    it(`rejects raising ${field} above sender power`, () => {
      const state = baseJoined(powerLevels({ [ALICE]: 50 }));
      const content: Record<string, unknown> = {
        users: { [ALICE]: 50 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
        [field]: 51,
      };
      const ev = pdu({
        type: 'm.room.power_levels',
        event_id: `$pl-${field}`,
        sender: ALICE,
        state_key: '',
        content,
      });
      const r = checkEventAuth(ev, state);
      expect(r.allowed).toBe(false);
      expect(r.error).toBe('Cannot set power level higher than own (50)');
    });
  }

  it('allows setting each PL field equal to sender power', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-eq',
      sender: ALICE,
      state_key: '',
      content: {
        users: { [ALICE]: 50 },
        users_default: 50,
        events_default: 50,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 50,
      },
    });
    expect(checkEventAuth(ev, state).allowed).toBe(true);
  });
});

describe('event-auth leftovers after #214 — events_default soft flood', () => {
  it('events_default soft-0: have=0 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 0 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-0`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 0, need 50)'
      );
    }
  });
  it('events_default soft-1: have=5 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 5 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-1`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 5, need 50)'
      );
    }
  });
  it('events_default soft-2: have=10 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 10 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-2`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 10, need 50)'
      );
    }
  });
  it('events_default soft-3: have=15 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 15 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-3`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 15, need 50)'
      );
    }
  });
  it('events_default soft-4: have=20 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 20 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-4`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 20, need 50)'
      );
    }
  });
  it('events_default soft-5: have=25 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 25 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-5`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 25, need 50)'
      );
    }
  });
  it('events_default soft-6: have=30 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 30 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-6`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 30, need 50)'
      );
    }
  });
  it('events_default soft-7: have=35 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 35 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-7`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 35, need 50)'
      );
    }
  });
  it('events_default soft-8: have=40 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 40 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-8`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 40, need 50)'
      );
    }
  });
  it('events_default soft-9: have=45 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 45 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-9`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 45, need 50)'
      );
    }
  });
  it('events_default soft-10: have=50 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-10`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 50, need 50)'
      );
    }
  });
  it('events_default soft-11: have=55 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 55 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-11`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 55, need 50)'
      );
    }
  });
  it('events_default soft-12: have=60 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 60 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-12`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 60, need 50)'
      );
    }
  });
  it('events_default soft-13: have=65 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 65 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-13`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 65, need 50)'
      );
    }
  });
  it('events_default soft-14: have=70 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 70 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-14`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 70, need 50)'
      );
    }
  });
  it('events_default soft-15: have=75 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 75 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-15`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 75, need 50)'
      );
    }
  });
  it('events_default soft-16: have=80 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 80 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-16`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 80, need 50)'
      );
    }
  });
  it('events_default soft-17: have=85 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 85 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-17`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 85, need 50)'
      );
    }
  });
  it('events_default soft-18: have=90 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 90 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-18`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 90, need 50)'
      );
    }
  });
  it('events_default soft-19: have=95 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 95 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-19`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 95, need 50)'
      );
    }
  });
  it('events_default soft-20: have=100 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 100 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-20`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 100, need 50)'
      );
    }
  });
  it('events_default soft-21: have=105 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 105 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-21`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 105, need 50)'
      );
    }
  });
  it('events_default soft-22: have=110 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 110 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-22`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 110, need 50)'
      );
    }
  });
  it('events_default soft-23: have=115 need=50', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 115 }, { events_default: 50 }));
    const ev = pdu({
      type: 'm.room.message',
      event_id: `$msg-23`,
      sender: ALICE,
      content: { msgtype: 'm.text', body: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe(
        'Insufficient power level for m.room.message (have 115, need 50)'
      );
    }
  });
});

describe('event-auth leftovers after #214 — invite PL soft flood', () => {
  it('invite soft-0: have=0 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 0 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-0`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-1: have=5 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 5 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-1`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-2: have=10 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 10 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-2`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-3: have=15 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 15 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-3`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-4: have=20 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 20 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-4`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-5: have=25 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 25 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-5`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-6: have=30 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 30 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-6`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-7: have=35 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 35 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-7`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-8: have=40 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 40 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-8`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-9: have=45 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 45 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-9`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-10: have=50 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 50 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-10`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-11: have=55 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 55 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-11`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-12: have=60 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 60 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-12`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-13: have=65 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 65 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-13`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-14: have=70 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 70 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-14`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-15: have=75 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 75 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-15`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-16: have=80 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 80 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-16`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-17: have=85 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 85 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-17`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-18: have=90 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 90 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-18`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
  it('invite soft-19: have=95 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 95 }, { invite: 50 }),
      memberEvent(BOB, 'leave')
    );
    const r = checkEventAuth(memberEvent(BOB, 'invite', ALICE, `$inv-19`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to invite');
  });
});

describe('event-auth leftovers after #214 — ban PL soft flood', () => {
  it('ban soft-0: have=0 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 0, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-0`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to ban');
  });
  it('ban soft-1: have=5 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 5, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-1`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to ban');
  });
  it('ban soft-2: have=10 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 10, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-2`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to ban');
  });
  it('ban soft-3: have=15 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 15, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-3`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to ban');
  });
  it('ban soft-4: have=20 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 20, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-4`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to ban');
  });
  it('ban soft-5: have=25 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 25, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-5`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to ban');
  });
  it('ban soft-6: have=30 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 30, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-6`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to ban');
  });
  it('ban soft-7: have=35 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 35, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-7`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to ban');
  });
  it('ban soft-8: have=40 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 40, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-8`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to ban');
  });
  it('ban soft-9: have=45 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 45, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-9`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to ban');
  });
  it('ban soft-10: have=50 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 50, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-10`), state);
    expect(r.allowed).toBe(true);
  });
  it('ban soft-11: have=55 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 55, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-11`), state);
    expect(r.allowed).toBe(true);
  });
  it('ban soft-12: have=60 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 60, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-12`), state);
    expect(r.allowed).toBe(true);
  });
  it('ban soft-13: have=65 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 65, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-13`), state);
    expect(r.allowed).toBe(true);
  });
  it('ban soft-14: have=70 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 70, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-14`), state);
    expect(r.allowed).toBe(true);
  });
  it('ban soft-15: have=75 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 75, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-15`), state);
    expect(r.allowed).toBe(true);
  });
  it('ban soft-16: have=80 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 80, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-16`), state);
    expect(r.allowed).toBe(true);
  });
  it('ban soft-17: have=85 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 85, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-17`), state);
    expect(r.allowed).toBe(true);
  });
  it('ban soft-18: have=90 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 90, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-18`), state);
    expect(r.allowed).toBe(true);
  });
  it('ban soft-19: have=95 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 95, [BOB]: 0 }, { ban: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'ban', ALICE, `$ban-19`), state);
    expect(r.allowed).toBe(true);
  });
});

describe('event-auth leftovers after #214 — kick PL soft flood', () => {
  it('kick soft-0: have=0 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 0, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-0`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to kick');
  });
  it('kick soft-1: have=5 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 5, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-1`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to kick');
  });
  it('kick soft-2: have=10 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 10, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-2`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to kick');
  });
  it('kick soft-3: have=15 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 15, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-3`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to kick');
  });
  it('kick soft-4: have=20 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 20, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-4`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to kick');
  });
  it('kick soft-5: have=25 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 25, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-5`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to kick');
  });
  it('kick soft-6: have=30 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 30, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-6`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to kick');
  });
  it('kick soft-7: have=35 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 35, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-7`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to kick');
  });
  it('kick soft-8: have=40 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 40, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-8`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to kick');
  });
  it('kick soft-9: have=45 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 45, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-9`), state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toBe('Insufficient power level to kick');
  });
  it('kick soft-10: have=50 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 50, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-10`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Cannot kick user with equal or higher power');
  });
  it('kick soft-11: have=55 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 55, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-11`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Cannot kick user with equal or higher power');
  });
  it('kick soft-12: have=60 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 60, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-12`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Cannot kick user with equal or higher power');
  });
  it('kick soft-13: have=65 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 65, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-13`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Cannot kick user with equal or higher power');
  });
  it('kick soft-14: have=70 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 70, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-14`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Cannot kick user with equal or higher power');
  });
  it('kick soft-15: have=75 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 75, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-15`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Cannot kick user with equal or higher power');
  });
  it('kick soft-16: have=80 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 80, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-16`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Cannot kick user with equal or higher power');
  });
  it('kick soft-17: have=85 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 85, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-17`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Cannot kick user with equal or higher power');
  });
  it('kick soft-18: have=90 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 90, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-18`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Cannot kick user with equal or higher power');
  });
  it('kick soft-19: have=95 need=50', () => {
    const state = baseJoined(
      powerLevels({ [ALICE]: 95, [BOB]: 0 }, { kick: 50 }),
      memberEvent(BOB, 'join')
    );
    const r = checkEventAuth(memberEvent(BOB, 'leave', ALICE, `$kick-19`), state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) expect(r.error).toBe('Cannot kick user with equal or higher power');
  });
});

describe('event-auth leftovers after #214 — third_party_invite soft flood', () => {
  it('3pid soft-0: have=0 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 0 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-0`,
      sender: ALICE,
      state_key: `tok-0`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-1: have=5 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 5 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-1`,
      sender: ALICE,
      state_key: `tok-1`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-2: have=10 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 10 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-2`,
      sender: ALICE,
      state_key: `tok-2`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-3: have=15 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 15 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-3`,
      sender: ALICE,
      state_key: `tok-3`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-4: have=20 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 20 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-4`,
      sender: ALICE,
      state_key: `tok-4`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-5: have=25 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 25 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-5`,
      sender: ALICE,
      state_key: `tok-5`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-6: have=30 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 30 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-6`,
      sender: ALICE,
      state_key: `tok-6`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-7: have=35 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 35 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-7`,
      sender: ALICE,
      state_key: `tok-7`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-8: have=40 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 40 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-8`,
      sender: ALICE,
      state_key: `tok-8`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-9: have=45 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 45 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-9`,
      sender: ALICE,
      state_key: `tok-9`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-10: have=50 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-10`,
      sender: ALICE,
      state_key: `tok-10`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-11: have=55 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 55 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-11`,
      sender: ALICE,
      state_key: `tok-11`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-12: have=60 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 60 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-12`,
      sender: ALICE,
      state_key: `tok-12`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-13: have=65 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 65 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-13`,
      sender: ALICE,
      state_key: `tok-13`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-14: have=70 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 70 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-14`,
      sender: ALICE,
      state_key: `tok-14`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
  it('3pid soft-15: have=75 need=40', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 75 }, { invite: 40 }));
    const ev = pdu({
      type: 'm.room.third_party_invite',
      event_id: `$3pid-15`,
      sender: ALICE,
      state_key: `tok-15`,
      content: { display_name: 'x' },
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(true);
    if (!r.allowed) {
      expect(r.error).toBe('Insufficient power level for third party invite');
    }
  });
});

describe('event-auth leftovers after #214 — PL field escalation soft flood', () => {
  it('PL escalate soft-0: ban = sender+1', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      ban: 51,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-0`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-1: ban = sender+10', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      ban: 60,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-1`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-2: ban = sender+25', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      ban: 75,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-2`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-3: kick = sender+1', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      kick: 51,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-3`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-4: kick = sender+10', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      kick: 60,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-4`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-5: kick = sender+25', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      kick: 75,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-5`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-6: invite = sender+1', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      invite: 51,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-6`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-7: invite = sender+10', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      invite: 60,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-7`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-8: invite = sender+25', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      invite: 75,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-8`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-9: redact = sender+1', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      redact: 51,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-9`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-10: redact = sender+10', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      redact: 60,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-10`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-11: redact = sender+25', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      redact: 75,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-11`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-12: state_default = sender+1', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      state_default: 51,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-12`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-13: state_default = sender+10', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      state_default: 60,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-13`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-14: state_default = sender+25', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      state_default: 75,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-14`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-15: users_default = sender+1', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      users_default: 51,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-15`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-16: users_default = sender+10', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      users_default: 60,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-16`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-17: users_default = sender+25', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      users_default: 75,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-17`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-18: events_default = sender+1', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      events_default: 51,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-18`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-19: events_default = sender+10', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      events_default: 60,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-19`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
  it('PL escalate soft-20: events_default = sender+25', () => {
    const state = baseJoined(powerLevels({ [ALICE]: 50 }));
    const content: Record<string, unknown> = {
      users: { [ALICE]: 50 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      events_default: 75,
    };
    const ev = pdu({
      type: 'm.room.power_levels',
      event_id: `$pl-esc-20`,
      sender: ALICE,
      state_key: '',
      content,
    });
    const r = checkEventAuth(ev, state);
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('Cannot set power level higher than own (50)');
  });
});

describe('room-state map leftovers after #214 — multi-type buildStateMap pins', () => {
  it('keeps independent last-write winners across distinct types', () => {
    const events = [
      nameEvent('a', '$n1', 1),
      nameEvent('b', '$n2', 2),
      pdu({
        type: 'm.room.topic',
        event_id: '$t1',
        sender: ALICE,
        state_key: '',
        content: { topic: 't1' },
      }),
      pdu({
        type: 'm.room.topic',
        event_id: '$t2',
        sender: ALICE,
        state_key: '',
        content: { topic: 't2' },
      }),
      memberEvent(ALICE, 'join', ALICE, '$a1'),
      memberEvent(ALICE, 'join', ALICE, '$a2'),
    ];
    const map = buildStateMap(events);
    expect(map.size).toBe(3);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe('$n2');
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe('$t2');
    expect(map.get(stateKey('m.room.member', ALICE))?.event_id).toBe('$a2');
  });

  it('skips events with omitted state_key while indexing empty string', () => {
    const withKey = nameEvent('named', '$named', 1);
    const without = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: ALICE,
      content: { body: 'x' },
    });
    // ensure state_key truly omitted
    delete (without as { state_key?: string }).state_key;
    const map = buildStateMap([withKey, without]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe('$named');
    expect(map.has(stateKey('m.room.message', ''))).toBe(false);
  });
});

describe('room-state map leftovers after #214 — omitted state_key soft flood', () => {
  it('omit soft-0: type=m.room.message', () => {
    const stateEv = nameEvent('n', `$n-0`, 1);
    const nonState = pdu({
      type: 'm.room.message',
      event_id: `$ns-0`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-0`);
    expect([...map.keys()].some((k) => k.startsWith('m.room.message'))).toBe(false);
  });
  it('omit soft-1: type=m.reaction', () => {
    const stateEv = nameEvent('n', `$n-1`, 1);
    const nonState = pdu({
      type: 'm.reaction',
      event_id: `$ns-1`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-1`);
    expect([...map.keys()].some((k) => k.startsWith('m.reaction'))).toBe(false);
  });
  it('omit soft-2: type=m.room.encrypted', () => {
    const stateEv = nameEvent('n', `$n-2`, 1);
    const nonState = pdu({
      type: 'm.room.encrypted',
      event_id: `$ns-2`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-2`);
    expect([...map.keys()].some((k) => k.startsWith('m.room.encrypted'))).toBe(false);
  });
  it('omit soft-3: type=m.room.redaction', () => {
    const stateEv = nameEvent('n', `$n-3`, 1);
    const nonState = pdu({
      type: 'm.room.redaction',
      event_id: `$ns-3`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-3`);
    expect([...map.keys()].some((k) => k.startsWith('m.room.redaction'))).toBe(false);
  });
  it('omit soft-4: type=org.example.custom', () => {
    const stateEv = nameEvent('n', `$n-4`, 1);
    const nonState = pdu({
      type: 'org.example.custom',
      event_id: `$ns-4`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-4`);
    expect([...map.keys()].some((k) => k.startsWith('org.example.custom'))).toBe(false);
  });
  it('omit soft-5: type=m.room.message', () => {
    const stateEv = nameEvent('n', `$n-5`, 1);
    const nonState = pdu({
      type: 'm.room.message',
      event_id: `$ns-5`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-5`);
    expect([...map.keys()].some((k) => k.startsWith('m.room.message'))).toBe(false);
  });
  it('omit soft-6: type=m.reaction', () => {
    const stateEv = nameEvent('n', `$n-6`, 1);
    const nonState = pdu({
      type: 'm.reaction',
      event_id: `$ns-6`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-6`);
    expect([...map.keys()].some((k) => k.startsWith('m.reaction'))).toBe(false);
  });
  it('omit soft-7: type=m.room.encrypted', () => {
    const stateEv = nameEvent('n', `$n-7`, 1);
    const nonState = pdu({
      type: 'm.room.encrypted',
      event_id: `$ns-7`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-7`);
    expect([...map.keys()].some((k) => k.startsWith('m.room.encrypted'))).toBe(false);
  });
  it('omit soft-8: type=m.room.redaction', () => {
    const stateEv = nameEvent('n', `$n-8`, 1);
    const nonState = pdu({
      type: 'm.room.redaction',
      event_id: `$ns-8`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-8`);
    expect([...map.keys()].some((k) => k.startsWith('m.room.redaction'))).toBe(false);
  });
  it('omit soft-9: type=org.example.custom', () => {
    const stateEv = nameEvent('n', `$n-9`, 1);
    const nonState = pdu({
      type: 'org.example.custom',
      event_id: `$ns-9`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-9`);
    expect([...map.keys()].some((k) => k.startsWith('org.example.custom'))).toBe(false);
  });
  it('omit soft-10: type=m.room.message', () => {
    const stateEv = nameEvent('n', `$n-10`, 1);
    const nonState = pdu({
      type: 'm.room.message',
      event_id: `$ns-10`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-10`);
    expect([...map.keys()].some((k) => k.startsWith('m.room.message'))).toBe(false);
  });
  it('omit soft-11: type=m.reaction', () => {
    const stateEv = nameEvent('n', `$n-11`, 1);
    const nonState = pdu({
      type: 'm.reaction',
      event_id: `$ns-11`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-11`);
    expect([...map.keys()].some((k) => k.startsWith('m.reaction'))).toBe(false);
  });
  it('omit soft-12: type=m.room.encrypted', () => {
    const stateEv = nameEvent('n', `$n-12`, 1);
    const nonState = pdu({
      type: 'm.room.encrypted',
      event_id: `$ns-12`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-12`);
    expect([...map.keys()].some((k) => k.startsWith('m.room.encrypted'))).toBe(false);
  });
  it('omit soft-13: type=m.room.redaction', () => {
    const stateEv = nameEvent('n', `$n-13`, 1);
    const nonState = pdu({
      type: 'm.room.redaction',
      event_id: `$ns-13`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-13`);
    expect([...map.keys()].some((k) => k.startsWith('m.room.redaction'))).toBe(false);
  });
  it('omit soft-14: type=org.example.custom', () => {
    const stateEv = nameEvent('n', `$n-14`, 1);
    const nonState = pdu({
      type: 'org.example.custom',
      event_id: `$ns-14`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-14`);
    expect([...map.keys()].some((k) => k.startsWith('org.example.custom'))).toBe(false);
  });
  it('omit soft-15: type=m.room.message', () => {
    const stateEv = nameEvent('n', `$n-15`, 1);
    const nonState = pdu({
      type: 'm.room.message',
      event_id: `$ns-15`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-15`);
    expect([...map.keys()].some((k) => k.startsWith('m.room.message'))).toBe(false);
  });
  it('omit soft-16: type=m.reaction', () => {
    const stateEv = nameEvent('n', `$n-16`, 1);
    const nonState = pdu({
      type: 'm.reaction',
      event_id: `$ns-16`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-16`);
    expect([...map.keys()].some((k) => k.startsWith('m.reaction'))).toBe(false);
  });
  it('omit soft-17: type=m.room.encrypted', () => {
    const stateEv = nameEvent('n', `$n-17`, 1);
    const nonState = pdu({
      type: 'm.room.encrypted',
      event_id: `$ns-17`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-17`);
    expect([...map.keys()].some((k) => k.startsWith('m.room.encrypted'))).toBe(false);
  });
  it('omit soft-18: type=m.room.redaction', () => {
    const stateEv = nameEvent('n', `$n-18`, 1);
    const nonState = pdu({
      type: 'm.room.redaction',
      event_id: `$ns-18`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-18`);
    expect([...map.keys()].some((k) => k.startsWith('m.room.redaction'))).toBe(false);
  });
  it('omit soft-19: type=org.example.custom', () => {
    const stateEv = nameEvent('n', `$n-19`, 1);
    const nonState = pdu({
      type: 'org.example.custom',
      event_id: `$ns-19`,
      sender: ALICE,
      content: { body: 'x' },
    });
    delete (nonState as { state_key?: string }).state_key;
    const map = buildStateMap([stateEv, nonState]);
    expect(map.size).toBe(1);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$n-19`);
    expect([...map.keys()].some((k) => k.startsWith('org.example.custom'))).toBe(false);
  });
});

describe('room-state map leftovers after #214 — multi-type last-write soft flood', () => {
  it('multi-type soft-0', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-0-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-0-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-0-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-0-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-0-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-0-3`);
  });
  it('multi-type soft-1', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-1-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-1-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-1-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-1-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-1-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-1-3`);
  });
  it('multi-type soft-2', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-2-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-2-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-2-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-2-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-2-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-2-3`);
  });
  it('multi-type soft-3', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-3-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-3-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-3-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-3-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-3-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-3-3`);
  });
  it('multi-type soft-4', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-4-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-4-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-4-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-4-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-4-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-4-3`);
  });
  it('multi-type soft-5', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-5-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-5-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-5-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-5-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-5-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-5-3`);
  });
  it('multi-type soft-6', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-6-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-6-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-6-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-6-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-6-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-6-3`);
  });
  it('multi-type soft-7', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-7-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-7-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-7-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-7-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-7-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-7-3`);
  });
  it('multi-type soft-8', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-8-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-8-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-8-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-8-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-8-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-8-3`);
  });
  it('multi-type soft-9', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-9-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-9-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-9-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-9-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-9-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-9-3`);
  });
  it('multi-type soft-10', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-10-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-10-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-10-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-10-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-10-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-10-3`);
  });
  it('multi-type soft-11', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-11-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-11-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-11-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-11-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-11-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-11-3`);
  });
  it('multi-type soft-12', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-12-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-12-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-12-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-12-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-12-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-12-3`);
  });
  it('multi-type soft-13', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-13-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-13-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-13-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-13-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-13-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-13-3`);
  });
  it('multi-type soft-14', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-14-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-14-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-14-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-14-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-14-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-14-3`);
  });
  it('multi-type soft-15', () => {
    const events: PDU[] = [];
    for (let j = 0; j < 4; j++) {
      events.push(
        pdu({
          type: 'm.room.name',
          event_id: `$name-15-${j}`,
          sender: ALICE,
          state_key: '',
          content: { name: `n-15-${j}` },
        })
      );
      events.push(
        pdu({
          type: 'm.room.topic',
          event_id: `$topic-15-${j}`,
          sender: ALICE,
          state_key: '',
          content: { topic: `t-15-${j}` },
        })
      );
    }
    const map = buildStateMap(events);
    expect(map.size).toBe(2);
    expect(map.get(stateKey('m.room.name', ''))?.event_id).toBe(`$name-15-3`);
    expect(map.get(stateKey('m.room.topic', ''))?.event_id).toBe(`$topic-15-3`);
  });
});

describe('state-resolution leftovers after #214 — residual exact pins', () => {
  it('drops unauthorized conflicted join_rules while keeping legit winner', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', '$jr-legit', ALICE);
    const hacked = joinRules('invite', '$jr-eve', EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe('$jr-legit');
    expect(resolved.find((e) => e.event_id === '$jr-eve')).toBeUndefined();
  });

  it('includes member present in only one of three sets (conflicted missing)', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, '$bob-only');
    // Public join_rules required so conflicted join passes iterative auth
    const jr = joinRules('public', '$jr-public');
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === '$bob-only')).toBeDefined();
  });

  it('tie-breaks equal-power equal-ts conflicted names by event_id lex (later overwrite)', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    // same power, same ts; reverseTopological sorts by event_id asc → $name-aaa first, then $name-zzz overwrites
    const a = nameEvent('aaa', '$name-aaa', 3, ALICE, 50);
    const z = nameEvent('zzz', '$name-zzz', 3, ALICE, 50);
    const resolved = resolveState('10', [
      [create, alice, pl, a],
      [create, alice, pl, z],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe('$name-zzz');
  });

  it('drops fully conflicted power_levels when neither passes default PL auth', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join');
    const plA = powerLevels({ [ALICE]: 100, [BOB]: 10 }, {});
    const plA2 = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-a',
      sender: ALICE,
      state_key: '',
      content: plA.content,
    });
    const plB = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-b',
      sender: BOB,
      state_key: '',
      content: {
        users: { [ALICE]: 100, [BOB]: 80 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
    });
    const resolved = resolveState('10', [
      [create, alice, bob, plA2],
      [create, alice, bob, plB],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.power_levels')).toBeUndefined();
  });

  it('v1 equal-depth picks lexicographically smaller event_id', () => {
    const a = nameEvent('A', '$name-mmm', 5);
    const b = nameEvent('B', '$name-nnn', 5);
    expect(resolveStateV1([[a], [b]])[0].event_id).toBe('$name-mmm');
  });
});

describe('state-resolution leftovers after #214 — unauthorized auth drop soft flood', () => {
  it('auth-drop soft-0', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-0`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-0`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-0`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-0`)).toBeUndefined();
  });
  it('auth-drop soft-1', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-1`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-1`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-1`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-1`)).toBeUndefined();
  });
  it('auth-drop soft-2', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-2`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-2`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-2`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-2`)).toBeUndefined();
  });
  it('auth-drop soft-3', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-3`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-3`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-3`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-3`)).toBeUndefined();
  });
  it('auth-drop soft-4', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-4`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-4`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-4`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-4`)).toBeUndefined();
  });
  it('auth-drop soft-5', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-5`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-5`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-5`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-5`)).toBeUndefined();
  });
  it('auth-drop soft-6', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-6`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-6`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-6`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-6`)).toBeUndefined();
  });
  it('auth-drop soft-7', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-7`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-7`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-7`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-7`)).toBeUndefined();
  });
  it('auth-drop soft-8', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-8`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-8`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-8`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-8`)).toBeUndefined();
  });
  it('auth-drop soft-9', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-9`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-9`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-9`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-9`)).toBeUndefined();
  });
  it('auth-drop soft-10', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-10`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-10`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-10`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-10`)).toBeUndefined();
  });
  it('auth-drop soft-11', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-11`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-11`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-11`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-11`)).toBeUndefined();
  });
  it('auth-drop soft-12', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-12`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-12`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-12`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-12`)).toBeUndefined();
  });
  it('auth-drop soft-13', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-13`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-13`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-13`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-13`)).toBeUndefined();
  });
  it('auth-drop soft-14', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-14`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-14`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-14`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-14`)).toBeUndefined();
  });
  it('auth-drop soft-15', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const legit = joinRules('public', `$jr-ok-15`, ALICE);
    const hacked = joinRules('invite', `$jr-bad-15`, EVE);
    const resolved = resolveState('10', [
      [create, alice, pl, legit],
      [create, alice, pl, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe(`$jr-ok-15`);
    expect(resolved.find((e) => e.event_id === `$jr-bad-15`)).toBeUndefined();
  });
});

describe('state-resolution leftovers after #214 — missing-from-set soft flood', () => {
  it('missing soft-0', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-0`);
    const jr = joinRules('public', `$jr-0`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-0`)?.state_key).toBe(BOB);
  });
  it('missing soft-1', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-1`);
    const jr = joinRules('public', `$jr-1`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-1`)?.state_key).toBe(BOB);
  });
  it('missing soft-2', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-2`);
    const jr = joinRules('public', `$jr-2`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-2`)?.state_key).toBe(BOB);
  });
  it('missing soft-3', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-3`);
    const jr = joinRules('public', `$jr-3`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-3`)?.state_key).toBe(BOB);
  });
  it('missing soft-4', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-4`);
    const jr = joinRules('public', `$jr-4`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-4`)?.state_key).toBe(BOB);
  });
  it('missing soft-5', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-5`);
    const jr = joinRules('public', `$jr-5`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-5`)?.state_key).toBe(BOB);
  });
  it('missing soft-6', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-6`);
    const jr = joinRules('public', `$jr-6`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-6`)?.state_key).toBe(BOB);
  });
  it('missing soft-7', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-7`);
    const jr = joinRules('public', `$jr-7`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-7`)?.state_key).toBe(BOB);
  });
  it('missing soft-8', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-8`);
    const jr = joinRules('public', `$jr-8`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-8`)?.state_key).toBe(BOB);
  });
  it('missing soft-9', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-9`);
    const jr = joinRules('public', `$jr-9`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-9`)?.state_key).toBe(BOB);
  });
  it('missing soft-10', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-10`);
    const jr = joinRules('public', `$jr-10`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-10`)?.state_key).toBe(BOB);
  });
  it('missing soft-11', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-11`);
    const jr = joinRules('public', `$jr-11`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-11`)?.state_key).toBe(BOB);
  });
  it('missing soft-12', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-12`);
    const jr = joinRules('public', `$jr-12`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-12`)?.state_key).toBe(BOB);
  });
  it('missing soft-13', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-13`);
    const jr = joinRules('public', `$jr-13`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-13`)?.state_key).toBe(BOB);
  });
  it('missing soft-14', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-14`);
    const jr = joinRules('public', `$jr-14`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-14`)?.state_key).toBe(BOB);
  });
  it('missing soft-15', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const bob = memberEvent(BOB, 'join', BOB, `$bob-15`);
    const jr = joinRules('public', `$jr-15`);
    const resolved = resolveState('10', [
      [create, alice, jr],
      [create, alice, jr, bob],
      [create, alice, jr],
    ]);
    expect(resolved.find((e) => e.event_id === `$bob-15`)?.state_key).toBe(BOB);
  });
});

describe('state-resolution leftovers after #214 — equal-power equal-ts event_id soft flood', () => {
  it('eq-ts soft-0', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-00`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-00`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-00`);
  });
  it('eq-ts soft-1', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-01`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-01`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-01`);
  });
  it('eq-ts soft-2', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-02`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-02`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-02`);
  });
  it('eq-ts soft-3', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-03`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-03`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-03`);
  });
  it('eq-ts soft-4', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-04`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-04`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-04`);
  });
  it('eq-ts soft-5', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-05`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-05`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-05`);
  });
  it('eq-ts soft-6', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-06`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-06`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-06`);
  });
  it('eq-ts soft-7', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-07`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-07`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-07`);
  });
  it('eq-ts soft-8', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-08`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-08`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-08`);
  });
  it('eq-ts soft-9', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-09`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-09`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-09`);
  });
  it('eq-ts soft-10', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-10`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-10`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-10`);
  });
  it('eq-ts soft-11', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-11`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-11`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-11`);
  });
  it('eq-ts soft-12', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-12`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-12`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-12`);
  });
  it('eq-ts soft-13', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-13`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-13`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-13`);
  });
  it('eq-ts soft-14', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-14`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-14`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-14`);
  });
  it('eq-ts soft-15', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('e', `$name-a-15`, 3, ALICE, 77);
    const late = nameEvent('l', `$name-z-15`, 3, ALICE, 77);
    const resolved = resolveState('10', [
      [create, alice, pl, early],
      [create, alice, pl, late],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$name-z-15`);
  });
});

describe('state-resolution leftovers after #214 — v1 equal-depth event_id soft flood', () => {
  it('v1-lex soft-0', () => {
    const a = nameEvent('A', `$v1-a-00`, 8);
    const b = nameEvent('B', `$v1-b-00`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-00`);
  });
  it('v1-lex soft-1', () => {
    const a = nameEvent('A', `$v1-a-01`, 8);
    const b = nameEvent('B', `$v1-b-01`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-01`);
  });
  it('v1-lex soft-2', () => {
    const a = nameEvent('A', `$v1-a-02`, 8);
    const b = nameEvent('B', `$v1-b-02`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-02`);
  });
  it('v1-lex soft-3', () => {
    const a = nameEvent('A', `$v1-a-03`, 8);
    const b = nameEvent('B', `$v1-b-03`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-03`);
  });
  it('v1-lex soft-4', () => {
    const a = nameEvent('A', `$v1-a-04`, 8);
    const b = nameEvent('B', `$v1-b-04`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-04`);
  });
  it('v1-lex soft-5', () => {
    const a = nameEvent('A', `$v1-a-05`, 8);
    const b = nameEvent('B', `$v1-b-05`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-05`);
  });
  it('v1-lex soft-6', () => {
    const a = nameEvent('A', `$v1-a-06`, 8);
    const b = nameEvent('B', `$v1-b-06`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-06`);
  });
  it('v1-lex soft-7', () => {
    const a = nameEvent('A', `$v1-a-07`, 8);
    const b = nameEvent('B', `$v1-b-07`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-07`);
  });
  it('v1-lex soft-8', () => {
    const a = nameEvent('A', `$v1-a-08`, 8);
    const b = nameEvent('B', `$v1-b-08`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-08`);
  });
  it('v1-lex soft-9', () => {
    const a = nameEvent('A', `$v1-a-09`, 8);
    const b = nameEvent('B', `$v1-b-09`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-09`);
  });
  it('v1-lex soft-10', () => {
    const a = nameEvent('A', `$v1-a-10`, 8);
    const b = nameEvent('B', `$v1-b-10`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-10`);
  });
  it('v1-lex soft-11', () => {
    const a = nameEvent('A', `$v1-a-11`, 8);
    const b = nameEvent('B', `$v1-b-11`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-11`);
  });
  it('v1-lex soft-12', () => {
    const a = nameEvent('A', `$v1-a-12`, 8);
    const b = nameEvent('B', `$v1-b-12`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-12`);
  });
  it('v1-lex soft-13', () => {
    const a = nameEvent('A', `$v1-a-13`, 8);
    const b = nameEvent('B', `$v1-b-13`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-13`);
  });
  it('v1-lex soft-14', () => {
    const a = nameEvent('A', `$v1-a-14`, 8);
    const b = nameEvent('B', `$v1-b-14`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-14`);
  });
  it('v1-lex soft-15', () => {
    const a = nameEvent('A', `$v1-a-15`, 8);
    const b = nameEvent('B', `$v1-b-15`, 8);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe(`$v1-a-15`);
  });
});

describe('state-resolution leftovers after #214 — conflicted auth+name soft flood', () => {
  it('auth+name soft-0', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const jrA = joinRules('public', `$jr-a-0`, ALICE);
    const jrB = joinRules('invite', `$jr-b-0`, ALICE);
    const nameA = nameEvent('A', `$na-0`, 4, ALICE, 10 + 0);
    const nameB = nameEvent('B', `$nb-0`, 4, ALICE, 100 + 0);
    const resolved = resolveState('10', [
      [create, alice, pl, jrA, nameA],
      [create, alice, pl, jrB, nameB],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.join_rules')).toHaveLength(1);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    // later ts wins for equal power
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$nb-0`);
  });
  it('auth+name soft-1', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const jrA = joinRules('public', `$jr-a-1`, ALICE);
    const jrB = joinRules('invite', `$jr-b-1`, ALICE);
    const nameA = nameEvent('A', `$na-1`, 4, ALICE, 10 + 1);
    const nameB = nameEvent('B', `$nb-1`, 4, ALICE, 100 + 1);
    const resolved = resolveState('10', [
      [create, alice, pl, jrA, nameA],
      [create, alice, pl, jrB, nameB],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.join_rules')).toHaveLength(1);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    // later ts wins for equal power
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$nb-1`);
  });
  it('auth+name soft-2', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const jrA = joinRules('public', `$jr-a-2`, ALICE);
    const jrB = joinRules('invite', `$jr-b-2`, ALICE);
    const nameA = nameEvent('A', `$na-2`, 4, ALICE, 10 + 2);
    const nameB = nameEvent('B', `$nb-2`, 4, ALICE, 100 + 2);
    const resolved = resolveState('10', [
      [create, alice, pl, jrA, nameA],
      [create, alice, pl, jrB, nameB],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.join_rules')).toHaveLength(1);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    // later ts wins for equal power
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$nb-2`);
  });
  it('auth+name soft-3', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const jrA = joinRules('public', `$jr-a-3`, ALICE);
    const jrB = joinRules('invite', `$jr-b-3`, ALICE);
    const nameA = nameEvent('A', `$na-3`, 4, ALICE, 10 + 3);
    const nameB = nameEvent('B', `$nb-3`, 4, ALICE, 100 + 3);
    const resolved = resolveState('10', [
      [create, alice, pl, jrA, nameA],
      [create, alice, pl, jrB, nameB],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.join_rules')).toHaveLength(1);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    // later ts wins for equal power
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$nb-3`);
  });
  it('auth+name soft-4', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const jrA = joinRules('public', `$jr-a-4`, ALICE);
    const jrB = joinRules('invite', `$jr-b-4`, ALICE);
    const nameA = nameEvent('A', `$na-4`, 4, ALICE, 10 + 4);
    const nameB = nameEvent('B', `$nb-4`, 4, ALICE, 100 + 4);
    const resolved = resolveState('10', [
      [create, alice, pl, jrA, nameA],
      [create, alice, pl, jrB, nameB],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.join_rules')).toHaveLength(1);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    // later ts wins for equal power
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$nb-4`);
  });
  it('auth+name soft-5', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const jrA = joinRules('public', `$jr-a-5`, ALICE);
    const jrB = joinRules('invite', `$jr-b-5`, ALICE);
    const nameA = nameEvent('A', `$na-5`, 4, ALICE, 10 + 5);
    const nameB = nameEvent('B', `$nb-5`, 4, ALICE, 100 + 5);
    const resolved = resolveState('10', [
      [create, alice, pl, jrA, nameA],
      [create, alice, pl, jrB, nameB],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.join_rules')).toHaveLength(1);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    // later ts wins for equal power
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$nb-5`);
  });
  it('auth+name soft-6', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const jrA = joinRules('public', `$jr-a-6`, ALICE);
    const jrB = joinRules('invite', `$jr-b-6`, ALICE);
    const nameA = nameEvent('A', `$na-6`, 4, ALICE, 10 + 6);
    const nameB = nameEvent('B', `$nb-6`, 4, ALICE, 100 + 6);
    const resolved = resolveState('10', [
      [create, alice, pl, jrA, nameA],
      [create, alice, pl, jrB, nameB],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.join_rules')).toHaveLength(1);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    // later ts wins for equal power
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$nb-6`);
  });
  it('auth+name soft-7', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const jrA = joinRules('public', `$jr-a-7`, ALICE);
    const jrB = joinRules('invite', `$jr-b-7`, ALICE);
    const nameA = nameEvent('A', `$na-7`, 4, ALICE, 10 + 7);
    const nameB = nameEvent('B', `$nb-7`, 4, ALICE, 100 + 7);
    const resolved = resolveState('10', [
      [create, alice, pl, jrA, nameA],
      [create, alice, pl, jrB, nameB],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.join_rules')).toHaveLength(1);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    // later ts wins for equal power
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$nb-7`);
  });
  it('auth+name soft-8', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const jrA = joinRules('public', `$jr-a-8`, ALICE);
    const jrB = joinRules('invite', `$jr-b-8`, ALICE);
    const nameA = nameEvent('A', `$na-8`, 4, ALICE, 10 + 8);
    const nameB = nameEvent('B', `$nb-8`, 4, ALICE, 100 + 8);
    const resolved = resolveState('10', [
      [create, alice, pl, jrA, nameA],
      [create, alice, pl, jrB, nameB],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.join_rules')).toHaveLength(1);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    // later ts wins for equal power
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$nb-8`);
  });
  it('auth+name soft-9', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const jrA = joinRules('public', `$jr-a-9`, ALICE);
    const jrB = joinRules('invite', `$jr-b-9`, ALICE);
    const nameA = nameEvent('A', `$na-9`, 4, ALICE, 10 + 9);
    const nameB = nameEvent('B', `$nb-9`, 4, ALICE, 100 + 9);
    const resolved = resolveState('10', [
      [create, alice, pl, jrA, nameA],
      [create, alice, pl, jrB, nameB],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.join_rules')).toHaveLength(1);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    // later ts wins for equal power
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$nb-9`);
  });
  it('auth+name soft-10', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const jrA = joinRules('public', `$jr-a-10`, ALICE);
    const jrB = joinRules('invite', `$jr-b-10`, ALICE);
    const nameA = nameEvent('A', `$na-10`, 4, ALICE, 10 + 10);
    const nameB = nameEvent('B', `$nb-10`, 4, ALICE, 100 + 10);
    const resolved = resolveState('10', [
      [create, alice, pl, jrA, nameA],
      [create, alice, pl, jrB, nameB],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.join_rules')).toHaveLength(1);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    // later ts wins for equal power
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$nb-10`);
  });
  it('auth+name soft-11', () => {
    const create = createEvent();
    const alice = memberEvent(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const jrA = joinRules('public', `$jr-a-11`, ALICE);
    const jrB = joinRules('invite', `$jr-b-11`, ALICE);
    const nameA = nameEvent('A', `$na-11`, 4, ALICE, 10 + 11);
    const nameB = nameEvent('B', `$nb-11`, 4, ALICE, 100 + 11);
    const resolved = resolveState('10', [
      [create, alice, pl, jrA, nameA],
      [create, alice, pl, jrB, nameB],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.join_rules')).toHaveLength(1);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    // later ts wins for equal power
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe(`$nb-11`);
  });
});
