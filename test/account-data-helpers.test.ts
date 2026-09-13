import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getGlobalAccountData,
  getRoomAccountData,
  getAllRoomAccountData,
  getAccountDataStreamPosition,
  getE2EEAccountDataFromDO,
} from '../src/api/account-data';
import type { Env } from '../src/types';

type AccountDataRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string | null;
};

type ChangeRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  stream_position: number;
};

function createAccountDataDb(opts: {
  rows?: AccountDataRow[];
  changes?: ChangeRow[];
  streamPosition?: number | null;
}) {
  const rows = [...(opts.rows ?? [])];
  const changes = [...(opts.changes ?? [])];
  const streamPosition =
    opts.streamPosition === undefined ? 42 : opts.streamPosition;
  const prepares: string[] = [];
  const binds: unknown[][] = [];

  function latestChangePos(
    userId: string,
    roomId: string,
    eventType: string
  ): number {
    return changes
      .filter(
        (c) =>
          c.user_id === userId &&
          c.room_id === roomId &&
          c.event_type === eventType
      )
      .reduce((max, c) => Math.max(max, c.stream_position), -Infinity);
  }

  function stmt(sql: string, args: unknown[] = []) {
    return {
      bind(...bindArgs: unknown[]) {
        binds.push(bindArgs);
        return stmt(sql, bindArgs);
      },
      async all<T>() {
        const isChangeJoin = sql.includes('account_data_changes');
        const isGlobal =
          sql.includes("room_id = ''") || sql.includes("room_id = ''");
        const isSingleRoom =
          !isGlobal && sql.includes('room_id = ?') && !sql.includes('IN (');
        const isMultiRoom = sql.includes('IN (');

        if (sql.includes('FROM account_data') || sql.includes('FROM account_data ad')) {
          if (isMultiRoom) {
            const userId = args[0] as string;
            const since = isChangeJoin ? (args[args.length - 1] as number) : undefined;
            const roomIds = (
              isChangeJoin ? args.slice(1, -1) : args.slice(1)
            ) as string[];

            const results: Array<{
              room_id: string;
              event_type: string;
              content: string | null;
            }> = [];

            for (const roomId of roomIds) {
              const roomRows = rows.filter(
                (r) => r.user_id === userId && r.room_id === roomId
              );
              for (const r of roomRows) {
                if (isChangeJoin) {
                  const pos = latestChangePos(userId, roomId, r.event_type);
                  if (!(pos > (since as number))) continue;
                }
                results.push({
                  room_id: r.room_id,
                  event_type: r.event_type,
                  content: r.content,
                });
              }
            }
            return { results: results as T[] };
          }

          if (isGlobal) {
            const userId = args[0] as string;
            const since = isChangeJoin ? (args[1] as number) : undefined;
            const filtered = rows.filter(
              (r) => r.user_id === userId && r.room_id === ''
            );
            const results = filtered
              .filter((r) => {
                if (!isChangeJoin) return true;
                const pos = latestChangePos(userId, '', r.event_type);
                return pos > (since as number);
              })
              .map((r) => ({
                event_type: r.event_type,
                content: r.content,
              }));
            return { results: results as T[] };
          }

          if (isSingleRoom) {
            const userId = args[0] as string;
            const roomId = args[1] as string;
            const since = isChangeJoin ? (args[2] as number) : undefined;
            const filtered = rows.filter(
              (r) => r.user_id === userId && r.room_id === roomId
            );
            const results = filtered
              .filter((r) => {
                if (!isChangeJoin) return true;
                const pos = latestChangePos(userId, roomId, r.event_type);
                return pos > (since as number);
              })
              .map((r) => ({
                event_type: r.event_type,
                content: r.content,
              }));
            return { results: results as T[] };
          }
        }

        return { results: [] as T[] };
      },
      async first<T>() {
        if (sql.includes('FROM stream_positions') && sql.includes('account_data')) {
          if (streamPosition === null) return null;
          return { position: streamPosition } as T;
        }
        return null;
      },
      async run() {
        return { meta: { changes: 0 } };
      },
    };
  }

  const db = {
    prepares,
    binds,
    prepare(sql: string) {
      prepares.push(sql);
      return stmt(sql);
    },
  };

  return db as unknown as D1Database & {
    prepares: string[];
    binds: unknown[][];
  };
}

