import { describe, it, expect } from 'vitest';
import { countNotificationsWithRules } from '../src/services/push-rule-evaluator';

type QueryResult = { results?: unknown[]; first?: unknown };

function mockDbSequence(handlers: Array<(sql: string) => QueryResult>): D1Database {
  let i = 0;
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        all: async () => {
          const h = handlers[Math.min(i++, handlers.length - 1)](sql);
          return { results: h.results ?? [] };
        },
        first: async () => {
          const h = handlers[Math.min(i++, handlers.length - 1)](sql);
          return h.first ?? null;
        },
        run: async () => ({ meta: { changes: 0 } }),
      }),
    }),
  } as unknown as D1Database;
}

describe('countNotificationsWithRules', () => {
  it('returns zero counts when there are no unread events', async () => {
    const db = mockDbSequence([
      () => ({ results: [] }), // unread events
    ]);
    await expect(
      countNotificationsWithRules(db, '@alice:example.com', '!r:example.com', 10)
    ).resolves.toEqual({ notification_count: 0, highlight_count: 0 });
  });

  it('counts notify/highlight via evaluatePushRules; bad JSON content becomes {}', async () => {
    const db = mockDbSequence([
      () => ({
        results: [
          {
            event_id: '$1',
            event_type: 'm.room.message',
            content: '{not-json',
            sender: '@bob:example.com',
            room_id: '!r:example.com',
          },
          {
            event_id: '$2',
            event_type: 'm.room.message',
            content: JSON.stringify({ body: 'hey alice', msgtype: 'm.text' }),
            sender: '@bob:example.com',
            room_id: '!r:example.com',
          },
        ],
      }),
      () => ({ first: { count: 5 } }), // member count
      () => ({ first: { display_name: null } }), // display name
      // evaluatePushRules → getUserPushRules for each event
      () => ({ results: [] }),
      () => ({ results: [] }),
    ]);

    const counts = await countNotificationsWithRules(
      db,
      '@alice:example.com',
      '!r:example.com',
      1
    );
    // bad JSON → {} body → still matches underride message → notify
    // "hey alice" → contains_user_name → notify + highlight
    expect(counts.notification_count).toBe(2);
    expect(counts.highlight_count).toBe(1);
  });
});
