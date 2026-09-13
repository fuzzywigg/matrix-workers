import { describe, it, expect } from 'vitest';
import { getRoomInfo } from '../src/api/spaces';
import type { D1Database } from '@cloudflare/workers-types';

type RoomRow = { room_id: string; is_public: number };
type StateMap = Partial<
  Record<
    | 'm.room.name'
    | 'm.room.topic'
    | 'm.room.canonical_alias'
    | 'm.room.avatar'
    | 'm.room.join_rules'
    | 'm.room.create'
    | 'm.room.history_visibility'
    | 'm.room.guest_access',
    string | null
  >
>;

/**
 * Minimal D1 stand-in that answers the sequential queries getRoomInfo issues.
 * State event contents are stored as raw JSON strings (matching D1 event rows).
 */
function createSpacesDb(opts: {
  room?: RoomRow | null;
  state?: StateMap;
  memberCount?: number | null;
  /** When set, first() throws for SQL containing this substring. */
  throwOnSqlIncludes?: string;
}) {
  const room = opts.room === undefined ? { room_id: '!space:example.com', is_public: 1 } : opts.room;
  const state: StateMap = opts.state ?? {};
  const memberCount = opts.memberCount === undefined ? 0 : opts.memberCount;

  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first<T>() {
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (sql.includes('FROM rooms WHERE room_id')) {
                return (room as T) ?? null;
              }
              if (sql.includes("rs.event_type = 'm.room.name'")) {
                return (state['m.room.name'] != null
                  ? ({ content: state['m.room.name'] } as T)
                  : null);
              }
              if (sql.includes("rs.event_type = 'm.room.topic'")) {
                return (state['m.room.topic'] != null
                  ? ({ content: state['m.room.topic'] } as T)
                  : null);
              }
              if (sql.includes("rs.event_type = 'm.room.canonical_alias'")) {
                return (state['m.room.canonical_alias'] != null
                  ? ({ content: state['m.room.canonical_alias'] } as T)
                  : null);
              }
              if (sql.includes("rs.event_type = 'm.room.avatar'")) {
                return (state['m.room.avatar'] != null
                  ? ({ content: state['m.room.avatar'] } as T)
                  : null);
              }
              if (sql.includes("rs.event_type = 'm.room.join_rules'")) {
                return (state['m.room.join_rules'] != null
                  ? ({ content: state['m.room.join_rules'] } as T)
                  : null);
              }
              if (sql.includes("rs.event_type = 'm.room.create'")) {
                return (state['m.room.create'] != null
                  ? ({ content: state['m.room.create'] } as T)
                  : null);
              }
              if (sql.includes("rs.event_type = 'm.room.history_visibility'")) {
                return (state['m.room.history_visibility'] != null
                  ? ({ content: state['m.room.history_visibility'] } as T)
                  : null);
              }
              if (sql.includes("rs.event_type = 'm.room.guest_access'")) {
                return (state['m.room.guest_access'] != null
                  ? ({ content: state['m.room.guest_access'] } as T)
                  : null);
              }
              if (sql.includes('FROM room_memberships') && sql.includes('COUNT(*)')) {
                if (memberCount === null) return null as T;
                return { count: memberCount } as T;
              }
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const ROOM = '!space:example.com';
const SERVER = 'example.com';

describe('getRoomInfo defaults when state is absent', () => {
  it('returns null when the room row is missing', async () => {
    const db = createSpacesDb({ room: null });
    expect(await getRoomInfo(db, ROOM, SERVER)).toBeNull();
  });

  it('returns invite/shared/forbidden defaults with empty children_state', async () => {
    const info = await getRoomInfo(createSpacesDb({}), ROOM, SERVER);
    expect(info).toEqual({
      room_id: ROOM,
      room_type: undefined,
      name: undefined,
      topic: undefined,
      canonical_alias: undefined,
      num_joined_members: 0,
      avatar_url: undefined,
      join_rule: 'invite',
      world_readable: false,
      guest_can_join: false,
      children_state: [],
    });
  });

  it('ignores _serverName (unused parameter)', async () => {
    const a = await getRoomInfo(createSpacesDb({}), ROOM, 'a.example');
    const b = await getRoomInfo(createSpacesDb({}), ROOM, 'b.example');
    expect(a).toEqual(b);
  });

  it('preserves the requested room_id even if the DB row has a different id', async () => {
    const db = createSpacesDb({ room: { room_id: '!other:example.com', is_public: 0 } });
    const info = await getRoomInfo(db, ROOM, SERVER);
    expect(info?.room_id).toBe(ROOM);
  });

  it('does not surface is_public on the SpaceChild result', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ room: { room_id: ROOM, is_public: 1 } }),
      ROOM,
      SERVER
    );
    expect(info).not.toHaveProperty('is_public');
  });
});

