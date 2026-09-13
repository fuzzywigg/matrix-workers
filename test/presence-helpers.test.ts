import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  getPresenceForUsers,
  updateLastActive,
} from '../src/api/presence';

/** Mirrors private PRESENCE_TIMEOUT in src/api/presence.ts (not exported). */
const PRESENCE_TIMEOUT = 5 * 60 * 1000;
const NOW = 1_700_000_000_000;

type PresenceRow = {
  presence: string;
  status_msg: string | null;
  last_active_ts: number;
};

function createPresenceDb(rows = new Map<string, PresenceRow>()) {
  const updates: Array<{ ts: number; userId: string }> = [];
  const queries: string[] = [];

  const db = {
    updates,
    queries,
    rows,
    prepare(sql: string) {
      queries.push(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async all<T>() {
              if (!sql.includes('FROM presence') || !sql.includes('IN (')) {
                return { results: [] as T[] };
              }
              const ids = args as string[];
              const results = ids
                .map((id) => {
                  const row = rows.get(id);
                  if (!row) return null;
                  return {
                    user_id: id,
                    presence: row.presence,
                    status_msg: row.status_msg,
                    last_active_ts: row.last_active_ts,
                  };
                })
                .filter(Boolean) as T[];
              return { results };
            },
            async run() {
              if (sql.includes('UPDATE presence SET last_active_ts')) {
                const [ts, userId] = args as [number, string];
                updates.push({ ts, userId });
                const existing = rows.get(userId);
                if (existing) {
                  rows.set(userId, { ...existing, last_active_ts: ts });
                }
                return { meta: { changes: existing ? 1 : 0 } };
              }
              return { meta: { changes: 0 } };
            },
            async first() {
              return null;
            },
          };
        },
      };
    },
  };

  return db as unknown as D1Database & {
    updates: typeof updates;
    queries: string[];
    rows: Map<string, PresenceRow>;
  };
}

function mockKv(entries = new Map<string, PresenceRow>()) {
  return {
    async get(key: string, type?: string) {
      const value = entries.get(key);
      if (value === undefined) return null;
      if (type === 'json') return structuredClone(value);
      return JSON.stringify(value);
    },
    async put() {
      /* unused in helper tests */
    },
  } as unknown as KVNamespace;
}

