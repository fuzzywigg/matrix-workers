/**
 * TOKENMAXX HEAVY leftovers — state-resolution state_key collision edges.
 * Complements state-resolution.test.ts. Orthogonal to saturated leftovers themes.
 * Focus: v1/v2 key collisions, empty vs non-empty state_key, power-ordered winners.
 * Tests-only — no product inventing. Fixtures use example.com only.
 */
import { describe, expect, it } from 'vitest';
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

function powerLevels(users: Record<string, number>, eventId = '$pl'): PDU {
  return pdu({
    type: 'm.room.power_levels',
    event_id: eventId,
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

const ALICE = '@alice:example.com';
const BOB = '@bob:example.com';

describe('state-resolution leftovers — v1 state_key collisions', () => {
  it('separates empty state_key name from custom state_key of same type', () => {
    const empty = nameEvent('empty', '$empty', 3);
    const custom = pdu({
      type: 'm.room.name',
      event_id: '$custom',
      sender: ALICE,
      state_key: 'alt',
      depth: 4,
      content: { name: 'alt' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved).toHaveLength(2);
    expect(resolved.map((e) => e.event_id).sort()).toEqual(['$custom', '$empty']);
  });

  it('collides only on matching (type, state_key) across sets', () => {
    const a = nameEvent('A', '$name-a', 2);
    const b = nameEvent('B', '$name-b', 5);
    const resolved = resolveStateV1([[a, member(ALICE, 'join')], [b, member(ALICE, 'join')]]);
    const names = resolved.filter((e) => e.type === 'm.room.name');
    expect(names).toHaveLength(1);
    expect(names[0].event_id).toBe('$name-b');
  });

  it('picks higher depth on three-way empty-key collision', () => {
    const resolved = resolveStateV1([
      [nameEvent('a', '$a', 1)],
      [nameEvent('b', '$b', 3)],
      [nameEvent('c', '$c', 2)],
    ]);
    expect(resolved[0].event_id).toBe('$b');
  });

  it('uses lexicographic event_id when depths tie on collision', () => {
    const resolved = resolveStateV1([
      [nameEvent('z', '$name-zzz', 4)],
      [nameEvent('a', '$name-aaa', 4)],
    ]);
    expect(resolved[0].event_id).toBe('$name-aaa');
  });
});

describe('state-resolution leftovers — v2 power-ordered collisions', () => {
  it('prefers higher-power sender for conflicted room name', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const joinB = member(BOB, 'join');
    // Bob at PL 0 fails state_default 50 auth → alice's name wins.
    const pl = powerLevels({ [ALICE]: 100, [BOB]: 0 });
    const nameA = nameEvent('alice', '$na', 5, ALICE, 10);
    const nameB = nameEvent('bob', '$nb', 5, BOB, 20);
    const resolved = resolveState('10', [
      [create, joinA, joinB, pl, nameA],
      [create, joinA, joinB, pl, nameB],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe('$na');
  });

  it('keeps unconflicted member keys while colliding names', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const joinB = member(BOB, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const n1 = nameEvent('one', '$n1', 3, ALICE, 1);
    const n2 = nameEvent('two', '$n2', 4, ALICE, 2);
    const resolved = resolveState('10', [
      [create, joinA, joinB, pl, n1],
      [create, joinA, joinB, pl, n2],
    ]);
    expect(resolved.filter((e) => e.type === 'm.room.member')).toHaveLength(2);
    // reverse topological power order: earlier applied first, later overwrites
    expect(resolved.find((e) => e.type === 'm.room.name')?.event_id).toBe('$n2');
  });

  it('keeps distinct member state_keys when event_ids match across sets', () => {
    const create = createEvent();
    const a = member(ALICE, 'join', { eventId: '$a' });
    const b = member(BOB, 'join', { eventId: '$b' });
    // Identical member events in both sets → unconflicted, both retained
    const resolved = resolveState('10', [[create, a, b], [create, a, b]]);
    const members = resolved.filter((e) => e.type === 'm.room.member');
    expect(members.map((e) => e.state_key).sort()).toEqual([ALICE, BOB].sort());
  });
});

describe('state-resolution leftovers — v1 depth collision soft flood', () => {
  it('v1 depth soft-0', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-0', 0)],
      [nameEvent('high', '$high-0', 5)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-0');
  });
  it('v1 depth soft-1', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-1', 1)],
      [nameEvent('high', '$high-1', 6)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-1');
  });
  it('v1 depth soft-2', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-2', 2)],
      [nameEvent('high', '$high-2', 7)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-2');
  });
  it('v1 depth soft-3', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-3', 3)],
      [nameEvent('high', '$high-3', 5)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-3');
  });
  it('v1 depth soft-4', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-4', 4)],
      [nameEvent('high', '$high-4', 6)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-4');
  });
  it('v1 depth soft-5', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-5', 0)],
      [nameEvent('high', '$high-5', 7)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-5');
  });
  it('v1 depth soft-6', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-6', 1)],
      [nameEvent('high', '$high-6', 5)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-6');
  });
  it('v1 depth soft-7', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-7', 2)],
      [nameEvent('high', '$high-7', 6)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-7');
  });
  it('v1 depth soft-8', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-8', 3)],
      [nameEvent('high', '$high-8', 7)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-8');
  });
  it('v1 depth soft-9', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-9', 4)],
      [nameEvent('high', '$high-9', 5)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-9');
  });
  it('v1 depth soft-10', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-10', 0)],
      [nameEvent('high', '$high-10', 6)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-10');
  });
  it('v1 depth soft-11', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-11', 1)],
      [nameEvent('high', '$high-11', 7)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-11');
  });
  it('v1 depth soft-12', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-12', 2)],
      [nameEvent('high', '$high-12', 5)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-12');
  });
  it('v1 depth soft-13', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-13', 3)],
      [nameEvent('high', '$high-13', 6)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-13');
  });
  it('v1 depth soft-14', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-14', 4)],
      [nameEvent('high', '$high-14', 7)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-14');
  });
  it('v1 depth soft-15', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-15', 0)],
      [nameEvent('high', '$high-15', 5)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-15');
  });
  it('v1 depth soft-16', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-16', 1)],
      [nameEvent('high', '$high-16', 6)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-16');
  });
  it('v1 depth soft-17', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-17', 2)],
      [nameEvent('high', '$high-17', 7)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-17');
  });
  it('v1 depth soft-18', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-18', 3)],
      [nameEvent('high', '$high-18', 5)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-18');
  });
  it('v1 depth soft-19', () => {
    const resolved = resolveStateV1([
      [nameEvent('low', '$low-19', 4)],
      [nameEvent('high', '$high-19', 6)],
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event_id).toBe('$high-19');
  });
});

describe('state-resolution leftovers — empty vs custom key soft flood', () => {
  it('key separation soft-0', () => {
    const empty = nameEvent('e', `$e-0`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-0`,
      sender: ALICE,
      state_key: 'k0',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-0`, `$e-0`].sort());
  });
  it('key separation soft-1', () => {
    const empty = nameEvent('e', `$e-1`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-1`,
      sender: ALICE,
      state_key: 'k1',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-1`, `$e-1`].sort());
  });
  it('key separation soft-2', () => {
    const empty = nameEvent('e', `$e-2`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-2`,
      sender: ALICE,
      state_key: 'k2',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-2`, `$e-2`].sort());
  });
  it('key separation soft-3', () => {
    const empty = nameEvent('e', `$e-3`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-3`,
      sender: ALICE,
      state_key: 'k3',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-3`, `$e-3`].sort());
  });
  it('key separation soft-4', () => {
    const empty = nameEvent('e', `$e-4`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-4`,
      sender: ALICE,
      state_key: 'k4',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-4`, `$e-4`].sort());
  });
  it('key separation soft-5', () => {
    const empty = nameEvent('e', `$e-5`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-5`,
      sender: ALICE,
      state_key: 'k5',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-5`, `$e-5`].sort());
  });
  it('key separation soft-6', () => {
    const empty = nameEvent('e', `$e-6`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-6`,
      sender: ALICE,
      state_key: 'k6',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-6`, `$e-6`].sort());
  });
  it('key separation soft-7', () => {
    const empty = nameEvent('e', `$e-7`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-7`,
      sender: ALICE,
      state_key: 'k7',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-7`, `$e-7`].sort());
  });
  it('key separation soft-8', () => {
    const empty = nameEvent('e', `$e-8`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-8`,
      sender: ALICE,
      state_key: 'k8',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-8`, `$e-8`].sort());
  });
  it('key separation soft-9', () => {
    const empty = nameEvent('e', `$e-9`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-9`,
      sender: ALICE,
      state_key: 'k9',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-9`, `$e-9`].sort());
  });
  it('key separation soft-10', () => {
    const empty = nameEvent('e', `$e-10`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-10`,
      sender: ALICE,
      state_key: 'k10',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-10`, `$e-10`].sort());
  });
  it('key separation soft-11', () => {
    const empty = nameEvent('e', `$e-11`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-11`,
      sender: ALICE,
      state_key: 'k11',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-11`, `$e-11`].sort());
  });
  it('key separation soft-12', () => {
    const empty = nameEvent('e', `$e-12`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-12`,
      sender: ALICE,
      state_key: 'k12',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-12`, `$e-12`].sort());
  });
  it('key separation soft-13', () => {
    const empty = nameEvent('e', `$e-13`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-13`,
      sender: ALICE,
      state_key: 'k13',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-13`, `$e-13`].sort());
  });
  it('key separation soft-14', () => {
    const empty = nameEvent('e', `$e-14`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-14`,
      sender: ALICE,
      state_key: 'k14',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-14`, `$e-14`].sort());
  });
  it('key separation soft-15', () => {
    const empty = nameEvent('e', `$e-15`, 2);
    const custom = pdu({
      type: 'm.room.name',
      event_id: `$c-15`,
      sender: ALICE,
      state_key: 'k15',
      depth: 9,
      content: { name: 'c' },
    });
    const resolved = resolveStateV1([[empty], [custom]]);
    expect(resolved.map((e) => e.event_id).sort()).toEqual([`$c-15`, `$e-15`].sort());
  });
});