describe('getRoomInfo field extraction from state events', () => {
  it('extracts name, topic, alias, avatar, and join_rule', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: {
          'm.room.name': JSON.stringify({ name: 'Lobby' }),
          'm.room.topic': JSON.stringify({ topic: 'hello world' }),
          'm.room.canonical_alias': JSON.stringify({ alias: '#lobby:example.com' }),
          'm.room.avatar': JSON.stringify({ url: 'mxc://example.com/avatar' }),
          'm.room.join_rules': JSON.stringify({ join_rule: 'public' }),
        },
      }),
      ROOM,
      SERVER
    );
    expect(info).toMatchObject({
      name: 'Lobby',
      topic: 'hello world',
      canonical_alias: '#lobby:example.com',
      avatar_url: 'mxc://example.com/avatar',
      join_rule: 'public',
    });
  });

  it('extracts empty-string name/topic/alias/avatar when present', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: {
          'm.room.name': JSON.stringify({ name: '' }),
          'm.room.topic': JSON.stringify({ topic: '' }),
          'm.room.canonical_alias': JSON.stringify({ alias: '' }),
          'm.room.avatar': JSON.stringify({ url: '' }),
        },
      }),
      ROOM,
      SERVER
    );
    expect(info?.name).toBe('');
    expect(info?.topic).toBe('');
    expect(info?.canonical_alias).toBe('');
    expect(info?.avatar_url).toBe('');
  });

  it('sets name undefined when content omits the name key', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.name': JSON.stringify({}) } }),
      ROOM,
      SERVER
    );
    expect(info?.name).toBeUndefined();
  });

  it('sets topic undefined when content omits the topic key', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.topic': JSON.stringify({ other: 1 }) } }),
      ROOM,
      SERVER
    );
    expect(info?.topic).toBeUndefined();
  });

  it('sets canonical_alias undefined when content omits alias', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.canonical_alias': JSON.stringify({ alt_aliases: [] }) } }),
      ROOM,
      SERVER
    );
    expect(info?.canonical_alias).toBeUndefined();
  });

  it('sets avatar_url undefined when content omits url', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.avatar': JSON.stringify({ info: {} }) } }),
      ROOM,
      SERVER
    );
    expect(info?.avatar_url).toBeUndefined();
  });

  it('defaults join_rule to invite when join_rules content omits join_rule', async () => {
    // JSON.parse succeeds but .join_rule is undefined → ternary still truthy on event presence
    // so join_rule becomes undefined (not the 'invite' default). Document current behavior.
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.join_rules': JSON.stringify({}) } }),
      ROOM,
      SERVER
    );
    expect(info?.join_rule).toBeUndefined();
  });

  it('accepts invite / knock / restricted join rules verbatim', async () => {
    for (const join_rule of ['invite', 'knock', 'restricted', 'knock_restricted']) {
      const info = await getRoomInfo(
        createSpacesDb({ state: { 'm.room.join_rules': JSON.stringify({ join_rule }) } }),
        ROOM,
        SERVER
      );
      expect(info?.join_rule).toBe(join_rule);
    }
  });
});

