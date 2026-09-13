import { describe, it, expect, vi } from 'vitest';
import {
  FakeDurableObjectState,
  FakeWebSocket,
  durableObjectMockFactory,
} from './helpers/fake-durable-object';
import type { Env } from '../src/types';

vi.mock('cloudflare:workers', () => durableObjectMockFactory());

import { AdminDurableObject } from '../src/durable-objects/AdminDurableObject';

function mockAdminDb(counts: { count?: number; total_size?: number } = {}) {
  const row = { count: counts.count ?? 0, total_size: counts.total_size ?? 0 };
  return {
    prepare(_sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
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