describe('getPresenceForUsers — clock-pinned activity cutoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns {} for an empty user id list without touching D1', async () => {
    const db = createPresenceDb();
    expect(await getPresenceForUsers(db, [])).toEqual({});
    expect(db.queries).toHaveLength(0);
  });

  it('keeps online users active when last_active_ts is TIMEOUT−1 ms ago', async () => {
    const db = createPresenceDb(
      new Map([
        [
          '@alice:ex.com',
          {
            presence: 'online',
            status_msg: 'here',
            last_active_ts: NOW - (PRESENCE_TIMEOUT - 1),
          },
        ],
      ])
    );

    expect(await getPresenceForUsers(db, ['@alice:ex.com'])).toEqual({
      '@alice:ex.com': {
        presence: 'online',
        status_msg: 'here',
        last_active_ago: PRESENCE_TIMEOUT - 1,
        currently_active: true,
      },
    });
  });

  it('remaps online → unavailable at the exact TIMEOUT boundary (strict <)', async () => {
    const db = createPresenceDb(
      new Map([
        [
          '@alice:ex.com',
          {
            presence: 'online',
            status_msg: null,
            last_active_ts: NOW - PRESENCE_TIMEOUT,
          },
        ],
      ])
    );

    expect(await getPresenceForUsers(db, ['@alice:ex.com'])).toEqual({
      '@alice:ex.com': {
        presence: 'unavailable',
        status_msg: undefined,
        last_active_ago: PRESENCE_TIMEOUT,
        currently_active: false,
      },
    });
  });

  it('remaps online → unavailable when past TIMEOUT', async () => {
    const db = createPresenceDb(
      new Map([
        [
          '@alice:ex.com',
          {
            presence: 'online',
            status_msg: 'away soon',
            last_active_ts: NOW - PRESENCE_TIMEOUT - 1,
          },
        ],
      ])
    );

    expect(await getPresenceForUsers(db, ['@alice:ex.com'])).toEqual({
      '@alice:ex.com': {
        presence: 'unavailable',
        status_msg: 'away soon',
        last_active_ago: PRESENCE_TIMEOUT + 1,
        currently_active: false,
      },
    });
  });

  it('does not remap offline or unavailable even when last_active is stale', async () => {
    const db = createPresenceDb(
      new Map([
        [
          '@off:ex.com',
          {
            presence: 'offline',
            status_msg: null,
            last_active_ts: NOW - PRESENCE_TIMEOUT * 10,
          },
        ],
        [
          '@unav:ex.com',
          {
            presence: 'unavailable',
            status_msg: 'brb',
            last_active_ts: NOW - PRESENCE_TIMEOUT * 10,
          },
        ],
      ])
    );

    expect(
      await getPresenceForUsers(db, ['@off:ex.com', '@unav:ex.com'])
    ).toEqual({
      '@off:ex.com': {
        presence: 'offline',
        status_msg: undefined,
        last_active_ago: PRESENCE_TIMEOUT * 10,
        currently_active: false,
      },
      '@unav:ex.com': {
        presence: 'unavailable',
        status_msg: 'brb',
        last_active_ago: PRESENCE_TIMEOUT * 10,
        currently_active: false,
      },
    });
  });

  it('computes last_active_ago from the pinned clock', async () => {
    const lastActive = NOW - 42_000;
    const db = createPresenceDb(
      new Map([
        [
          '@bob:ex.com',
          { presence: 'online', status_msg: null, last_active_ts: lastActive },
        ],
      ])
    );

    const result = await getPresenceForUsers(db, ['@bob:ex.com']);
    expect(result['@bob:ex.com'].last_active_ago).toBe(42_000);
  });

  it('omits users missing from D1 rather than defaulting them to offline', async () => {
    const db = createPresenceDb(
      new Map([
        [
          '@known:ex.com',
          {
            presence: 'online',
            status_msg: null,
            last_active_ts: NOW - 1_000,
          },
        ],
      ])
    );

    const result = await getPresenceForUsers(db, [
      '@known:ex.com',
      '@missing:ex.com',
    ]);
    expect(Object.keys(result)).toEqual(['@known:ex.com']);
  });

  it('serves full cache hits without querying D1 and applies the same timeout math', async () => {
    const db = createPresenceDb();
    const cache = mockKv(
      new Map([
        [
          'presence:@cached:ex.com',
          {
            presence: 'online',
            status_msg: 'kv',
            last_active_ts: NOW - (PRESENCE_TIMEOUT - 5),
          },
        ],
        [
          'presence:@stale:ex.com',
          {
            presence: 'online',
            status_msg: null,
            last_active_ts: NOW - PRESENCE_TIMEOUT,
          },
        ],
      ])
    );

    expect(
      await getPresenceForUsers(
        db,
        ['@cached:ex.com', '@stale:ex.com'],
        cache
      )
    ).toEqual({
      '@cached:ex.com': {
        presence: 'online',
        status_msg: 'kv',
        last_active_ago: PRESENCE_TIMEOUT - 5,
        currently_active: true,
      },
      '@stale:ex.com': {
        presence: 'unavailable',
        status_msg: undefined,
        last_active_ago: PRESENCE_TIMEOUT,
        currently_active: false,
      },
    });
    expect(db.queries).toHaveLength(0);
  });

  it('queries only uncached ids on a partial cache hit', async () => {
    const db = createPresenceDb(
      new Map([
        [
          '@db:ex.com',
          {
            presence: 'online',
            status_msg: 'from-db',
            last_active_ts: NOW - 2_000,
          },
        ],
      ])
    );
    const cache = mockKv(
      new Map([
        [
          'presence:@kv:ex.com',
          {
            presence: 'offline',
            status_msg: null,
            last_active_ts: NOW - 9_000,
          },
        ],
      ])
    );

    const result = await getPresenceForUsers(
      db,
      ['@kv:ex.com', '@db:ex.com', '@ghost:ex.com'],
      cache
    );

    expect(result['@kv:ex.com'].presence).toBe('offline');
    expect(result['@db:ex.com']).toEqual({
      presence: 'online',
      status_msg: 'from-db',
      last_active_ago: 2_000,
      currently_active: true,
    });
    expect(result['@ghost:ex.com']).toBeUndefined();
    expect(db.queries).toHaveLength(1);
    // only uncached ids are queried (@db + @ghost)
    expect(db.queries[0]).toContain('IN (?,?)');
  });

  it('recomputes effective presence after the clock advances past TIMEOUT', async () => {
    const db = createPresenceDb(
      new Map([
        [
          '@alice:ex.com',
          {
            presence: 'online',
            status_msg: null,
            last_active_ts: NOW - 1_000,
          },
        ],
      ])
    );

    expect(
      (await getPresenceForUsers(db, ['@alice:ex.com']))['@alice:ex.com']
        .presence
    ).toBe('online');

    vi.setSystemTime(NOW - 1_000 + PRESENCE_TIMEOUT);
    expect(
      (await getPresenceForUsers(db, ['@alice:ex.com']))['@alice:ex.com']
    ).toMatchObject({
      presence: 'unavailable',
      currently_active: false,
      last_active_ago: PRESENCE_TIMEOUT,
    });
  });

  it('sets currently_active only when presence is online AND within TIMEOUT', async () => {
    const db = createPresenceDb(
      new Map([
        [
          '@fresh-offline:ex.com',
          {
            presence: 'offline',
            status_msg: null,
            last_active_ts: NOW - 100,
          },
        ],
        [
          '@fresh-online:ex.com',
          {
            presence: 'online',
            status_msg: null,
            last_active_ts: NOW - 100,
          },
        ],
      ])
    );

    const result = await getPresenceForUsers(db, [
      '@fresh-offline:ex.com',
      '@fresh-online:ex.com',
    ]);
    expect(result['@fresh-offline:ex.com'].currently_active).toBe(false);
    expect(result['@fresh-online:ex.com'].currently_active).toBe(true);
  });
});

describe('updateLastActive — clock-pinned UPDATE bind', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('binds the pinned Date.now() into the UPDATE', async () => {
    const db = createPresenceDb(
      new Map([
        [
          '@u:ex.com',
          { presence: 'online', status_msg: null, last_active_ts: 0 },
        ],
      ])
    );

    await updateLastActive(db, '@u:ex.com');
    expect(db.updates).toEqual([{ ts: NOW, userId: '@u:ex.com' }]);
    expect(db.rows.get('@u:ex.com')?.last_active_ts).toBe(NOW);
  });

  it('writes a newer timestamp after the clock advances', async () => {
    const db = createPresenceDb(
      new Map([
        [
          '@u:ex.com',
          { presence: 'online', status_msg: null, last_active_ts: 0 },
        ],
      ])
    );

    await updateLastActive(db, '@u:ex.com');
    vi.setSystemTime(NOW + 60_000);
    await updateLastActive(db, '@u:ex.com');

    expect(db.updates).toEqual([
      { ts: NOW, userId: '@u:ex.com' },
      { ts: NOW + 60_000, userId: '@u:ex.com' },
    ]);
  });
});