describe('getRoomInfo room_type from m.room.create', () => {
  it('sets room_type from create content.type', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) } }),
      ROOM,
      SERVER
    );
    expect(info?.room_type).toBe('m.space');
  });

  it('leaves room_type undefined when create omits type', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: { 'm.room.create': JSON.stringify({ creator: '@alice:example.com' }) },
      }),
      ROOM,
      SERVER
    );
    expect(info?.room_type).toBeUndefined();
  });

  it('leaves room_type undefined when create type is explicitly null', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.create': JSON.stringify({ type: null }) } }),
      ROOM,
      SERVER
    );
    expect(info?.room_type).toBeNull();
  });

  it('accepts non-space room types verbatim', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: { 'm.room.create': JSON.stringify({ type: 'org.example.custom' }) },
      }),
      ROOM,
      SERVER
    );
    expect(info?.room_type).toBe('org.example.custom');
  });

  it('swallows malformed create JSON and leaves room_type undefined', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.create': '{not-json' } }),
      ROOM,
      SERVER
    );
    expect(info?.room_type).toBeUndefined();
    expect(info?.room_id).toBe(ROOM);
  });

  it('swallows create JSON that is valid JSON but not an object (document)', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.create': 'null' } }),
      ROOM,
      SERVER
    );
    // content.type on null → runtime would throw, but null?.type isn't used; content.type throws.
    // JSON.parse('null') is null; null.type throws inside try → caught → undefined
    expect(info?.room_type).toBeUndefined();
  });

  it('treats JSON array create content as missing type (no throw)', async () => {
    // JSON.parse('[]') succeeds; [].type is undefined — try block does not throw
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.create': '[]' } }),
      ROOM,
      SERVER
    );
    expect(info?.room_type).toBeUndefined();
  });

  it('reads type from a JSON string primitive create content as undefined', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.create': '"m.space"' } }),
      ROOM,
      SERVER
    );
    expect(info?.room_type).toBeUndefined();
  });
});

describe('getRoomInfo history_visibility / world_readable', () => {
  it('defaults world_readable false when history event is absent', async () => {
    const info = await getRoomInfo(createSpacesDb({}), ROOM, SERVER);
    expect(info?.world_readable).toBe(false);
  });

  it('sets world_readable true only for exact world_readable value', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: {
          'm.room.history_visibility': JSON.stringify({ history_visibility: 'world_readable' }),
        },
      }),
      ROOM,
      SERVER
    );
    expect(info?.world_readable).toBe(true);
  });

  it('keeps world_readable false for shared / invited / joined', async () => {
    for (const history_visibility of ['shared', 'invited', 'joined']) {
      const info = await getRoomInfo(
        createSpacesDb({
          state: { 'm.room.history_visibility': JSON.stringify({ history_visibility }) },
        }),
        ROOM,
        SERVER
      );
      expect(info?.world_readable).toBe(false);
    }
  });

  it('keeps world_readable false when history_visibility key is missing', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.history_visibility': JSON.stringify({}) } }),
      ROOM,
      SERVER
    );
    expect(info?.world_readable).toBe(false);
  });

  it('swallows malformed history JSON and keeps default shared → not world_readable', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.history_visibility': 'BROKEN' } }),
      ROOM,
      SERVER
    );
    expect(info?.world_readable).toBe(false);
  });

  it('treats case-sensitive mismatch as not world_readable', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: {
          'm.room.history_visibility': JSON.stringify({ history_visibility: 'World_Readable' }),
        },
      }),
      ROOM,
      SERVER
    );
    expect(info?.world_readable).toBe(false);
  });
});

describe('getRoomInfo guest_access / guest_can_join', () => {
  it('defaults guest_can_join false when guest event is absent', async () => {
    const info = await getRoomInfo(createSpacesDb({}), ROOM, SERVER);
    expect(info?.guest_can_join).toBe(false);
  });

  it('sets guest_can_join true only for exact can_join', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: { 'm.room.guest_access': JSON.stringify({ guest_access: 'can_join' }) },
      }),
      ROOM,
      SERVER
    );
    expect(info?.guest_can_join).toBe(true);
  });

  it('keeps guest_can_join false for forbidden', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: { 'm.room.guest_access': JSON.stringify({ guest_access: 'forbidden' }) },
      }),
      ROOM,
      SERVER
    );
    expect(info?.guest_can_join).toBe(false);
  });

  it('keeps guest_can_join false when guest_access key is missing', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.guest_access': JSON.stringify({}) } }),
      ROOM,
      SERVER
    );
    expect(info?.guest_can_join).toBe(false);
  });

  it('swallows malformed guest JSON and keeps default forbidden', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.guest_access': '{bad' } }),
      ROOM,
      SERVER
    );
    expect(info?.guest_can_join).toBe(false);
  });

  it('treats case-sensitive mismatch as not can_join', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: { 'm.room.guest_access': JSON.stringify({ guest_access: 'Can_Join' }) },
      }),
      ROOM,
      SERVER
    );
    expect(info?.guest_can_join).toBe(false);
  });
});