function mockUserKeysNamespace(opts: {
  responses?: Map<string, Response | (() => Response) | (() => Promise<Response>)>;
  throwOnFetch?: Error;
  captureBodies?: boolean;
}) {
  const fetches: Array<{ url: string; method: string }> = [];
  const ids = new Map<string, { name: string }>();

  return {
    fetches,
    idFromName(userId: string) {
      const id = { name: userId };
      ids.set(userId, id);
      return id;
    },
    get(id: { name: string }) {
      return {
        async fetch(request: Request) {
          fetches.push({ url: request.url, method: request.method });
          if (opts.throwOnFetch) throw opts.throwOnFetch;
          const url = new URL(request.url);
          const key = url.searchParams.get('event_type') ?? '__all__';
          const entry = opts.responses?.get(key);
          if (!entry) {
            return new Response(JSON.stringify({}), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return typeof entry === 'function' ? await entry() : entry;
        },
      };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// getGlobalAccountData
// =============================================================================

describe('getGlobalAccountData', () => {
  it('returns full dump for room_id="" rows only (no since)', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ '@a:ex': ['!r1:ex'] }),
        },
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.ignored_user_list',
          content: JSON.stringify({ ignored_users: {} }),
        },
        {
          user_id: '@u:ex',
          room_id: '!room:ex',
          event_type: 'm.tag',
          content: JSON.stringify({ tags: { favourite: {} } }),
        },
        {
          user_id: '@other:ex',
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({}),
        },
      ],
    });

    const result = await getGlobalAccountData(db, '@u:ex');
    expect(result).toEqual([
      { type: 'm.direct', content: { '@a:ex': ['!r1:ex'] } },
      { type: 'm.ignored_user_list', content: { ignored_users: {} } },
    ]);
    expect(db.prepares.some((q) => q.includes('account_data_changes'))).toBe(false);
    expect(db.binds[0]).toEqual(['@u:ex']);
  });

  it('parses null/empty content as {}', async () => {
    const db = createAccountDataDb({
      rows: [
        { user_id: '@u:ex', room_id: '', event_type: 'm.direct', content: null },
        { user_id: '@u:ex', room_id: '', event_type: 'm.push_rules', content: '' },
      ],
    });
    const result = await getGlobalAccountData(db, '@u:ex');
    expect(result).toEqual([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
  });

  it('returns empty array when user has no global account data', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          content: '{}',
        },
      ],
    });
    expect(await getGlobalAccountData(db, '@u:ex')).toEqual([]);
  });

  it('returns empty array when database has no rows at all', async () => {
    const db = createAccountDataDb({});
    expect(await getGlobalAccountData(db, '@nobody:ex')).toEqual([]);
    expect(db.binds[0]).toEqual(['@nobody:ex']);
  });

  it('incremental since:0 uses change-join; includes pos>0, excludes pos==0', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          content: '{"a":1}',
        },
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.push_rules',
          content: '{"b":2}',
        },
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.ignored_user_list',
          content: '{"c":3}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          stream_position: 0,
        },
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.push_rules',
          stream_position: 1,
        },
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.ignored_user_list',
          stream_position: 5,
        },
      ],
    });

    const result = await getGlobalAccountData(db, '@u:ex', 0);
    expect(db.prepares.some((q) => q.includes('account_data_changes'))).toBe(true);
    expect(db.prepares.some((q) => q.includes('stream_position >'))).toBe(true);
    expect(db.binds[0]).toEqual(['@u:ex', 0]);
    expect(result.map((r) => r.type).sort()).toEqual([
      'm.ignored_user_list',
      'm.push_rules',
    ]);
    expect(result.find((r) => r.type === 'm.direct')).toBeUndefined();
  });

  it('incremental since:N uses strict >; pos==since excluded, pos==since+1 included', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'at-boundary',
          content: '{"x":1}',
        },
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'after-boundary',
          content: '{"y":2}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'at-boundary',
          stream_position: 10,
        },
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'after-boundary',
          stream_position: 11,
        },
      ],
    });

    const result = await getGlobalAccountData(db, '@u:ex', 10);
    expect(result).toEqual([{ type: 'after-boundary', content: { y: 2 } }]);
  });

  it('uses latest change position when multiple changes exist for same type', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          content: '{"v":2}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          stream_position: 3,
        },
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          stream_position: 12,
        },
      ],
    });

    expect(await getGlobalAccountData(db, '@u:ex', 10)).toEqual([
      { type: 'm.direct', content: { v: 2 } },
    ]);
    expect(await getGlobalAccountData(db, '@u:ex', 12)).toEqual([]);
  });

  it('treats since:undefined as full dump (no change-join) even when changes exist', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          content: '{"a":1}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          stream_position: 99,
        },
      ],
    });

    const result = await getGlobalAccountData(db, '@u:ex', undefined);
    expect(db.prepares.some((q) => q.includes('account_data_changes'))).toBe(false);
    expect(result).toEqual([{ type: 'm.direct', content: { a: 1 } }]);
  });

  it('ignores change rows for other users / room-scoped types on incremental global', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          content: '{"mine":true}',
        },
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.push_rules',
          content: '{"rules":[]}',
        },
      ],
      changes: [
        {
          user_id: '@other:ex',
          room_id: '',
          event_type: 'm.direct',
          stream_position: 50,
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          stream_position: 50,
        },
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.push_rules',
          stream_position: 50,
        },
      ],
    });

    const result = await getGlobalAccountData(db, '@u:ex', 40);
    expect(result).toEqual([{ type: 'm.push_rules', content: { rules: [] } }]);
  });

  it('preserves unicode / nested JSON content for secret-storage style types', async () => {
    const payload = {
      algorithm: 'm.secret_storage.v1.aes-hmac-sha2',
      passphrase: { algorithm: 'm.pbkdf2', salt: 'salt✨', iterations: 500_000 },
      iv: 'iv',
      mac: 'mac',
    };
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.secret_storage.key.default',
          content: JSON.stringify(payload),
        },
      ],
    });
    expect(await getGlobalAccountData(db, '@u:ex')).toEqual([
      { type: 'm.secret_storage.key.default', content: payload },
    ]);
  });

  it('excludes types with no change row on incremental sync (orphan account_data)', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'orphan',
          content: '{"x":1}',
        },
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'tracked',
          content: '{"x":2}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'tracked',
          stream_position: 3,
        },
      ],
    });

    expect(await getGlobalAccountData(db, '@u:ex', 0)).toEqual([
      { type: 'tracked', content: { x: 2 } },
    ]);
  });

  it('full dump still returns orphan types that have never been in account_data_changes', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'orphan',
          content: '{"x":1}',
        },
      ],
      changes: [],
    });
    expect(await getGlobalAccountData(db, '@u:ex')).toEqual([
      { type: 'orphan', content: { x: 1 } },
    ]);
  });

  it('binds large since values without coercing to full dump', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          content: '{}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          stream_position: 1_000_000,
        },
      ],
    });
    expect(await getGlobalAccountData(db, '@u:ex', 999_999)).toEqual([
      { type: 'm.direct', content: {} },
    ]);
    expect(db.binds[0]).toEqual(['@u:ex', 999_999]);
    expect(await getGlobalAccountData(db, '@u:ex', 1_000_000)).toEqual([]);
  });
});

