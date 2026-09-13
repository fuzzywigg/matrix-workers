import { describe, it, expect, vi } from 'vitest';
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
        const isGlobal = sql.includes("room_id = ''") || sql.includes('room_id = \'\'');
        const isSingleRoom =
          !isGlobal &&
          sql.includes('room_id = ?') &&
          !sql.includes('IN (');
        const isMultiRoom = sql.includes('IN (');

        if (sql.includes('FROM account_data') || sql.includes('FROM account_data ad')) {
          if (isMultiRoom) {
            const userId = args[0] as string;
            const sinceIdx = isChangeJoin ? args.length - 1 : -1;
            const since = isChangeJoin ? (args[sinceIdx] as number) : undefined;
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
}) {
  const fetches: string[] = [];
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
          fetches.push(request.url);
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
    expect(db.prepares.some((q) => q.includes('account_data_changes'))).toBe(
      false
    );
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
    expect(db.prepares.some((q) => q.includes('account_data_changes'))).toBe(
      true
    );
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
});

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
});

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
    expect(db.prepares.some((q) => q.includes('account_data_changes'))).toBe(
      true
    );
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
});

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
});

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
    expect(ns.fetches).toEqual(['http://internal/account-data/get']);
  });

  it('encodes eventType in query string (spaces, +, dots)', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([
        [
          'm.secret_storage.key.A+B',
          new Response(JSON.stringify({ algorithm: 'm.secret_storage.v1.aes-hmac-sha2' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
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
    expect(ns.fetches[0]).toBe(
      `http://internal/account-data/get?event_type=${encodeURIComponent('m.secret_storage.key.A+B')}`
    );
  });

  it('throws with status and body text when DO returns non-OK', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([
        [
          'm.megolm_backup.v1',
          new Response('boom', { status: 500 }),
        ],
      ]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      getE2EEAccountDataFromDO(env, '@u:ex', 'm.megolm_backup.v1')
    ).rejects.toThrow('DO get failed: 500 - boom');

    errSpy.mockRestore();
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
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getE2EEAccountDataFromDO(env, '@u:ex')).rejects.toThrow(
      'DO get failed: 503 - unknown error'
    );

    errSpy.mockRestore();
  });
});
