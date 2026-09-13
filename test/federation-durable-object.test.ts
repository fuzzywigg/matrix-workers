import { describe, it, expect, vi } from 'vitest';
import { FakeDurableObjectState, durableObjectMockFactory } from './helpers/fake-durable-object';
import type { Env } from '../src/types';

vi.mock('cloudflare:workers', () => durableObjectMockFactory());

import { FederationDurableObject } from '../src/durable-objects/FederationDurableObject';

function makeFed(state = new FakeDurableObjectState()) {
  return {
    state,
    do: new FederationDurableObject(state as unknown as DurableObjectState, {} as Env),
  };
}

describe('FederationDurableObject TOKENMAXX edge paths after #57', () => {
  it('returns 404 for unknown paths', async () => {
    const { do: fed } = makeFed();
    const res = await fed.fetch(new Request('https://do/unknown'));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
  });

  it('rejects /receive without X-Matrix-Origin', async () => {
    const { do: fed } = makeFed();
    const res = await fed.fetch(
      new Request('https://do/receive', {
        method: 'POST',
        body: JSON.stringify({ pdus: [] }),
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('stores received PDUs and updates server status locally (no DNS)', async () => {
    const { state, do: fed } = makeFed();
    const res = await fed.fetch(
      new Request('https://do/receive', {
        method: 'POST',
        headers: { 'X-Matrix-Origin': 'remote.example.com' },
        body: JSON.stringify({
          pdus: [{ event_id: '$e1', type: 'm.room.message' }],
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pdus: { $e1: {} } });
    expect(state.storage.map.has('received:$e1')).toBe(true);
    expect(state.storage.map.get('server:remote.example.com')).toMatchObject({
      serverName: 'remote.example.com',
      retryCount: 0,
      nextRetry: null,
    });
  });

  it('returns unknown status for unseen servers and lists known servers', async () => {
    const { state, do: fed } = makeFed();
    await state.storage.put('server:known.example.com', {
      serverName: 'known.example.com',
      lastContact: 1,
      retryCount: 0,
      nextRetry: null,
    });

    const unknown = await fed.fetch(new Request('https://do/status?server=missing.example.com'));
    expect(await unknown.json()).toEqual({
      serverName: 'missing.example.com',
      status: 'unknown',
    });

    const listed = await fed.fetch(new Request('https://do/status'));
    expect(await listed.json()).toEqual({
      servers: [
        {
          serverName: 'known.example.com',
          lastContact: 1,
          retryCount: 0,
          nextRetry: null,
        },
      ],
    });
  });

  it('rejects /keys without server param; serves unexpired cached keys without network', async () => {
    const { state, do: fed } = makeFed();
    const missing = await fed.fetch(new Request('https://do/keys'));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    await state.storage.put('keys:cached.example.com', {
      data: { server_name: 'cached.example.com', verify_keys: {} },
      expires: Date.now() + 60_000,
    });
    const cached = await fed.fetch(new Request('https://do/keys?server=cached.example.com'));
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual({
      server_name: 'cached.example.com',
      verify_keys: {},
    });
  });
});