// =============================================================================
// getRoomAccountData
// =============================================================================

describe('getRoomAccountData', () => {
  it('scopes to one room and excludes global + other rooms', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r1:ex',
          event_type: 'm.tag',
          content: JSON.stringify({ tags: { favourite: { order: 0.5 } } }),
        },
        {
          user_id: '@u:ex',
          room_id: '!r2:ex',
          event_type: 'm.tag',
          content: JSON.stringify({ tags: {} }),
        },
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          content: '{}',
        },
      ],
    });

    const result = await getRoomAccountData(db, '@u:ex', '!r1:ex');
    expect(result).toEqual([
      { type: 'm.tag', content: { tags: { favourite: { order: 0.5 } } } },
    ]);
    expect(db.binds[0]).toEqual(['@u:ex', '!r1:ex']);
  });

  it('parses empty content as {} for room data', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'im.vector.setting.breadcrumbs',
          content: '',
        },
      ],
    });
    expect(await getRoomAccountData(db, '@u:ex', '!r:ex')).toEqual([
      { type: 'im.vector.setting.breadcrumbs', content: {} },
    ]);
  });

  it('returns empty array for a room with no account data', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!other:ex',
          event_type: 'm.tag',
          content: '{}',
        },
      ],
    });
    expect(await getRoomAccountData(db, '@u:ex', '!missing:ex')).toEqual([]);
  });

  it('incremental since:0 includes only changes with pos>0 for that room', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          content: '{"tags":{}}',
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.fully_read',
          content: '{"event_id":"$e"}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          stream_position: 0,
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.fully_read',
          stream_position: 2,
        },
        {
          user_id: '@u:ex',
          room_id: '!other:ex',
          event_type: 'm.tag',
          stream_position: 9,
        },
      ],
    });

    const result = await getRoomAccountData(db, '@u:ex', '!r:ex', 0);
    expect(db.binds[0]).toEqual(['@u:ex', '!r:ex', 0]);
    expect(result).toEqual([
      { type: 'm.fully_read', content: { event_id: '$e' } },
    ]);
  });

  it('strict > at since boundary for room account data', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'eq',
          content: '{"a":1}',
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'gt',
          content: '{"a":2}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'eq',
          stream_position: 7,
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'gt',
          stream_position: 8,
        },
      ],
    });

    expect(await getRoomAccountData(db, '@u:ex', '!r:ex', 7)).toEqual([
      { type: 'gt', content: { a: 2 } },
    ]);
  });

  it('returns multiple event types for the same room on full dump', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          content: '{"tags":{"favourite":{}}}',
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.fully_read',
          content: '{"event_id":"$x"}',
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'im.vector.setting.breadcrumbs',
          content: '{"recent_rooms":["!r:ex"]}',
        },
      ],
    });
    const result = await getRoomAccountData(db, '@u:ex', '!r:ex');
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.type).sort()).toEqual([
      'im.vector.setting.breadcrumbs',
      'm.fully_read',
      'm.tag',
    ]);
  });

  it('uses latest change for room type when rewritten multiple times', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          content: '{"tags":{"v2":{}}}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          stream_position: 1,
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          stream_position: 5,
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          stream_position: 20,
        },
      ],
    });

    expect(await getRoomAccountData(db, '@u:ex', '!r:ex', 19)).toEqual([
      { type: 'm.tag', content: { tags: { v2: {} } } },
    ]);
    expect(await getRoomAccountData(db, '@u:ex', '!r:ex', 20)).toEqual([]);
  });

  it('does not leak other-user room account data', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@other:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          content: '{"tags":{"secret":{}}}',
        },
      ],
    });
    expect(await getRoomAccountData(db, '@u:ex', '!r:ex')).toEqual([]);
  });

  it('parses null content as {} on room incremental path', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          content: null,
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          stream_position: 2,
        },
      ],
    });
    expect(await getRoomAccountData(db, '@u:ex', '!r:ex', 1)).toEqual([
      { type: 'm.tag', content: {} },
    ]);
  });
});