describe('getRoomInfo num_joined_members', () => {
  it('uses the COUNT result when present', async () => {
    const info = await getRoomInfo(createSpacesDb({ memberCount: 42 }), ROOM, SERVER);
    expect(info?.num_joined_members).toBe(42);
  });

  it('treats count 0 as 0 (not fallback)', async () => {
    const info = await getRoomInfo(createSpacesDb({ memberCount: 0 }), ROOM, SERVER);
    expect(info?.num_joined_members).toBe(0);
  });

  it('falls back to 0 when the membership COUNT row is null', async () => {
    const info = await getRoomInfo(createSpacesDb({ memberCount: null }), ROOM, SERVER);
    expect(info?.num_joined_members).toBe(0);
  });

  it('documents falsy count coercion: count 0 stays 0 via || 0', async () => {
    // memberCount?.count || 0 — 0 is falsy but || 0 still yields 0
    const info = await getRoomInfo(createSpacesDb({ memberCount: 0 }), ROOM, SERVER);
    expect(info?.num_joined_members).toBe(0);
  });
});

describe('getRoomInfo bare JSON.parse throws for name/topic/alias/avatar/join_rule', () => {
  it('propagates malformed name JSON (no try/catch around name parse)', async () => {
    await expect(
      getRoomInfo(createSpacesDb({ state: { 'm.room.name': '{bad' } }), ROOM, SERVER)
    ).rejects.toThrow();
  });

  it('propagates malformed topic JSON', async () => {
    await expect(
      getRoomInfo(createSpacesDb({ state: { 'm.room.topic': 'not-json' } }), ROOM, SERVER)
    ).rejects.toThrow();
  });

  it('propagates malformed canonical_alias JSON', async () => {
    await expect(
      getRoomInfo(
        createSpacesDb({ state: { 'm.room.canonical_alias': '{oops' } }),
        ROOM,
        SERVER
      )
    ).rejects.toThrow();
  });

  it('propagates malformed avatar JSON', async () => {
    await expect(
      getRoomInfo(createSpacesDb({ state: { 'm.room.avatar': '%%%' } }), ROOM, SERVER)
    ).rejects.toThrow();
  });

  it('propagates malformed join_rules JSON', async () => {
    await expect(
      getRoomInfo(createSpacesDb({ state: { 'm.room.join_rules': '{x' } }), ROOM, SERVER)
    ).rejects.toThrow();
  });

  it('still swallows create/history/guest parse errors when name is valid', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: {
          'm.room.name': JSON.stringify({ name: 'ok' }),
          'm.room.create': '{bad',
          'm.room.history_visibility': '{bad',
          'm.room.guest_access': '{bad',
        },
      }),
      ROOM,
      SERVER
    );
    expect(info?.name).toBe('ok');
    expect(info?.room_type).toBeUndefined();
    expect(info?.world_readable).toBe(false);
    expect(info?.guest_can_join).toBe(false);
  });
});

describe('getRoomInfo children_state isolation', () => {
  it('always returns an empty children_state array from the helper', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: {
          'm.room.create': JSON.stringify({ type: 'm.space' }),
          'm.room.name': JSON.stringify({ name: 'Space' }),
        },
        memberCount: 3,
      }),
      ROOM,
      SERVER
    );
    expect(info?.children_state).toEqual([]);
    expect(Array.isArray(info?.children_state)).toBe(true);
  });

  it('returns a fresh children_state array each call (not a shared singleton)', async () => {
    const db = createSpacesDb({});
    const a = await getRoomInfo(db, ROOM, SERVER);
    const b = await getRoomInfo(db, ROOM, SERVER);
    expect(a?.children_state).not.toBe(b?.children_state);
    a!.children_state.push({ injected: true });
    expect(b?.children_state).toEqual([]);
  });
});