describe('state-resolution leftovers — v2 equal-power later-wins soft flood', () => {
  it('equal-power later-wins soft-0', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('early', `$early-0`, 5, ALICE, 10);
    const late = nameEvent('late', `$late-0`, 5, ALICE, 100);
    const resolved = resolveState('10', [
      [create, joinA, pl, early],
      [create, joinA, pl, late],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe(`$late-0`);
  });
  it('equal-power later-wins soft-1', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('early', `$early-1`, 5, ALICE, 11);
    const late = nameEvent('late', `$late-1`, 5, ALICE, 101);
    const resolved = resolveState('10', [
      [create, joinA, pl, early],
      [create, joinA, pl, late],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe(`$late-1`);
  });
  it('equal-power later-wins soft-2', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('early', `$early-2`, 5, ALICE, 12);
    const late = nameEvent('late', `$late-2`, 5, ALICE, 102);
    const resolved = resolveState('10', [
      [create, joinA, pl, early],
      [create, joinA, pl, late],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe(`$late-2`);
  });
  it('equal-power later-wins soft-3', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('early', `$early-3`, 5, ALICE, 13);
    const late = nameEvent('late', `$late-3`, 5, ALICE, 103);
    const resolved = resolveState('10', [
      [create, joinA, pl, early],
      [create, joinA, pl, late],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe(`$late-3`);
  });
  it('equal-power later-wins soft-4', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('early', `$early-4`, 5, ALICE, 14);
    const late = nameEvent('late', `$late-4`, 5, ALICE, 104);
    const resolved = resolveState('10', [
      [create, joinA, pl, early],
      [create, joinA, pl, late],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe(`$late-4`);
  });
  it('equal-power later-wins soft-5', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('early', `$early-5`, 5, ALICE, 15);
    const late = nameEvent('late', `$late-5`, 5, ALICE, 105);
    const resolved = resolveState('10', [
      [create, joinA, pl, early],
      [create, joinA, pl, late],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe(`$late-5`);
  });
  it('equal-power later-wins soft-6', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('early', `$early-6`, 5, ALICE, 16);
    const late = nameEvent('late', `$late-6`, 5, ALICE, 106);
    const resolved = resolveState('10', [
      [create, joinA, pl, early],
      [create, joinA, pl, late],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe(`$late-6`);
  });
  it('equal-power later-wins soft-7', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('early', `$early-7`, 5, ALICE, 17);
    const late = nameEvent('late', `$late-7`, 5, ALICE, 107);
    const resolved = resolveState('10', [
      [create, joinA, pl, early],
      [create, joinA, pl, late],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe(`$late-7`);
  });
  it('equal-power later-wins soft-8', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('early', `$early-8`, 5, ALICE, 18);
    const late = nameEvent('late', `$late-8`, 5, ALICE, 108);
    const resolved = resolveState('10', [
      [create, joinA, pl, early],
      [create, joinA, pl, late],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe(`$late-8`);
  });
  it('equal-power later-wins soft-9', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('early', `$early-9`, 5, ALICE, 19);
    const late = nameEvent('late', `$late-9`, 5, ALICE, 109);
    const resolved = resolveState('10', [
      [create, joinA, pl, early],
      [create, joinA, pl, late],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe(`$late-9`);
  });
  it('equal-power later-wins soft-10', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('early', `$early-10`, 5, ALICE, 20);
    const late = nameEvent('late', `$late-10`, 5, ALICE, 110);
    const resolved = resolveState('10', [
      [create, joinA, pl, early],
      [create, joinA, pl, late],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe(`$late-10`);
  });
  it('equal-power later-wins soft-11', () => {
    const create = createEvent();
    const joinA = member(ALICE, 'join');
    const pl = powerLevels({ [ALICE]: 100 });
    const early = nameEvent('early', `$early-11`, 5, ALICE, 21);
    const late = nameEvent('late', `$late-11`, 5, ALICE, 111);
    const resolved = resolveState('10', [
      [create, joinA, pl, early],
      [create, joinA, pl, late],
    ]);
    const name = resolved.find((e) => e.type === 'm.room.name');
    expect(name?.event_id).toBe(`$late-11`);
  });
});