// =============================================================================
// getAllRoomAccountData
// =============================================================================

describe('getAllRoomAccountData', () => {
  it('returns {} and never prepares when roomIds is empty', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          content: '{}',
        },
      ],
    });
    const result = await getAllRoomAccountData(db, '@u:ex', []);
    expect(result).toEqual({});
    expect(db.prepares).toHaveLength(0);
  });

  it('groups by room_id; omits quiet rooms; binds [userId, ...roomIds]', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!a:ex',
          event_type: 'm.tag',
          content: JSON.stringify({ tags: { lowpriority: {} } }),
        },
        {
          user_id: '@u:ex',
          room_id: '!a:ex',
          event_type: 'm.fully_read',
          content: JSON.stringify({ event_id: '$1' }),
        },
        {
          user_id: '@u:ex',
          room_id: '!b:ex',
          event_type: 'm.tag',
          content: JSON.stringify({ tags: {} }),
        },
        {
          user_id: '@u:ex',
          room_id: '!quiet:ex',
          event_type: 'm.tag',
          content: '{}',
        },
      ],
    });

    const result = await getAllRoomAccountData(db, '@u:ex', [
      '!a:ex',
      '!b:ex',
      '!missing:ex',
    ]);
    expect(db.binds[0]).toEqual(['@u:ex', '!a:ex', '!b:ex', '!missing:ex']);
    expect(Object.keys(result).sort()).toEqual(['!a:ex', '!b:ex']);
    expect(result['!a:ex']).toEqual([
      { type: 'm.tag', content: { tags: { lowpriority: {} } } },
      { type: 'm.fully_read', content: { event_id: '$1' } },
    ]);
    expect(result['!b:ex']).toEqual([{ type: 'm.tag', content: { tags: {} } }]);
    expect(result['!missing:ex']).toBeUndefined();
    expect(result['!quiet:ex']).toBeUndefined();
  });

  it('parses null content as {} when grouping', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          content: null,
        },
      ],
    });
    expect(await getAllRoomAccountData(db, '@u:ex', ['!r:ex'])).toEqual({
      '!r:ex': [{ type: 'm.tag', content: {} }],
    });
  });

  it('incremental multi-room: since:0 + strict >; only rooms with changes', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!a:ex',
          event_type: 'm.tag',
          content: '{"tags":{"a":{}}}',
        },
        {
          user_id: '@u:ex',
          room_id: '!b:ex',
          event_type: 'm.tag',
          content: '{"tags":{"b":{}}}',
        },
        {
          user_id: '@u:ex',
          room_id: '!c:ex',
          event_type: 'm.tag',
          content: '{"tags":{"c":{}}}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '!a:ex',
          event_type: 'm.tag',
          stream_position: 0,
        },
        {
          user_id: '@u:ex',
          room_id: '!b:ex',
          event_type: 'm.tag',
          stream_position: 1,
        },
        {
          user_id: '@u:ex',
          room_id: '!c:ex',
          event_type: 'm.tag',
          stream_position: 5,
        },
      ],
    });

    const result = await getAllRoomAccountData(
      db,
      '@u:ex',
      ['!a:ex', '!b:ex', '!c:ex'],
      0
    );
    expect(db.prepares.some((q) => q.includes('account_data_changes'))).toBe(true);
    expect(db.binds[0]).toEqual(['@u:ex', '!a:ex', '!b:ex', '!c:ex', 0]);
    expect(Object.keys(result).sort()).toEqual(['!b:ex', '!c:ex']);
    expect(result['!a:ex']).toBeUndefined();
  });

  it('incremental multi-room: pos==since excluded, pos==since+1 included', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'eq',
          content: '{"n":1}',
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'gt',
          content: '{"n":2}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'eq',
          stream_position: 100,
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'gt',
          stream_position: 101,
        },
      ],
    });

    const result = await getAllRoomAccountData(db, '@u:ex', ['!r:ex'], 100);
    expect(result).toEqual({
      '!r:ex': [{ type: 'gt', content: { n: 2 } }],
    });
  });

  it('builds IN placeholders for a single room id', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!solo:ex',
          event_type: 'm.tag',
          content: '{"tags":{}}',
        },
      ],
    });
    const result = await getAllRoomAccountData(db, '@u:ex', ['!solo:ex']);
    expect(db.prepares[0]).toMatch(/IN \(\?\)/);
    expect(db.binds[0]).toEqual(['@u:ex', '!solo:ex']);
    expect(result).toEqual({
      '!solo:ex': [{ type: 'm.tag', content: { tags: {} } }],
    });
  });

  it('builds IN placeholders for many rooms and preserves bind order', async () => {
    const roomIds = Array.from({ length: 12 }, (_, i) => `!r${i}:ex`);
    const db = createAccountDataDb({
      rows: roomIds.map((room_id, i) => ({
        user_id: '@u:ex',
        room_id,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { [`t${i}`]: {} } }),
      })),
    });

    const result = await getAllRoomAccountData(db, '@u:ex', roomIds);
    expect(db.prepares[0]).toMatch(/IN \(\?(?:,\?){11}\)/);
    expect(db.binds[0]).toEqual(['@u:ex', ...roomIds]);
    expect(Object.keys(result)).toHaveLength(12);
    expect(result['!r0:ex']).toEqual([{ type: 'm.tag', content: { tags: { t0: {} } } }]);
    expect(result['!r11:ex']).toEqual([
      { type: 'm.tag', content: { tags: { t11: {} } } },
    ]);
  });

  it('full dump never joins account_data_changes even when since omitted', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          content: '{}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          stream_position: 9,
        },
      ],
    });
    await getAllRoomAccountData(db, '@u:ex', ['!r:ex']);
    expect(db.prepares.some((q) => q.includes('account_data_changes'))).toBe(false);
  });

  it('incremental returns {} when no rooms have changes after since', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!a:ex',
          event_type: 'm.tag',
          content: '{}',
        },
        {
          user_id: '@u:ex',
          room_id: '!b:ex',
          event_type: 'm.tag',
          content: '{}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '!a:ex',
          event_type: 'm.tag',
          stream_position: 5,
        },
        {
          user_id: '@u:ex',
          room_id: '!b:ex',
          event_type: 'm.tag',
          stream_position: 5,
        },
      ],
    });
    expect(
      await getAllRoomAccountData(db, '@u:ex', ['!a:ex', '!b:ex'], 5)
    ).toEqual({});
  });

  it('incremental appends since after room id list in bind order', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!z:ex',
          event_type: 'm.fully_read',
          content: '{"event_id":"$z"}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '!z:ex',
          event_type: 'm.fully_read',
          stream_position: 3,
        },
      ],
    });
    await getAllRoomAccountData(db, '@u:ex', ['!z:ex', '!y:ex'], 2);
    expect(db.binds[0]).toEqual(['@u:ex', '!z:ex', '!y:ex', 2]);
  });

  it('does not include rooms belonging to other users even if listed', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@other:ex',
          room_id: '!shared:ex',
          event_type: 'm.tag',
          content: '{"tags":{"x":{}}}',
        },
      ],
    });
    expect(await getAllRoomAccountData(db, '@u:ex', ['!shared:ex'])).toEqual({});
  });

  it('groups multiple event types under the same room key', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          content: '{"tags":{}}',
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.fully_read',
          content: '{"event_id":"$e"}',
        },
      ],
    });
    const result = await getAllRoomAccountData(db, '@u:ex', ['!r:ex']);
    expect(result['!r:ex']).toHaveLength(2);
  });
});

