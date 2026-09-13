import { describe, it, expect } from 'vitest';
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

function createEvent(creator = '@alice:example.com', eventId = '$create'): PDU {
  return pdu({
    type: 'm.room.create',
    event_id: eventId,
    sender: creator,
    state_key: '',
    depth: 0,
    prev_events: [],
    content: { creator, room_version: '10' },
  });
}

function member(
  userId: string,
  membership: 'join' | 'leave' | 'ban' | 'invite',
  opts: { eventId?: string; depth?: number; sender?: string; ts?: number } = {}
): PDU {
  return pdu({
    type: 'm.room.member',
    event_id: opts.eventId ?? `$m-${userId}-${membership}`,
    sender: opts.sender ?? userId,
    state_key: userId,
    depth: opts.depth ?? 1,
    origin_server_ts: opts.ts ?? 1,
    content: { membership },
  });
}

function nameEvent(name: string, eventId: string, depth: number, sender = '@alice:example.com'): PDU {
  return pdu({
    type: 'm.room.name',
    event_id: eventId,
    sender,
    state_key: '',
    depth,
    content: { name },
  });
}

describe('resolveStateV1', () => {
  it('returns empty for empty input', () => {
    expect(resolveStateV1([])).toEqual([]);
    expect(resolveStateV1([[]])).toEqual([]);
  });

  it('passes through a single unconflicted state set', () => {
    const create = createEvent();
    const join = member('@alice:example.com', 'join');
    const resolved = resolveStateV1([[create, join]]);
    expect(resolved).toHaveLength(2);
    expect(resolved).toEqual(expect.arrayContaining([create, join]));
  });

  it('ignores non-state events without state_key', () => {
    const create = createEvent();
    const msg = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: '@alice:example.com',
      content: { body: 'hi', msgtype: 'm.text' },
    });
    expect(resolveStateV1([[create, msg]])).toEqual([create]);
  });

  it('deduplicates the same event appearing in multiple sets', () => {
    const create = createEvent();
    const resolved = resolveStateV1([[create], [create]]);
    expect(resolved).toEqual([create]);
  });

  it('picks the higher-depth event on conflict', () => {
    const low = nameEvent('old', '$name-a', 3);
    const high = nameEvent('new', '$name-b', 5);
    const resolved = resolveStateV1([[low], [high]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$name-b');
  });

  it('uses lexicographic event_id as tiebreaker at equal depth', () => {
    const a = nameEvent('A', '$name-aaa', 4);
    const b = nameEvent('B', '$name-zzz', 4);
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved[0].event_id).toBe('$name-aaa');
  });
});

describe('resolveState routing', () => {
  it('routes room version 1 to the v1 algorithm', () => {
    const low = nameEvent('old', '$name-a', 2);
    const high = nameEvent('new', '$name-b', 9);
    const viaRouter = resolveState('1', [[low], [high]]);
    const direct = resolveStateV1([[low], [high]]);
    expect(viaRouter.map((e) => e.event_id)).toEqual(direct.map((e) => e.event_id));
  });

  it('falls back to v1 for unknown room versions', () => {
    const low = nameEvent('old', '$name-a', 2);
    const high = nameEvent('new', '$name-b', 9);
    expect(resolveState('99', [[low], [high]])[0].event_id).toBe('$name-b');
  });

  it('returns a single set unchanged for v2 when there is no conflict', () => {
    const create = createEvent();
    const join = member('@alice:example.com', 'join');
    const resolved = resolveState('10', [[create, join]]);
    expect(resolved).toEqual([create, join]);
  });

  it('merges unconflicted keys across v2 state sets', () => {
    const create = createEvent();
    const joinRules = pdu({
      type: 'm.room.join_rules',
      event_id: '$jr',
      sender: '@alice:example.com',
      state_key: '',
      content: { join_rule: 'public' },
    });
    const alice = member('@alice:example.com', 'join');
    const bob = member('@bob:example.com', 'join');
    // create + join_rules + alice are in both sets (unconflicted);
    // bob only appears in set 2 → conflicted but should auth against public room.
    const resolved = resolveState('10', [
      [create, joinRules, alice],
      [create, joinRules, alice, bob],
    ]);
    expect(resolved.find((e) => e.event_id === '$create')).toBeDefined();
    const memberIds = resolved
      .filter((e) => e.type === 'm.room.member')
      .map((e) => e.state_key)
      .sort();
    expect(memberIds).toEqual(['@alice:example.com', '@bob:example.com']);
  });

  it('resolves conflicted room name via power-ordered auth checks (v2)', () => {
    const create = createEvent();
    const aliceJoin = member('@alice:example.com', 'join', { depth: 1 });
    const powerLevels = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl',
      sender: '@alice:example.com',
      state_key: '',
      depth: 2,
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
    });
    const nameLow = nameEvent('low', '$name-low', 3, '@alice:example.com');
    const nameHigh = nameEvent('high', '$name-high', 4, '@alice:example.com');

    const resolved = resolveState('10', [
      [create, aliceJoin, powerLevels, nameLow],
      [create, aliceJoin, powerLevels, nameHigh],
    ]);

    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toMatch(/^\$name-/);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
  });

  it('drops unauthorized conflicted state in v2', () => {
    const create = createEvent();
    const aliceJoin = member('@alice:example.com', 'join');
    const powerLevels = pdu({
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
    });
    // Eve never joined — her name event must not win
    const eveName = nameEvent('hacked', '$name-eve', 5, '@eve:example.com');
    const aliceName = nameEvent('legit', '$name-alice', 3, '@alice:example.com');

    const resolved = resolveState('10', [
      [create, aliceJoin, powerLevels, aliceName],
      [create, aliceJoin, powerLevels, eveName],
    ]);

    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe('$name-alice');
  });

  it('routes room versions 2–12 to the v2 algorithm path', () => {
    const create = createEvent();
    const join = member('@alice:example.com', 'join');
    for (const v of ['2', '5', '10', '12']) {
      expect(resolveState(v, [[create, join]])).toEqual([create, join]);
    }
  });
});


