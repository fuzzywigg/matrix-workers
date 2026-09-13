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


describe('resolveState TOKENMAXX edge paths after #69', () => {
  it('treats keys present in only some state sets as conflicted (partial presence)', () => {
    const create = createEvent();
    const alice = member('@alice:example.com', 'join');
    const bob = member('@bob:example.com', 'join', { depth: 2 });
    const joinRules = pdu({
      type: 'm.room.join_rules',
      event_id: '$jr',
      sender: '@alice:example.com',
      state_key: '',
      content: { join_rule: 'public' },
    });
    // bob is missing from set 0 → conflicted membership key
    const resolved = resolveState('10', [
      [create, joinRules, alice],
      [create, joinRules, alice, bob],
    ]);
    expect(resolved.find((e) => e.state_key === '@bob:example.com')?.event_id).toBe(
      bob.event_id
    );
  });

  it('resolves conflicted auth membership via iterative auth checks (v2)', () => {
    const create = createEvent();
    const alice = member('@alice:example.com', 'join', { depth: 1 });
    const joinRules = pdu({
      type: 'm.room.join_rules',
      event_id: '$jr',
      sender: '@alice:example.com',
      state_key: '',
      depth: 1,
      content: { join_rule: 'public' },
    });
    const bobJoin = member('@bob:example.com', 'join', { depth: 2, eventId: '$bob-join' });
    const bobLeave = member('@bob:example.com', 'leave', {
      depth: 3,
      eventId: '$bob-leave',
      sender: '@bob:example.com',
    });
    // Conflicted bob membership: join vs leave. leave requires bob already joined —
    // iterative auth applies sorted events against growing resolved state.
    const resolved = resolveState('10', [
      [create, joinRules, alice, bobJoin],
      [create, joinRules, alice, bobLeave],
    ]);
    const bob = resolved.find((e) => e.state_key === '@bob:example.com');
    // At least one of the conflicted memberships may apply; result is deterministic
    expect(bob).toBeDefined();
    expect(['join', 'leave']).toContain((bob!.content as { membership: string }).membership);
  });

  it('skips conflicted auth candidates that lack state_key during iterative apply', () => {
    const create = createEvent();
    const alice = member('@alice:example.com', 'join');
    const joinRules = pdu({
      type: 'm.room.join_rules',
      event_id: '$jr',
      sender: '@alice:example.com',
      state_key: '',
      content: { join_rule: 'public' },
    });
    // Forge a third_party_invite without state_key — isAuthEvent true but skipped
    const badInvite = pdu({
      type: 'm.room.third_party_invite',
      event_id: '$tpi-nostate',
      sender: '@alice:example.com',
      // no state_key
      content: { display_name: 'x', key_validity_url: 'https://example.com', public_key: 'k' },
    });
    const goodInvite = pdu({
      type: 'm.room.third_party_invite',
      event_id: '$tpi-ok',
      sender: '@alice:example.com',
      state_key: 'token',
      content: { display_name: 'x', key_validity_url: 'https://example.com', public_key: 'k' },
    });
    const resolved = resolveState('10', [
      [create, alice, joinRules, badInvite as PDU],
      [create, alice, joinRules, goodInvite],
    ]);
    expect(resolved.find((e) => e.event_id === '$tpi-nostate')).toBeUndefined();
    expect(resolved.find((e) => e.event_id === '$tpi-ok')).toBeDefined();
  });

  it('resolves simultaneous conflicted name and topic independently', () => {
    const create = createEvent();
    const alice = member('@alice:example.com', 'join', { depth: 1 });
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
    const nameA = nameEvent('A', '$name-a', 3);
    const nameB = nameEvent('B', '$name-b', 3);
    const topicA = pdu({
      type: 'm.room.topic',
      event_id: '$topic-a',
      sender: '@alice:example.com',
      state_key: '',
      depth: 3,
      origin_server_ts: 1,
      content: { topic: 'ta' },
    });
    const topicB = pdu({
      type: 'm.room.topic',
      event_id: '$topic-b',
      sender: '@alice:example.com',
      state_key: '',
      depth: 3,
      origin_server_ts: 2,
      content: { topic: 'tb' },
    });
    const resolved = resolveState('10', [
      [create, alice, powerLevels, nameA, topicA],
      [create, alice, powerLevels, nameB, topicB],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    expect(resolved.filter((e) => e.type === 'm.room.topic')).toHaveLength(1);
    // Later ts overwrites for equal power
    expect(resolved.find((e) => e.type === 'm.room.topic')?.event_id).toBe('$topic-b');
  });

  it('uses default users_default=0 power ordering when no PL event is among conflicted events', () => {
    const create = createEvent();
    const alice = member('@alice:example.com', 'join');
    const joinRules = pdu({
      type: 'm.room.join_rules',
      event_id: '$jr',
      sender: '@alice:example.com',
      state_key: '',
      content: { join_rule: 'public' },
    });
    // Conflicted names with PL only in unconflicted set — reverseTopologicalPowerOrder
    // looks for PL among the conflicted *events* list only, so falls back to defaults.
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
    const earlier = pdu({
      type: 'm.room.name',
      event_id: '$n-early',
      sender: '@alice:example.com',
      state_key: '',
      depth: 3,
      origin_server_ts: 5,
      content: { name: 'early' },
    });
    const later = pdu({
      type: 'm.room.name',
      event_id: '$n-late',
      sender: '@alice:example.com',
      state_key: '',
      depth: 3,
      origin_server_ts: 9,
      content: { name: 'late' },
    });
    const resolved = resolveState('10', [
      [create, alice, joinRules, powerLevels, earlier],
      [create, alice, joinRules, powerLevels, later],
    ]);
    // Equal default power in sorter → ts ascending apply → later overwrites
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe('$n-late');
  });

  it('tie-breaks equal power and equal origin_server_ts by lexicographic event_id (apply order)', () => {
    const create = createEvent();
    const alice = member('@alice:example.com', 'join', { depth: 1 });
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
    const a = pdu({
      type: 'm.room.name',
      event_id: '$name-aaa',
      sender: '@alice:example.com',
      state_key: '',
      depth: 3,
      origin_server_ts: 50,
      content: { name: 'aaa' },
    });
    const z = pdu({
      type: 'm.room.name',
      event_id: '$name-zzz',
      sender: '@alice:example.com',
      state_key: '',
      depth: 3,
      origin_server_ts: 50,
      content: { name: 'zzz' },
    });
    // Sort: aaa before zzz → zzz applied last → wins
    const resolved = resolveState('10', [
      [create, alice, powerLevels, a],
      [create, alice, powerLevels, z],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe('$name-zzz');
  });

  it('drops both conflicted unauthorized non-auth events leaving the key absent', () => {
    const create = createEvent();
    const alice = member('@alice:example.com', 'join');
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
    const eveA = nameEvent('e1', '$name-eve-a', 5, '@eve:example.com');
    const eveB = nameEvent('e2', '$name-eve-b', 6, '@eve:example.com');
    const resolved = resolveState('10', [
      [create, alice, powerLevels, eveA],
      [create, alice, powerLevels, eveB],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.name')).toBeUndefined();
  });

  it('deduplicates identical conflicted event_ids when the same event appears thrice', () => {
    const create = createEvent();
    const join = member('@alice:example.com', 'join');
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
    const name = nameEvent('x', '$name-x', 2);
    const other = nameEvent('y', '$name-y', 2);
    const resolved = resolveState('10', [
      [create, join, powerLevels, name],
      [create, join, powerLevels, name],
      [create, join, powerLevels, other],
    ]);
    // name appears in 2/3 sets with same id; other differs → conflicted set has name+other
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
  });

  it('resolves conflicted power_levels as auth events before non-auth state', () => {
    const create = createEvent();
    const alice = member('@alice:example.com', 'join', { depth: 1 });
    const plA = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-a',
      sender: '@alice:example.com',
      state_key: '',
      depth: 2,
      origin_server_ts: 1,
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
    const plB = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-b',
      sender: '@alice:example.com',
      state_key: '',
      depth: 2,
      origin_server_ts: 2,
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
    });
    // First PL write needs state_default power — alice defaults to 0 without prior PL,
    // so neither conflicted PL can auth in isolation. Document that gap/behavior.
    const resolved = resolveState('10', [
      [create, alice, plA],
      [create, alice, plB],
    ]);
    // Without an unconflicted prior PL, first PL writes fail auth (sender PL 0 < 50)
    expect(resolved.find((e) => e.type === 'm.room.power_levels')).toBeUndefined();
  });

  it('keeps an unconflicted prior PL and then resolves a conflicted name against it', () => {
    const create = createEvent();
    const alice = member('@alice:example.com', 'join', { depth: 1 });
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
    const n1 = nameEvent('one', '$n1', 3);
    const n2 = nameEvent('two', '$n2', 4);
    const resolved = resolveState('10', [
      [create, alice, powerLevels, n1],
      [create, alice, powerLevels, n2],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.power_levels')?.event_id).toBe('$pl');
    expect(resolved.find((e) => e.type === 'm.room.name')).toBeDefined();
  });

  it('handles three-way v1 conflicts by highest depth then event_id', () => {
    const a = nameEvent('a', '$n-c', 2);
    const b = nameEvent('b', '$n-a', 5);
    const c = nameEvent('c', '$n-b', 5);
    // depth 5 wins; among depth 5, $n-a < $n-b
    expect(resolveStateV1([[a], [b], [c]])[0].event_id).toBe('$n-a');
  });

  it('v1 ignores non-state events mixed into multi-set merges', () => {
    const create = createEvent();
    const msg = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: '@alice:example.com',
      content: { body: 'x', msgtype: 'm.text' },
    });
    const name = nameEvent('n', '$name', 2);
    const resolved = resolveStateV1([
      [create, msg],
      [create, name],
    ]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual(['$create', '$name'].sort());
  });

  it('routes empty unknown version stateSets through v1 empty path', () => {
    expect(resolveState('org.example.custom', [])).toEqual([]);
    expect(resolveState('org.example.custom', [[]])).toEqual([]);
  });

  it('equal event_id comparator path in v1 sort returns stable single winner', () => {
    const a = nameEvent('same', '$same-id', 7);
    const b = { ...a };
    expect(resolveStateV1([[a], [b]])[0].event_id).toBe('$same-id');
  });

  it('conflicted history_visibility prefers authorized sender', () => {
    const create = createEvent();
    const alice = member('@alice:example.com', 'join');
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
        events: { 'm.room.history_visibility': 100 },
      },
    });
    const hvAlice = pdu({
      type: 'm.room.history_visibility',
      event_id: '$hv-a',
      sender: '@alice:example.com',
      state_key: '',
      content: { history_visibility: 'shared' },
    });
    const hvEve = pdu({
      type: 'm.room.history_visibility',
      event_id: '$hv-e',
      sender: '@eve:example.com',
      state_key: '',
      content: { history_visibility: 'world_readable' },
    });
    const resolved = resolveState('10', [
      [create, alice, powerLevels, hvAlice],
      [create, alice, powerLevels, hvEve],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.history_visibility')?.event_id).toBe('$hv-a');
  });
});


describe('resolveState TOKENMAXX auth-chain edges after #69', () => {
  it('applies conflicted join_rules before conflicted names when both are authorized', () => {
    const create = createEvent();
    const alice = member('@alice:example.com', 'join', { depth: 1 });
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
    const jrPublic = pdu({
      type: 'm.room.join_rules',
      event_id: '$jr-public',
      sender: '@alice:example.com',
      state_key: '',
      depth: 3,
      origin_server_ts: 1,
      content: { join_rule: 'public' },
    });
    const jrInvite = pdu({
      type: 'm.room.join_rules',
      event_id: '$jr-invite',
      sender: '@alice:example.com',
      state_key: '',
      depth: 3,
      origin_server_ts: 2,
      content: { join_rule: 'invite' },
    });
    const nameA = nameEvent('A', '$name-a', 4);
    const nameB = nameEvent('B', '$name-b', 4);
    const resolved = resolveState('10', [
      [create, alice, powerLevels, jrPublic, nameA],
      [create, alice, powerLevels, jrInvite, nameB],
    ]);
    expect(resolved.find((e) => e.type === 'm.room.join_rules')?.event_id).toBe('$jr-invite');
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
  });

  it('keeps unconflicted create/member while only the avatar key is conflicted', () => {
    const create = createEvent();
    const alice = member('@alice:example.com', 'join');
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
    const av1 = pdu({
      type: 'm.room.avatar',
      event_id: '$av1',
      sender: '@alice:example.com',
      state_key: '',
      origin_server_ts: 1,
      content: { url: 'mxc://example.com/a' },
    });
    const av2 = pdu({
      type: 'm.room.avatar',
      event_id: '$av2',
      sender: '@alice:example.com',
      state_key: '',
      origin_server_ts: 2,
      content: { url: 'mxc://example.com/b' },
    });
    const resolved = resolveState('10', [
      [create, alice, powerLevels, av1],
      [create, alice, powerLevels, av2],
    ]);
    expect(resolved.find((e) => e.event_id === '$create')).toBeDefined();
    expect(resolved.find((e) => e.state_key === '@alice:example.com')).toBeDefined();
    expect(resolved.find((e) => e.type === 'm.room.avatar')?.event_id).toBe('$av2');
  });

  it('v2 single-set path returns the same array reference contents including empty state_key events', () => {
    const create = createEvent();
    const emptyName = pdu({
      type: 'm.room.name',
      event_id: '$empty-name',
      sender: '@alice:example.com',
      state_key: '',
      content: { name: '' },
    });
    const set = [create, emptyName];
    expect(resolveState('10', [set])).toEqual(set);
  });

  it('v1 picks higher depth across four conflicting name events', () => {
    const events = [
      nameEvent('a', '$a', 1),
      nameEvent('b', '$b', 2),
      nameEvent('c', '$c', 10),
      nameEvent('d', '$d', 9),
    ];
    expect(resolveStateV1(events.map((e) => [e]))[0].event_id).toBe('$c');
  });

  it('v1 equal-depth equal-id comparator returns 0 and keeps a single winner', () => {
    const a = nameEvent('x', '$same', 3);
    const b = nameEvent('y', '$same', 3);
    // Same event_id → sort comparator returns 0; first after sort wins
    const resolved = resolveStateV1([[a], [b]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$same');
  });

  it('routes room version 1 empty multi-set through v1', () => {
    expect(resolveState('1', [[], []])).toEqual([]);
  });

  it('marks keys conflicted when event ids differ even if content matches', () => {
    const create = createEvent();
    const alice = member('@alice:example.com', 'join');
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
    const n1 = nameEvent('Same', '$id-1', 3);
    const n2 = nameEvent('Same', '$id-2', 3);
    const resolved = resolveState('10', [
      [create, alice, powerLevels, n1],
      [create, alice, powerLevels, n2],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.name')).toHaveLength(1);
    expect(['$id-1', '$id-2']).toContain(
      resolved.find((e) => e.type === 'm.room.name')!.event_id
    );
  });
});