// =============================================================================
// getAccountDataStreamPosition
// =============================================================================

describe('getAccountDataStreamPosition', () => {
  it('returns position when stream_positions row exists', async () => {
    const db = createAccountDataDb({ streamPosition: 99 });
    expect(await getAccountDataStreamPosition(db)).toBe(99);
    expect(db.prepares[0]).toContain("stream_name = 'account_data'");
  });

  it('returns 0 when row is missing (null first())', async () => {
    const db = createAccountDataDb({ streamPosition: null });
    expect(await getAccountDataStreamPosition(db)).toBe(0);
  });

  it('returns 0 when position is 0 (falsy || 0)', async () => {
    const db = createAccountDataDb({ streamPosition: 0 });
    expect(await getAccountDataStreamPosition(db)).toBe(0);
  });

  it('returns large stream positions unchanged', async () => {
    const db = createAccountDataDb({ streamPosition: 2_147_483_647 });
    expect(await getAccountDataStreamPosition(db)).toBe(2_147_483_647);
  });

  it('queries stream_positions exactly once per call', async () => {
    const db = createAccountDataDb({ streamPosition: 7 });
    await getAccountDataStreamPosition(db);
    await getAccountDataStreamPosition(db);
    expect(db.prepares).toHaveLength(2);
    expect(db.prepares.every((q) => q.includes('account_data'))).toBe(true);
  });
});

