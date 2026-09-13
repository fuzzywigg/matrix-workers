import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/api/push', () => ({
  evaluatePushRules: vi.fn(),
}));

import { evaluatePushRules } from '../src/api/push';
import { countNotificationsWithRules } from '../src/services/push-rule-evaluator';

const evalMock = vi.mocked(evaluatePushRules);
const USER = '@alice:example.com';
const ROOM = '!r:example.com';

type EventRow = {
  event_id: string;
  type: string;
  content: string;
  sender: string;
  room_id: string;
  state_key?: string;
};

function createCountDb(opts: {
  fullyReadContent?: string | null;
  readEventStream?: number | null;
  unread?: EventRow[];
  memberCount?: number;
  displayName?: string | null;
  throwOnFullyRead?: boolean;
}) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("event_type = 'm.fully_read'")) {
                if (opts.throwOnFullyRead) throw new Error('should not query marker');
                if (opts.fullyReadContent === null || opts.fullyReadContent === undefined) {
                  return null;
                }
                return { content: opts.fullyReadContent } as T;
              }
              if (sql.includes('SELECT stream_ordering FROM events WHERE event_id')) {
                if (opts.readEventStream === null || opts.readEventStream === undefined) {
                  return null;
                }
                return { stream_ordering: opts.readEventStream } as T;
              }
              if (sql.includes('FROM room_memberships') && sql.includes('COUNT')) {
                return { count: opts.memberCount ?? 1 } as T;
              }
              if (sql.includes('FROM users WHERE user_id')) {
                return { display_name: opts.displayName ?? null } as T;
              }
              return null;
            },
            async all<T>() {
              if (sql.includes('FROM events') && sql.includes('m.room.message')) {
                // Bind order: with since → room, stream, user; without → room, user
                const hasSince = sql.includes('stream_ordering >');
                if (hasSince) {
                  const [, since, sender] = args as [string, number, string];
                  expect(sender).toBe(USER);
                  // Caller already filtered; return configured unread
                  void since;
                }
                return { results: (opts.unread ?? []) as T[] };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('countNotificationsWithRules', () => {
  beforeEach(() => {
    evalMock.mockReset();
    evalMock.mockResolvedValue({ notify: false, highlight: false, sound: undefined });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns zeros when there are no unread events (explicit since)', async () => {
    const db = createCountDb({ unread: [] });
    await expect(
      countNotificationsWithRules(db, USER, ROOM, 10)
    ).resolves.toEqual({ notification_count: 0, highlight_count: 0 });
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('uses sinceStreamOrdering when provided and skips fully_read lookup', async () => {
    const db = createCountDb({
      throwOnFullyRead: true,
      unread: [
        {
          event_id: '$1',
          type: 'm.room.message',
          content: JSON.stringify({ body: 'hi' }),
          sender: '@bob:example.com',
          room_id: ROOM,
        },
      ],
      memberCount: 3,
      displayName: 'Alice',
    });
    evalMock.mockResolvedValueOnce({ notify: true, highlight: false, sound: 'default' });

    await expect(countNotificationsWithRules(db, USER, ROOM, 42)).resolves.toEqual({
      notification_count: 1,
      highlight_count: 0,
    });
    expect(evalMock).toHaveBeenCalledWith(
      db,
      USER,
      expect.objectContaining({
        // SQL aliases event_type AS type, but evaluator reads event.event_type → undefined
        type: undefined,
        content: { body: 'hi' },
        sender: '@bob:example.com',
        room_id: ROOM,
      }),
      3,
      'Alice'
    );
  });

  it('resolves fully_read marker → stream_ordering when since is omitted', async () => {
    const db = createCountDb({
      fullyReadContent: JSON.stringify({ event_id: '$read' }),
      readEventStream: 7,
      unread: [
        {
          event_id: '$n',
          type: 'm.room.encrypted',
          content: '{}',
          sender: '@bob:example.com',
          room_id: ROOM,
        },
      ],
    });
    evalMock.mockResolvedValueOnce({ notify: true, highlight: true, sound: undefined });

    await expect(countNotificationsWithRules(db, USER, ROOM)).resolves.toEqual({
      notification_count: 1,
      highlight_count: 1,
    });
  });

  it('ignores malformed fully_read JSON and falls back to no-since query', async () => {
    const db = createCountDb({
      fullyReadContent: '{not-json',
      unread: [],
    });
    await expect(countNotificationsWithRules(db, USER, ROOM)).resolves.toEqual({
      notification_count: 0,
      highlight_count: 0,
    });
  });

  it('treats missing read event stream as falsy and uses the no-since branch', async () => {
    const db = createCountDb({
      fullyReadContent: JSON.stringify({ event_id: '$missing' }),
      readEventStream: null,
      unread: [
        {
          event_id: '$e',
          type: 'm.room.message',
          content: JSON.stringify({ body: 'x' }),
          sender: '@bob:example.com',
          room_id: ROOM,
        },
      ],
    });
    evalMock.mockResolvedValueOnce({ notify: false, highlight: false, sound: undefined });
    await countNotificationsWithRules(db, USER, ROOM);
    expect(evalMock).toHaveBeenCalledOnce();
  });

  it('counts notify and highlight independently across multiple events', async () => {
    const db = createCountDb({
      unread: [
        {
          event_id: '$1',
          type: 'm.room.message',
          content: '{}',
          sender: '@b:example.com',
          room_id: ROOM,
        },
        {
          event_id: '$2',
          type: 'm.room.message',
          content: '{}',
          sender: '@c:example.com',
          room_id: ROOM,
        },
        {
          event_id: '$3',
          type: 'm.room.message',
          content: '{}',
          sender: '@d:example.com',
          room_id: ROOM,
        },
      ],
    });
    evalMock
      .mockResolvedValueOnce({ notify: true, highlight: false, sound: undefined })
      .mockResolvedValueOnce({ notify: true, highlight: true, sound: undefined })
      .mockResolvedValueOnce({ notify: false, highlight: true, sound: undefined });

    await expect(countNotificationsWithRules(db, USER, ROOM, 1)).resolves.toEqual({
      notification_count: 2,
      highlight_count: 2,
    });
  });

  it('uses {} content when event content JSON is invalid', async () => {
    const db = createCountDb({
      unread: [
        {
          event_id: '$bad',
          type: 'm.room.message',
          content: 'not-json',
          sender: '@b:example.com',
          room_id: ROOM,
        },
      ],
      memberCount: 0,
      displayName: null,
    });
    evalMock.mockResolvedValueOnce({ notify: false, highlight: false, sound: undefined });
    await countNotificationsWithRules(db, USER, ROOM, 0);
    expect(evalMock).toHaveBeenCalledWith(
      db,
      USER,
      expect.objectContaining({ content: {} }),
      1, // memberCount?.count || 1 — 0 is falsy → 1
      undefined
    );
  });

  it('passes through already-parsed object content without re-parsing', async () => {
    const db = createCountDb({
      unread: [
        {
          event_id: '$obj',
          type: 'm.room.message',
          content: { body: 'obj' } as unknown as string,
          sender: '@b:example.com',
          room_id: ROOM,
          state_key: '',
        },
      ],
    });
    evalMock.mockResolvedValueOnce({ notify: true, highlight: false, sound: undefined });
    await countNotificationsWithRules(db, USER, ROOM, 5);
    expect(evalMock.mock.calls[0][2]).toMatchObject({
      content: { body: 'obj' },
      state_key: '',
    });
  });

  it('defaults memberCount to 1 when COUNT returns null', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('COUNT')) return null;
                if (sql.includes('FROM users')) return { display_name: 'A' };
                return null;
              },
              async all() {
                return {
                  results: [
                    {
                      event_id: '$1',
                      type: 'm.room.message',
                      content: '{}',
                      sender: '@b:example.com',
                      room_id: ROOM,
                    },
                  ],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    evalMock.mockResolvedValueOnce({ notify: false, highlight: false, sound: undefined });
    await countNotificationsWithRules(db, USER, ROOM, 1);
    expect(evalMock.mock.calls[0][3]).toBe(1);
    expect(evalMock.mock.calls[0][4]).toBe('A');
  });
});
