import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FakeDurableObjectState,
  FakeWebSocket,
  durableObjectMockFactory,
} from './helpers/fake-durable-object';
import type { Env } from '../src/types';

vi.mock('cloudflare:workers', () => durableObjectMockFactory());

import { AdminDurableObject } from '../src/durable-objects/AdminDurableObject';

function mockAdminDb(
  counts: { count?: number; total_size?: number } = {},
  tracker?: { prepares: number; firsts: number }
) {
  const row = { count: counts.count ?? 0, total_size: counts.total_size ?? 0 };
  return {
    prepare(_sql: string) {
      if (tracker) tracker.prepares++;
      return {
        bind() {
          return this;
        },
        async first() {
          if (tracker) tracker.firsts++;
          return row;
        },
      };
    },
  };
}

function makeAdmin(env: Partial<Env> = {}, state = new FakeDurableObjectState()) {
  return {
    state,
    do: new AdminDurableObject(state as unknown as DurableObjectState, {
      DB: mockAdminDb(),
      ...env,
    } as Env),
  };
}

describe('AdminDurableObject TOKENMAXX edge paths after #58', () => {
  it('returns 404 for unknown paths', async () => {
    const { do: admin } = makeAdmin();
    const res = await admin.fetch(new Request('https://do/nope'));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
  });

  it('serves default config and round-trips PUT updates', async () => {
    const { state, do: admin } = makeAdmin();
    const getDefault = await admin.fetch(new Request('https://do/config'));
    expect(await getDefault.json()).toEqual({
      registration_enabled: true,
      updated_at: 0,
    });

    const put = await admin.fetch(
      new Request('https://do/config', {
        method: 'PUT',
        body: JSON.stringify({ registration_enabled: false }),
      })
    );
    const updated = (await put.json()) as { registration_enabled: boolean; updated_at: number };
    expect(updated.registration_enabled).toBe(false);
    expect(updated.updated_at).toBeGreaterThan(0);
    expect(state.storage.map.get('config')).toMatchObject({
      registration_enabled: false,
    });

    const getAgain = await admin.fetch(new Request('https://do/config'));
    expect(await getAgain.json()).toMatchObject({ registration_enabled: false });
  });

  it('rejects unsupported config methods with 405', async () => {
    const { do: admin } = makeAdmin();
    const res = await admin.fetch(new Request('https://do/config', { method: 'POST' }));
    expect(res.status).toBe(405);
    expect(await res.text()).toBe('Method not allowed');
  });

  it('invalidates persisted stats_cache and returns OK', async () => {
    const { state, do: admin } = makeAdmin();
    await state.storage.put('stats_cache', { stats: { users: { total: 1 } }, timestamp: 1 });
    const res = await admin.fetch(new Request('https://do/invalidate-cache'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
    expect(state.storage.map.has('stats_cache')).toBe(false);
  });

  it('returns 426 without websocket upgrade and 400 when user_id missing', async () => {
    const { do: admin } = makeAdmin();
    const noUpgrade = await admin.fetch(new Request('https://do/websocket'));
    expect(noUpgrade.status).toBe(426);
    expect(await noUpgrade.text()).toBe('Expected websocket upgrade');

    const missingUser = await admin.fetch(
      new Request('https://do/websocket', { headers: { Upgrade: 'websocket' } })
    );
    expect(missingUser.status).toBe(400);
    expect(await missingUser.text()).toBe('Missing user_id');
  });

  it('serves stats from D1 mock and broadcasts to connected admin sockets', async () => {
    const state = new FakeDurableObjectState();
    const ws = new FakeWebSocket();
    state.sockets.push(ws);
    const { do: admin } = makeAdmin({ DB: mockAdminDb({ count: 3, total_size: 99 }) as Env['DB'] }, state);

    const stats = await admin.fetch(new Request('https://do/stats'));
    expect(stats.status).toBe(200);
    expect(await stats.json()).toMatchObject({
      users: { total: 3, active: 3, registrations_24h: 3 },
      rooms: { total: 3 },
      media: { count: 3, total_size_bytes: 99 },
      unresolvedReports: 3,
    });
    expect(state.storage.map.has('stats_cache')).toBe(true);

    const cached = await admin.fetch(new Request('https://do/stats'));
    expect(cached.status).toBe(200);

    const broadcast = await admin.fetch(
      new Request('https://do/broadcast', {
        method: 'POST',
        body: JSON.stringify({ type: 'ping_admins' }),
      })
    );
    expect(await broadcast.text()).toBe('OK');
    expect(ws.sent).toContain(JSON.stringify({ type: 'ping_admins' }));
  });
});

describe('AdminDurableObject TOKENMAXX clock boundaries after #61', () => {
  const NOW = 1_700_000_000_000;
  const STATS_CACHE_TTL = 30_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves in-memory stats cache until exact STATS_CACHE_TTL then refreshes', async () => {
    const tracker = { prepares: 0, firsts: 0 };
    const { do: admin } = makeAdmin({
      DB: mockAdminDb({ count: 1 }, tracker) as Env['DB'],
    });

    const first = await admin.fetch(new Request('https://do/stats'));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { lastUpdated: number };
    expect(firstBody.lastUpdated).toBe(NOW);
    const firstsAfterMiss = tracker.firsts;
    expect(firstsAfterMiss).toBeGreaterThan(0);

    vi.setSystemTime(NOW + STATS_CACHE_TTL - 1);
    const hit = await admin.fetch(new Request('https://do/stats'));
    expect(await hit.json()).toEqual(firstBody);
    expect(tracker.firsts).toBe(firstsAfterMiss);

    // (now - statsCacheTime) < TTL is false at exact TTL → refresh
    vi.setSystemTime(NOW + STATS_CACHE_TTL);
    const miss = await admin.fetch(new Request('https://do/stats'));
    const missBody = (await miss.json()) as { lastUpdated: number };
    expect(missBody.lastUpdated).toBe(NOW + STATS_CACHE_TTL);
    expect(tracker.firsts).toBeGreaterThan(firstsAfterMiss);
  });

  it('bypasses cache when refresh=true even inside TTL', async () => {
    const tracker = { prepares: 0, firsts: 0 };
    const { do: admin } = makeAdmin({
      DB: mockAdminDb({ count: 2 }, tracker) as Env['DB'],
    });

    await admin.fetch(new Request('https://do/stats'));
    const afterWarm = tracker.firsts;

    vi.setSystemTime(NOW + 1_000);
    await admin.fetch(new Request('https://do/stats?refresh=true'));
    expect(tracker.firsts).toBeGreaterThan(afterWarm);
  });

  it('pins config updated_at to Date.now on PUT', async () => {
    const { do: admin } = makeAdmin();
    const put = await admin.fetch(
      new Request('https://do/config', {
        method: 'PUT',
        body: JSON.stringify({ registration_enabled: false }),
      })
    );
    expect(await put.json()).toEqual({
      registration_enabled: false,
      updated_at: NOW,
    });

    vi.setSystemTime(NOW + 5_000);
    const put2 = await admin.fetch(
      new Request('https://do/config', {
        method: 'PUT',
        body: JSON.stringify({ registration_enabled: true }),
      })
    );
    expect(await put2.json()).toEqual({
      registration_enabled: true,
      updated_at: NOW + 5_000,
    });
  });

  it('alarm refreshes stats, broadcasts, and schedules +60s', async () => {
    const state = new FakeDurableObjectState();
    const ws = new FakeWebSocket();
    state.sockets.push(ws);
    const { do: admin } = makeAdmin(
      { DB: mockAdminDb({ count: 7 }) as Env['DB'] },
      state
    );

    await (admin as unknown as { alarm: () => Promise<void> }).alarm();

    expect(state.storage.alarm).toBe(NOW + 60_000);
    expect(state.storage.map.get('stats_cache')).toMatchObject({
      timestamp: NOW,
      stats: expect.objectContaining({
        users: expect.objectContaining({ total: 7 }),
        lastUpdated: NOW,
      }),
    });
    expect(ws.sent.some((s) => s.includes('"type":"stats"'))).toBe(true);

    // Warm in-memory cache via alarm; still within TTL → no D1 on /stats
    const tracker = { prepares: 0, firsts: 0 };
    const { do: admin2 } = makeAdmin({
      DB: mockAdminDb({ count: 9 }, tracker) as Env['DB'],
    });
    await (admin2 as unknown as { alarm: () => Promise<void> }).alarm();
    const afterAlarm = tracker.firsts;
    vi.setSystemTime(NOW + 10_000);
    await admin2.fetch(new Request('https://do/stats'));
    expect(tracker.firsts).toBe(afterAlarm);
  });

  it('webSocketMessage handles ping, get_stats, get_config, and ignores unknown', async () => {
    const { do: admin } = makeAdmin({
      DB: mockAdminDb({ count: 4 }) as Env['DB'],
    });
    const ws = new FakeWebSocket();

    await (
      admin as unknown as {
        webSocketMessage: (ws: FakeWebSocket, msg: string) => Promise<void>;
      }
    ).webSocketMessage(ws, JSON.stringify({ type: 'ping' }));
    expect(ws.sent).toContain(JSON.stringify({ type: 'pong' }));

    await (
      admin as unknown as {
        webSocketMessage: (ws: FakeWebSocket, msg: string) => Promise<void>;
      }
    ).webSocketMessage(ws, JSON.stringify({ type: 'get_stats' }));
    expect(ws.sent.some((s) => s.includes('"type":"stats"'))).toBe(true);

    await (
      admin as unknown as {
        webSocketMessage: (ws: FakeWebSocket, msg: string) => Promise<void>;
      }
    ).webSocketMessage(ws, JSON.stringify({ type: 'get_config' }));
    expect(ws.sent.some((s) => s.includes('"type":"config"'))).toBe(true);

    const before = ws.sent.length;
    await (
      admin as unknown as {
        webSocketMessage: (ws: FakeWebSocket, msg: string) => Promise<void>;
      }
    ).webSocketMessage(ws, JSON.stringify({ type: 'unknown_cmd' }));
    expect(ws.sent.length).toBe(before);

    await (
      admin as unknown as {
        webSocketMessage: (ws: FakeWebSocket, msg: string | ArrayBuffer) => Promise<void>;
      }
    ).webSocketMessage(ws, new ArrayBuffer(0));
    expect(ws.sent.length).toBe(before);
  });

  it('invalidate-cache clears in-memory TTL so next /stats hits D1', async () => {
    const tracker = { prepares: 0, firsts: 0 };
    const { do: admin } = makeAdmin({
      DB: mockAdminDb({ count: 5 }, tracker) as Env['DB'],
    });
    await admin.fetch(new Request('https://do/stats'));
    const afterWarm = tracker.firsts;

    vi.setSystemTime(NOW + 1_000);
    await admin.fetch(new Request('https://do/invalidate-cache'));
    await admin.fetch(new Request('https://do/stats'));
    expect(tracker.firsts).toBeGreaterThan(afterWarm);
  });
});