// =============================================================================
// getE2EEAccountDataFromDO
// =============================================================================

describe('getE2EEAccountDataFromDO', () => {
  it('fetches without query when eventType omitted; routes via idFromName(userId)', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([
        [
          '__all__',
          new Response(
            JSON.stringify({
              'm.secret_storage.default_key': { key: 'abc' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
        ],
      ]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;

    const result = await getE2EEAccountDataFromDO(env, '@alice:ex');
    expect(result).toEqual({
      'm.secret_storage.default_key': { key: 'abc' },
    });
    expect(ns.fetches).toEqual([
      { url: 'http://internal/account-data/get', method: 'GET' },
    ]);
  });

  it('encodes eventType in query string (spaces, +, dots)', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([
        [
          'm.secret_storage.key.A+B',
          new Response(
            JSON.stringify({ algorithm: 'm.secret_storage.v1.aes-hmac-sha2' }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          ),
        ],
      ]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;

    const result = await getE2EEAccountDataFromDO(
      env,
      '@bob:ex',
      'm.secret_storage.key.A+B'
    );
    expect(result).toEqual({
      algorithm: 'm.secret_storage.v1.aes-hmac-sha2',
    });
    expect(ns.fetches[0].url).toBe(
      `http://internal/account-data/get?event_type=${encodeURIComponent('m.secret_storage.key.A+B')}`
    );
  });

  it('encodes unicode / reserved characters in eventType', async () => {
    const eventType = 'm.secret_storage.key.✨/#?&=';
    const ns = mockUserKeysNamespace({
      responses: new Map([
        [
          eventType,
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ],
      ]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;

    await getE2EEAccountDataFromDO(env, '@u:ex', eventType);
    expect(ns.fetches[0].url).toBe(
      `http://internal/account-data/get?event_type=${encodeURIComponent(eventType)}`
    );
  });

  it('throws with status and body text when DO returns non-OK', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([
        ['m.megolm_backup.v1', new Response('boom', { status: 500 })],
      ]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      getE2EEAccountDataFromDO(env, '@u:ex', 'm.megolm_backup.v1')
    ).rejects.toThrow('DO get failed: 500 - boom');

    expect(errSpy).toHaveBeenCalled();
  });

  it('uses "unknown error" when response.text() rejects', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([
        [
          '__all__',
          () =>
            Promise.resolve({
              ok: false,
              status: 503,
              async text() {
                throw new Error('body gone');
              },
              async json() {
                return {};
              },
            } as unknown as Response),
        ],
      ]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getE2EEAccountDataFromDO(env, '@u:ex')).rejects.toThrow(
      'DO get failed: 503 - unknown error'
    );
  });

  it('propagates fetch throws from the Durable Object stub', async () => {
    const ns = mockUserKeysNamespace({
      throwOnFetch: new Error('DO offline'),
    });
    const env = { USER_KEYS: ns } as unknown as Env;

    await expect(getE2EEAccountDataFromDO(env, '@u:ex')).rejects.toThrow(
      'DO offline'
    );
  });

  it('returns null JSON body as null (caller decides fallback)', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([
        [
          'm.cross_signing.master',
          new Response('null', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ],
      ]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    expect(
      await getE2EEAccountDataFromDO(env, '@u:ex', 'm.cross_signing.master')
    ).toBeNull();
  });

  it('returns empty-object JSON for missing type map entries', async () => {
    const ns = mockUserKeysNamespace({ responses: new Map() });
    const env = { USER_KEYS: ns } as unknown as Env;
    expect(await getE2EEAccountDataFromDO(env, '@u:ex')).toEqual({});
  });

  it('treats empty-string eventType as falsy (omits query; same as undefined)', async () => {
    // Source: `eventType ? ...encode... : 'http://internal/account-data/get'`
    const ns = mockUserKeysNamespace({
      responses: new Map([
        [
          '__all__',
          new Response(JSON.stringify({ all: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ],
      ]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    const result = await getE2EEAccountDataFromDO(env, '@u:ex', '');
    expect(result).toEqual({ all: true });
    expect(ns.fetches[0].url).toBe('http://internal/account-data/get');
  });

  it('surfaces 404 body text in the thrown error message', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([
        [
          'm.secret_storage.default_key',
          new Response('not found', { status: 404 }),
        ],
      ]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      getE2EEAccountDataFromDO(env, '@u:ex', 'm.secret_storage.default_key')
    ).rejects.toThrow('DO get failed: 404 - not found');
  });

  it('uses distinct DO stubs per userId via idFromName', async () => {
    const seen: string[] = [];
    const ns = {
      fetches: [] as Array<{ url: string; method: string }>,
      idFromName(userId: string) {
        seen.push(userId);
        return { name: userId };
      },
      get(id: { name: string }) {
        return {
          async fetch(request: Request) {
            ns.fetches.push({ url: request.url, method: request.method });
            return new Response(JSON.stringify({ user: id.name }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          },
        };
      },
    };
    const env = { USER_KEYS: ns } as unknown as Env;

    expect(await getE2EEAccountDataFromDO(env, '@a:ex')).toEqual({
      user: '@a:ex',
    });
    expect(await getE2EEAccountDataFromDO(env, '@b:ex')).toEqual({
      user: '@b:ex',
    });
    expect(seen).toEqual(['@a:ex', '@b:ex']);
  });
});

// =============================================================================
// Cross-helper / sync contract edges
// =============================================================================

describe('account-data sync helper contracts', () => {
  it('global incremental and room incremental share strict > semantics', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          content: '{"g":1}',
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          content: '{"r":1}',
        },
      ],
      changes: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          stream_position: 10,
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          stream_position: 10,
        },
      ],
    });

    expect(await getGlobalAccountData(db, '@u:ex', 10)).toEqual([]);
    expect(await getRoomAccountData(db, '@u:ex', '!r:ex', 10)).toEqual([]);
    expect(await getAllRoomAccountData(db, '@u:ex', ['!r:ex'], 10)).toEqual({});
  });

  it('since:0 is incremental for all three batch helpers (not full dump)', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '',
          event_type: 'm.direct',
          content: '{}',
        },
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          content: '{}',
        },
      ],
      changes: [],
    });

    await getGlobalAccountData(db, '@u:ex', 0);
    await getRoomAccountData(db, '@u:ex', '!r:ex', 0);
    await getAllRoomAccountData(db, '@u:ex', ['!r:ex'], 0);

    const changeJoins = db.prepares.filter((q) =>
      q.includes('account_data_changes')
    );
    expect(changeJoins).toHaveLength(3);
  });

  it('empty roomIds short-circuit does not affect subsequent prepares', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: '@u:ex',
          room_id: '!r:ex',
          event_type: 'm.tag',
          content: '{}',
        },
      ],
    });
    expect(await getAllRoomAccountData(db, '@u:ex', [])).toEqual({});
    expect(await getRoomAccountData(db, '@u:ex', '!r:ex')).toEqual([
      { type: 'm.tag', content: {} },
    ]);
    expect(db.prepares).toHaveLength(1);
  });
});
