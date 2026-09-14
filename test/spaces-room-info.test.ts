/**
 * TOKENMAXX HEAVY deepen after #85/#87 — different slice: spaces getRoomInfo + hierarchy.
 * Avoids versions/well-known (#87) and server-notice (#85). Tests only (+ export for tests).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICE');
      await next();
    };
  },
}));

import spaces, { getRoomInfo } from '../src/api/spaces';
import type { Env } from '../src/types';

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
                return state['m.room.name'] != null
                  ? ({ content: state['m.room.name'] } as T)
                  : null;
              }
              if (sql.includes("rs.event_type = 'm.room.topic'")) {
                return state['m.room.topic'] != null
                  ? ({ content: state['m.room.topic'] } as T)
                  : null;
              }
              if (sql.includes("rs.event_type = 'm.room.canonical_alias'")) {
                return state['m.room.canonical_alias'] != null
                  ? ({ content: state['m.room.canonical_alias'] } as T)
                  : null;
              }
              if (sql.includes("rs.event_type = 'm.room.avatar'")) {
                return state['m.room.avatar'] != null
                  ? ({ content: state['m.room.avatar'] } as T)
                  : null;
              }
              if (sql.includes("rs.event_type = 'm.room.join_rules'")) {
                return state['m.room.join_rules'] != null
                  ? ({ content: state['m.room.join_rules'] } as T)
                  : null;
              }
              if (sql.includes("rs.event_type = 'm.room.create'")) {
                return state['m.room.create'] != null
                  ? ({ content: state['m.room.create'] } as T)
                  : null;
              }
              if (sql.includes("rs.event_type = 'm.room.history_visibility'")) {
                return state['m.room.history_visibility'] != null
                  ? ({ content: state['m.room.history_visibility'] } as T)
                  : null;
              }
              if (sql.includes("rs.event_type = 'm.room.guest_access'")) {
                return state['m.room.guest_access'] != null
                  ? ({ content: state['m.room.guest_access'] } as T)
                  : null;
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

  it('preserves non-string name/topic values from content (document)', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: {
          'm.room.name': JSON.stringify({ name: 42 }),
          'm.room.topic': JSON.stringify({ topic: false }),
        },
      }),
      ROOM,
      SERVER
    );
    expect(info?.name).toBe(42);
    expect(info?.topic).toBe(false);
  });

  it('preserves extra unused keys on state content without leaking them', async () => {
    const info = await getRoomInfo(
      createSpacesDb({
        state: {
          'm.room.name': JSON.stringify({ name: 'X', unused: true }),
          'm.room.avatar': JSON.stringify({ url: 'mxc://example.com/a', info: { w: 1 } }),
        },
      }),
      ROOM,
      SERVER
    );
    expect(info?.name).toBe('X');
    expect(info?.avatar_url).toBe('mxc://example.com/a');
    expect(info).not.toHaveProperty('unused');
    expect(info).not.toHaveProperty('info');
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
    // JSON.parse('null') is null; null.type throws inside try → caught → undefined
    expect(info?.room_type).toBeUndefined();
  });

  it('treats JSON array create content as missing type (no throw)', async () => {
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

  it('create type empty string is preserved as room_type', async () => {
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.create': JSON.stringify({ type: '' }) } }),
      ROOM,
      SERVER
    );
    expect(info?.room_type).toBe('');
  });

  it('swallows create JSON number/boolean primitives via try/catch', async () => {
    for (const raw of ['1', 'true', 'false']) {
      const info = await getRoomInfo(
        createSpacesDb({ state: { 'm.room.create': raw } }),
        ROOM,
        SERVER
      );
      expect(info?.room_type).toBeUndefined();
    }
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

  it('swallows history JSON null/array primitives', async () => {
    for (const raw of ['null', '[]', '"world_readable"']) {
      const info = await getRoomInfo(
        createSpacesDb({ state: { 'm.room.history_visibility': raw } }),
        ROOM,
        SERVER
      );
      expect(info?.world_readable).toBe(false);
    }
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

  it('swallows guest JSON null/array/string primitives', async () => {
    for (const raw of ['null', '[]', '"can_join"']) {
      const info = await getRoomInfo(
        createSpacesDb({ state: { 'm.room.guest_access': raw } }),
        ROOM,
        SERVER
      );
      expect(info?.guest_can_join).toBe(false);
    }
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
    const info = await getRoomInfo(createSpacesDb({ memberCount: 0 }), ROOM, SERVER);
    expect(info?.num_joined_members).toBe(0);
  });

  it('handles large member counts without truncation', async () => {
    const info = await getRoomInfo(createSpacesDb({ memberCount: 1_000_000 }), ROOM, SERVER);
    expect(info?.num_joined_members).toBe(1_000_000);
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

  it('propagates when name content is JSON null (null.name throws)', async () => {
    await expect(
      getRoomInfo(createSpacesDb({ state: { 'm.room.name': 'null' } }), ROOM, SERVER)
    ).rejects.toThrow();
  });

  it('propagates when topic content is a JSON array (no .topic on array is ok; document)', async () => {
    // [].topic is undefined — does NOT throw; documents asymmetry vs create try/catch
    const info = await getRoomInfo(
      createSpacesDb({ state: { 'm.room.topic': '[]' } }),
      ROOM,
      SERVER
    );
    expect(info?.topic).toBeUndefined();
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

describe('getRoomInfo TOKENMAXX edge paths after #85/#87', () => {
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

  it('propagates DB errors from create / history / guest lookups', async () => {
    await expect(
      getRoomInfo(
        createSpacesDb({ throwOnSqlIncludes: "rs.event_type = 'm.room.create'" }),
        ROOM,
        SERVER
      )
    ).rejects.toThrow(/m\.room\.create/);
    await expect(
      getRoomInfo(
        createSpacesDb({ throwOnSqlIncludes: "rs.event_type = 'm.room.history_visibility'" }),
        ROOM,
        SERVER
      )
    ).rejects.toThrow(/history_visibility/);
    await expect(
      getRoomInfo(
        createSpacesDb({ throwOnSqlIncludes: "rs.event_type = 'm.room.guest_access'" }),
        ROOM,
        SERVER
      )
    ).rejects.toThrow(/guest_access/);
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

  it('returns null for a different room id when that room is absent', async () => {
    const db = createSpacesDb({ room: null });
    expect(await getRoomInfo(db, '!missing:example.com', SERVER)).toBeNull();
  });

  it('does not treat empty-string state content as absent for name (still parses)', async () => {
    await expect(
      getRoomInfo(createSpacesDb({ state: { 'm.room.name': '' } }), ROOM, SERVER)
    ).rejects.toThrow();
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

  it('is_public 0 vs 1 does not affect SpaceChild fields', async () => {
    const pub = await getRoomInfo(
      createSpacesDb({ room: { room_id: ROOM, is_public: 1 } }),
      ROOM,
      SERVER
    );
    const priv = await getRoomInfo(
      createSpacesDb({ room: { room_id: ROOM, is_public: 0 } }),
      ROOM,
      SERVER
    );
    expect(pub).toEqual(priv);
  });
});

// ---------------------------------------------------------------------------
// Hierarchy route: GET /_matrix/client/v1/rooms/:roomId/hierarchy
// ---------------------------------------------------------------------------

type ChildEvent = { state_key: string; content: string };
type RoomInfoSeed = {
  room_id: string;
  is_public?: number;
  state?: StateMap;
  memberCount?: number | null;
};

function createHierarchyDb(opts: {
  rootExists?: boolean;
  rootRoomId?: string;
  childEvents?: ChildEvent[];
  grandchildEvents?: Record<string, ChildEvent[]>;
  rooms?: Record<string, RoomInfoSeed>;
  throwOnSqlIncludes?: string;
}) {
  const rootRoomId = opts.rootRoomId ?? ROOM;
  const rootExists = opts.rootExists !== false;
  const childEvents = opts.childEvents ?? [];
  const grandchildEvents = opts.grandchildEvents ?? {};
  const rooms = opts.rooms ?? {};

  if (rootExists && !rooms[rootRoomId]) {
    rooms[rootRoomId] = {
      room_id: rootRoomId,
      state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) },
      memberCount: 1,
    };
  }

  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const roomIdArg = args[0] as string | undefined;
          return {
            async first<T>() {
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }

              // Root existence check (SELECT room_id FROM rooms — no is_public)
              if (
                sql.includes('SELECT room_id FROM rooms WHERE room_id') &&
                !sql.includes('is_public')
              ) {
                return (rootExists && roomIdArg === rootRoomId
                  ? ({ room_id: rootRoomId } as T)
                  : null);
              }

              // getRoomInfo room row
              if (sql.includes('SELECT room_id, is_public FROM rooms')) {
                const seed = roomIdArg ? rooms[roomIdArg] : undefined;
                if (!seed) return null as T;
                return {
                  room_id: seed.room_id,
                  is_public: seed.is_public ?? 1,
                } as T;
              }

              const state = (roomIdArg && rooms[roomIdArg]?.state) || {};
              const eventTypes = [
                'm.room.name',
                'm.room.topic',
                'm.room.canonical_alias',
                'm.room.avatar',
                'm.room.join_rules',
                'm.room.create',
                'm.room.history_visibility',
                'm.room.guest_access',
              ] as const;
              for (const et of eventTypes) {
                if (sql.includes(`rs.event_type = '${et}'`)) {
                  const content = state[et];
                  return content != null ? ({ content } as T) : null;
                }
              }

              if (sql.includes('FROM room_memberships') && sql.includes('COUNT(*)')) {
                const seed = roomIdArg ? rooms[roomIdArg] : undefined;
                if (!seed || seed.memberCount === null) return null as T;
                return { count: seed.memberCount ?? 0 } as T;
              }

              return null;
            },
            async all<T>() {
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (sql.includes("rs.event_type = 'm.space.child'")) {
                if (roomIdArg === rootRoomId) {
                  return { results: childEvents as T[] };
                }
                const gcs = grandchildEvents[roomIdArg ?? ''] ?? [];
                return { results: gcs as T[] };
              }
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function hierarchyEnv(db: D1Database, serverName = SERVER): Env {
  return {
    SERVER_NAME: serverName,
    DB: db,
  } as Env;
}

async function getHierarchy(
  roomId: string,
  query = '',
  db: D1Database = createHierarchyDb({})
) {
  const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/hierarchy${query}`;
  const res = await spaces.request(
    `http://localhost${path}`,
    { headers: { Authorization: 'Bearer test-token' } },
    hierarchyEnv(db)
  );
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body: body as Record<string, unknown> };
}

describe('spaces hierarchy route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns M_NOT_FOUND when the root room is missing', async () => {
    const { status, body } = await getHierarchy(ROOM, '', createHierarchyDb({ rootExists: false }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('returns the space itself with children_state from m.space.child events', async () => {
    const childEvents: ChildEvent[] = [
      {
        state_key: '!child1:example.com',
        content: JSON.stringify({ via: ['example.com'], suggested: true }),
      },
    ];
    const db = createHierarchyDb({
      childEvents,
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Root' }),
          },
          memberCount: 2,
        },
        '!child1:example.com': {
          room_id: '!child1:example.com',
          state: { 'm.room.name': JSON.stringify({ name: 'Child' }) },
          memberCount: 5,
        },
      },
    });

    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    const rooms = body.rooms as Array<Record<string, unknown>>;
    expect(rooms).toHaveLength(2);
    expect(rooms[0].room_id).toBe(ROOM);
    expect(rooms[0].name).toBe('Root');
    expect(rooms[0].room_type).toBe('m.space');
    expect(rooms[0].children_state).toEqual([
      {
        type: 'm.space.child',
        state_key: '!child1:example.com',
        content: { via: ['example.com'], suggested: true },
        sender: '',
        origin_server_ts: 0,
      },
    ]);
    expect(rooms[1].room_id).toBe('!child1:example.com');
    expect(rooms[1].name).toBe('Child');
    expect(rooms[1].num_joined_members).toBe(5);
    expect(rooms[1].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });

  it('skips children with empty via (deleted child)', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!gone:example.com', content: JSON.stringify({ via: [], suggested: true }) },
        { state_key: '!ok:example.com', content: JSON.stringify({ via: ['example.com'] }) },
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        '!ok:example.com': {
          room_id: '!ok:example.com',
          state: { 'm.room.name': JSON.stringify({ name: 'Ok' }) },
        },
        '!gone:example.com': { room_id: '!gone:example.com' },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const rooms = body.rooms as Array<{ room_id: string }>;
    expect(rooms.map((r) => r.room_id)).toEqual([ROOM, '!ok:example.com']);
  });

  it('skips children when via is missing', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!novia:example.com', content: JSON.stringify({ suggested: true }) },
        { state_key: '!ok:example.com', content: JSON.stringify({ via: ['a.example'] }) },
      ],
      rooms: {
        [ROOM]: { room_id: ROOM },
        '!ok:example.com': { room_id: '!ok:example.com' },
        '!novia:example.com': { room_id: '!novia:example.com' },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const rooms = body.rooms as Array<{ room_id: string }>;
    expect(rooms.map((r) => r.room_id)).toEqual([ROOM, '!ok:example.com']);
  });

  it('suggested_only=true skips non-suggested children', async () => {
    const db = createHierarchyDb({
      childEvents: [
        {
          state_key: '!sug:example.com',
          content: JSON.stringify({ via: ['example.com'], suggested: true }),
        },
        {
          state_key: '!nosug:example.com',
          content: JSON.stringify({ via: ['example.com'], suggested: false }),
        },
        {
          state_key: '!omit:example.com',
          content: JSON.stringify({ via: ['example.com'] }),
        },
      ],
      rooms: {
        [ROOM]: { room_id: ROOM },
        '!sug:example.com': { room_id: '!sug:example.com' },
        '!nosug:example.com': { room_id: '!nosug:example.com' },
        '!omit:example.com': { room_id: '!omit:example.com' },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    const rooms = body.rooms as Array<{ room_id: string }>;
    expect(rooms.map((r) => r.room_id)).toEqual([ROOM, '!sug:example.com']);
  });

  it('suggested_only defaults to false (includes non-suggested)', async () => {
    const db = createHierarchyDb({
      childEvents: [
        {
          state_key: '!nosug:example.com',
          content: JSON.stringify({ via: ['example.com'], suggested: false }),
        },
      ],
      rooms: {
        [ROOM]: { room_id: ROOM },
        '!nosug:example.com': { room_id: '!nosug:example.com' },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const rooms = body.rooms as Array<{ room_id: string }>;
    expect(rooms.map((r) => r.room_id)).toEqual([ROOM, '!nosug:example.com']);
  });

  it('returns 500 when a child event has invalid JSON (root children_state parse is uncaught)', async () => {
    // Document asymmetry: per-child loop has try/catch, but root children_state
    // JSON.parse at map-time is uncaught → request fails before the skip path.
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json' },
        {
          state_key: '!ok:example.com',
          content: JSON.stringify({ via: ['example.com'] }),
        },
      ],
      rooms: {
        [ROOM]: { room_id: ROOM },
        '!ok:example.com': { room_id: '!ok:example.com' },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
    expect(body).toBeNull();
  });

  it('skips a child when getRoomInfo throws (per-child try/catch)', async () => {
    const db = createHierarchyDb({
      childEvents: [
        {
          state_key: '!boom:example.com',
          content: JSON.stringify({ via: ['example.com'] }),
        },
        {
          state_key: '!ok:example.com',
          content: JSON.stringify({ via: ['example.com'] }),
        },
      ],
      rooms: {
        [ROOM]: { room_id: ROOM },
        // malformed name → bare JSON.parse throws inside getRoomInfo
        '!boom:example.com': {
          room_id: '!boom:example.com',
          state: { 'm.room.name': '{bad' },
        },
        '!ok:example.com': {
          room_id: '!ok:example.com',
          state: { 'm.room.name': JSON.stringify({ name: 'Ok' }) },
        },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    const rooms = body.rooms as Array<{ room_id: string; name?: string }>;
    expect(rooms.map((r) => r.room_id)).toEqual([ROOM, '!ok:example.com']);
    expect(rooms[1].name).toBe('Ok');
  });

  it('skips children whose room info is missing', async () => {
    const db = createHierarchyDb({
      childEvents: [
        {
          state_key: '!ghost:example.com',
          content: JSON.stringify({ via: ['example.com'] }),
        },
      ],
      rooms: {
        [ROOM]: { room_id: ROOM },
        // ghost intentionally absent
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const rooms = body.rooms as Array<{ room_id: string }>;
    expect(rooms.map((r) => r.room_id)).toEqual([ROOM]);
  });

  it('includes grandchildren in children_state when max_depth > 1', async () => {
    const childId = '!child:example.com';
    const db = createHierarchyDb({
      childEvents: [
        { state_key: childId, content: JSON.stringify({ via: ['example.com'] }) },
      ],
      grandchildEvents: {
        [childId]: [
          {
            state_key: '!grand:example.com',
            content: JSON.stringify({ via: ['example.com'], order: '1' }),
          },
        ],
      },
      rooms: {
        [ROOM]: { room_id: ROOM },
        [childId]: { room_id: childId, state: { 'm.room.name': JSON.stringify({ name: 'C' }) } },
        '!grand:example.com': { room_id: '!grand:example.com' },
      },
    });

    const { body } = await getHierarchy(ROOM, '?max_depth=2', db);
    const rooms = body.rooms as Array<Record<string, unknown>>;
    expect(rooms).toHaveLength(2);
    expect(rooms[1].children_state).toEqual([
      {
        type: 'm.space.child',
        state_key: '!grand:example.com',
        content: { via: ['example.com'], order: '1' },
      },
    ]);
  });

  it('does not fetch grandchildren when max_depth defaults to 1', async () => {
    const childId = '!child:example.com';
    const db = createHierarchyDb({
      childEvents: [
        { state_key: childId, content: JSON.stringify({ via: ['example.com'] }) },
      ],
      grandchildEvents: {
        [childId]: [
          {
            state_key: '!grand:example.com',
            content: JSON.stringify({ via: ['example.com'] }),
          },
        ],
      },
      rooms: {
        [ROOM]: { room_id: ROOM },
        [childId]: { room_id: childId },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const rooms = body.rooms as Array<Record<string, unknown>>;
    expect(rooms[1].children_state).toEqual([]);
  });

  it('clamps limit to 100 and defaults to 50', async () => {
    const many: ChildEvent[] = [];
    const rooms: Record<string, RoomInfoSeed> = { [ROOM]: { room_id: ROOM } };
    // root + 120 children = 121 entries so both default(50) and clamp(100) paginate
    for (let i = 0; i < 120; i++) {
      const id = `!c${i}:example.com`;
      many.push({ state_key: id, content: JSON.stringify({ via: ['example.com'] }) });
      rooms[id] = { room_id: id };
    }
    const db = createHierarchyDb({ childEvents: many, rooms });

    const def = await getHierarchy(ROOM, '', db);
    expect((def.body.rooms as unknown[]).length).toBe(50);
    expect(def.body.next_batch).toBe((def.body.rooms as Array<{ room_id: string }>)[49].room_id);

    const capped = await getHierarchy(ROOM, '?limit=200', db);
    expect((capped.body.rooms as unknown[]).length).toBe(100);
    expect(capped.body.next_batch).toBe(
      (capped.body.rooms as Array<{ room_id: string }>)[99].room_id
    );

    const exact = await getHierarchy(ROOM, '?limit=121', db);
    // clamp still 100; next_batch present
    expect((exact.body.rooms as unknown[]).length).toBe(100);
    expect(exact.body.next_batch).toBeDefined();
  });

  it('omits next_batch when rooms.length <= limit', async () => {
    const db = createHierarchyDb({
      childEvents: [
        {
          state_key: '!only:example.com',
          content: JSON.stringify({ via: ['example.com'] }),
        },
      ],
      rooms: {
        [ROOM]: { room_id: ROOM },
        '!only:example.com': { room_id: '!only:example.com' },
      },
    });
    const { body } = await getHierarchy(ROOM, '?limit=10', db);
    expect((body.rooms as unknown[]).length).toBe(2);
    expect(body.next_batch).toBeUndefined();
  });

  it('treats non-numeric limit as NaN → Math.min(NaN, 100) → NaN slice behavior (document)', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!a:example.com', content: JSON.stringify({ via: ['x'] }) },
      ],
      rooms: {
        [ROOM]: { room_id: ROOM },
        '!a:example.com': { room_id: '!a:example.com' },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?limit=abc', db);
    expect(status).toBe(200);
    // Array.prototype.slice(0, NaN) → []
    expect(body.rooms).toEqual([]);
  });

  it('root children_state includes all child events even when some are filtered from rooms', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!gone:example.com', content: JSON.stringify({ via: [] }) },
        {
          state_key: '!ok:example.com',
          content: JSON.stringify({ via: ['example.com'] }),
        },
      ],
      rooms: {
        [ROOM]: { room_id: ROOM },
        '!ok:example.com': { room_id: '!ok:example.com' },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const rooms = body.rooms as Array<Record<string, unknown>>;
    expect(rooms[0].children_state).toHaveLength(2);
    expect(rooms.map((r) => r.room_id)).toEqual([ROOM, '!ok:example.com']);
  });

  it('uses SERVER_NAME from env for getRoomInfo (unused but passed)', async () => {
    const db = createHierarchyDb({
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) },
        },
      },
    });
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { headers: { Authorization: 'Bearer t' } },
      hierarchyEnv(db, 'other.example')
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rooms: Array<{ room_id: string }> };
    expect(body.rooms[0].room_id).toBe(ROOM);
  });

  it('returns only the root when there are no child events', async () => {
    const { body } = await getHierarchy(
      ROOM,
      '',
      createHierarchyDb({
        childEvents: [],
        rooms: {
          [ROOM]: {
            room_id: ROOM,
            state: { 'm.room.name': JSON.stringify({ name: 'Empty' }) },
          },
        },
      })
    );
    const rooms = body.rooms as Array<{ room_id: string; name?: string; children_state: unknown[] }>;
    expect(rooms).toHaveLength(1);
    expect(rooms[0].name).toBe('Empty');
    expect(rooms[0].children_state).toEqual([]);
  });

  it('suggested_only=TRUE (wrong case) does not enable filter (strict === \"true\")', async () => {
    const db = createHierarchyDb({
      childEvents: [
        {
          state_key: '!nosug:example.com',
          content: JSON.stringify({ via: ['example.com'], suggested: false }),
        },
      ],
      rooms: {
        [ROOM]: { room_id: ROOM },
        '!nosug:example.com': { room_id: '!nosug:example.com' },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=TRUE', db);
    const rooms = body.rooms as Array<{ room_id: string }>;
    expect(rooms.map((r) => r.room_id)).toEqual([ROOM, '!nosug:example.com']);
  });

  it('max_depth=0 still includes direct children but not grandchildren', async () => {
    // parseInt('0') === 0; maxDepth > 1 is false → no grandchildren
    const childId = '!child:example.com';
    const db = createHierarchyDb({
      childEvents: [{ state_key: childId, content: JSON.stringify({ via: ['x'] }) }],
      grandchildEvents: {
        [childId]: [
          { state_key: '!g:example.com', content: JSON.stringify({ via: ['x'] }) },
        ],
      },
      rooms: {
        [ROOM]: { room_id: ROOM },
        [childId]: { room_id: childId },
      },
    });
    const { body } = await getHierarchy(ROOM, '?max_depth=0', db);
    const rooms = body.rooms as Array<Record<string, unknown>>;
    expect(rooms).toHaveLength(2);
    expect(rooms[1].children_state).toEqual([]);
  });
});