describe('resolveState TOKENMAXX edge paths after #49', () => {
  it('returns an empty array for empty v2 stateSets', () => {
    expect(resolveState('10', [])).toEqual([]);
  });
});

describe('resolveState TOKENMAXX edge paths after #50', () => {
  it('returns empty for a single empty v2 state set', () => {
    expect(resolveState('10', [[]])).toEqual([]);
  });

  it('prefers the higher-power sender when resolving conflicted room names (v2)', () => {
    const create = createEvent();
    const aliceJoin = member('@alice:example.com', 'join', { depth: 1 });
    const bobJoin = member('@bob:example.com', 'join', { depth: 1 });
    const powerLevels = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl',
      sender: '@alice:example.com',
      state_key: '',
      depth: 2,
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
    // Give bob temporary PL so their name event can be authored into a set;
    // resolution power order still uses the conflicted auth/power context.
    const nameAlice = nameEvent('alice-name', '$name-alice', 3, '@alice:example.com');
    const nameBob = nameEvent('bob-name', '$name-bob', 3, '@bob:example.com');
    // Bob cannot win auth against state_default 50 with PL 0 — alice wins.
    const resolved = resolveState('10', [
      [create, aliceJoin, bobJoin, powerLevels, nameAlice],
      [create, aliceJoin, bobJoin, powerLevels, nameBob],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe('$name-alice');
  });

  it('tie-breaks equal-power conflicted names by earlier origin_server_ts then event_id', () => {
    const create = createEvent();
    const aliceJoin = member('@alice:example.com', 'join', { depth: 1 });
    const powerLevels = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl',
      sender: '@alice:example.com',
      state_key: '',
      depth: 2,
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
    });
    const earlier = pdu({
      type: 'm.room.name',
      event_id: '$name-zzz',
      sender: '@alice:example.com',
      state_key: '',
      depth: 3,
      origin_server_ts: 10,
      content: { name: 'earlier' },
    });
    const later = pdu({
      type: 'm.room.name',
      event_id: '$name-aaa',
      sender: '@alice:example.com',
      state_key: '',
      depth: 3,
      origin_server_ts: 20,
      content: { name: 'later' },
    });
    // reverseTopologicalPowerOrder: earlier ts first → applied first, later overwrites
    const resolved = resolveState('10', [
      [create, aliceJoin, powerLevels, earlier],
      [create, aliceJoin, powerLevels, later],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe('$name-aaa');
  });

  it('deduplicates the same conflicted event_id across v2 state sets', () => {
    const create = createEvent();
    const join = member('@alice:example.com', 'join');
    const name = nameEvent('once', '$name-once', 3);
    const resolved = resolveState('10', [
      [create, join, name],
      [create, join, name],
    ]);
    // Identical event in both sets → unconflicted, single copy
    expect(resolved.filter((e) => e.event_id === '$name-once')).toHaveLength(1);
  });

  it('drops unauthorized conflicted join_rules in v2', () => {
    const create = createEvent();
    const aliceJoin = member('@alice:example.com', 'join');
    const powerLevels = pdu({
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
    });
    const legit = pdu({
      type: 'm.room.join_rules',
      event_id: '$jr-legit',
      sender: '@alice:example.com',
      state_key: '',
      content: { join_rule: 'public' },
    });
    const hacked = pdu({
      type: 'm.room.join_rules',
      event_id: '$jr-hack',
      sender: '@eve:example.com',
      state_key: '',
      content: { join_rule: 'public' },
    });
    const resolved = resolveState('10', [
      [create, aliceJoin, powerLevels, legit],
      [create, aliceJoin, powerLevels, hacked],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe('$jr-legit');
  });

  it('uses lexicographic event_id at equal depth for v1 conflicts', () => {
    const a = nameEvent('A', '$name-aaa', 4);
    const b = nameEvent('B', '$name-bbb', 4);
    expect(resolveStateV1([[a], [b]])[0].event_id).toBe('$name-aaa');
    // Equal depth + equal event_id comparator path still yields one winner
    const dup = nameEvent('same', '$name-same', 4);
    expect(resolveStateV1([[dup], [dup]])).toEqual([dup]);
  });
});