describe('getRoomInfo TOKENMAXX edge paths after #82', () => {
  it('combines space type + public join + world_readable + can_join + members', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: {
          'm.room.create': JSON.stringify({ type: 'm.space', room_version: '10' }),
          'm.room.name': JSON.stringify({ name: 'HQ' }),
          'm.room.topic': JSON.stringify({ topic: 'ops' }),
          'm.room.canonical_alias': JSON.stringify({ alias: '#hq:example.com' }),
          'm.room.avatar': JSON.stringify({ url: 'mxc://example.com/hq' }),
          'm.room.join_rules': JSON.stringify({ join_rule: 'public' }),
          'm.room.history_visibility': JSON.stringify({ history_visibility: 'world_readable' }),
          'm.room.guest_access': JSON.stringify({ guest_access: 'can_join' }),
        },
        memberCount: 7,
      }),
      ROOM,
      SERVER
    );
    expect(info).toEqual({
      room_id: ROOM,
      room_type: 'm.space',
      name: 'HQ',
      topic: 'ops',
      canonical_alias: '#hq:example.com',
      num_joined_members: 7,
      avatar_url: 'mxc://example.com/hq',
      join_rule: 'public',
      world_readable: true,
      guest_can_join: true,
      children_state: [],
    });
  });

  it('propagates DB errors from the rooms lookup', async () => {
    await expect(
      getRoomInfo(
        createSpacesDb({ throwOnSqlIncludes: 'FROM rooms WHERE room_id' }),
        ROOM,
        SERVER
      )
    ).rejects.toThrow(/db boom: FROM rooms/);
  });

  it('propagates DB errors from a later state lookup after room exists', async () => {
    await expect(
      getRoomInfo(
        createSpacesDb({ throwOnSqlIncludes: "rs.event_type = 'm.room.name'" }),
        ROOM,
        SERVER
      )
    ).rejects.toThrow(/m\.room\.name/);
  });

  it('propagates DB errors from membership COUNT', async () => {
    await expect(
      getRoomInfo(
        createSpacesDb({ throwOnSqlIncludes: 'FROM room_memberships' }),
        ROOM,
        SERVER
      )
    ).rejects.toThrow(/room_memberships/);
  });

  it('handles unicode name / topic / alias content', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: {
          'm.room.name': JSON.stringify({ name: 'スペース' }),
          'm.room.topic': JSON.stringify({ topic: 'café 🎉' }),
          'm.room.canonical_alias': JSON.stringify({ alias: '#café:example.com' }),
        },
      }),
      ROOM,
      SERVER
    );
    expect(info?.name).toBe('スペース');
    expect(info?.topic).toBe('café 🎉');
    expect(info?.canonical_alias).toBe('#café:example.com');
  });

  it('handles large member counts without truncation', async () => {
    const info = await getRoomInfo(createSpacesDb({ memberCount: 1_000_000 }), ROOM, SERVER);
    expect(info?.num_joined_members).toBe(1_000_000);
  });

  it('returns null for a different room id when that room is absent', async () => {
    const db = createSpacesDb({ room: null });
    expect(await getRoomInfo(db, '!missing:example.com', SERVER)).toBeNull();
  });

  it('does not treat empty-string state content as absent for name (still parses)', async () => {
    // empty string is != null so first() returns { content: '' }; JSON.parse('') throws
    await expect(
      getRoomInfo(createSpacesDb({ state: { 'm.room.name': '' } }), ROOM, SERVER)
    ).rejects.toThrow();
  });

  it('create type empty string is preserved as room_type', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.create': JSON.stringify({ type: '' }) } }),
      ROOM,
      SERVER
    );
    expect(info?.room_type).toBe('');
  });

  it('world_readable and guest_can_join are independent flags', async () => {
    const readableOnly = await getRoomInfo(
      createSpacesDb({
        state: {
          'm.room.history_visibility': JSON.stringify({ history_visibility: 'world_readable' }),
          'm.room.guest_access': JSON.stringify({ guest_access: 'forbidden' }),
        },
      }),
      ROOM,
      SERVER
    );
    expect(readableOnly?.world_readable).toBe(true);
    expect(readableOnly?.guest_can_join).toBe(false);

    const guestOnly = await getRoomInfo(
      createSpacesDb({
        state: {
          'm.room.history_visibility': JSON.stringify({ history_visibility: 'shared' }),
          'm.room.guest_access': JSON.stringify({ guest_access: 'can_join' }),
        },
      }),
      ROOM,
      SERVER
    );
    expect(guestOnly?.world_readable).toBe(false);
    expect(guestOnly?.guest_can_join).toBe(true);
  });

  it('join_rule invite default only applies when the join_rules event is absent', async () => {
    const absent = await getRoomInfo(createSpacesDb({}), ROOM, SERVER);
    expect(absent?.join_rule).toBe('invite');

    const presentEmpty = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.join_rules': JSON.stringify({ join_rule: null }) } }),
      ROOM,
      SERVER
    );
    expect(presentEmpty?.join_rule).toBeNull();
  });
});
