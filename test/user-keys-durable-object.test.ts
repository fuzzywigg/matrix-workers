import { describe, it, expect, vi } from 'vitest';
import { FakeDurableObjectState, durableObjectMockFactory } from './helpers/fake-durable-object';
import type { Env } from '../src/types';

vi.mock('cloudflare:workers', () => durableObjectMockFactory());

import { UserKeysDurableObject } from '../src/durable-objects/UserKeysDurableObject';

function makeKeys(state = new FakeDurableObjectState()) {
  return {
    state,
    do: new UserKeysDurableObject(state as unknown as DurableObjectState, {} as Env),
  };
}

describe('UserKeysDurableObject TOKENMAXX edge paths after #57', () => {
  it('returns 404 for unknown paths', async () => {
    const { do: keys } = makeKeys();
    expect((await keys.fetch(new Request('https://do/nope'))).status).toBe(404);
  });

  it('round-trips account-data put/get and lists empty when unset', async () => {
    const { do: keys } = makeKeys();
    const empty = await keys.fetch(new Request('https://do/account-data/get'));
    expect(await empty.json()).toEqual({});

    const put = await keys.fetch(
      new Request('https://do/account-data/put', {
        method: 'POST',
        body: JSON.stringify({
          event_type: 'm.secret_storage.default_key',
          content: { key: 'k1' },
        }),
      })
    );
    expect(await put.json()).toEqual({ success: true });

    const one = await keys.fetch(
      new Request('https://do/account-data/get?event_type=m.secret_storage.default_key')
    );
    expect(await one.json()).toEqual({ key: 'k1' });

    const missing = await keys.fetch(
      new Request('https://do/account-data/get?event_type=m.missing')
    );
    expect(await missing.json()).toBeNull();
  });

  it('round-trips device keys put/get/list', async () => {
    const { do: keys } = makeKeys();
    expect(await (await keys.fetch(new Request('https://do/device-keys/list'))).json()).toEqual(
      []
    );

    await keys.fetch(
      new Request('https://do/device-keys/put', {
        method: 'POST',
        body: JSON.stringify({
          device_id: 'DEVICE1',
          keys: { algorithms: ['m.olm.v1.curve25519-aes-sha2'] },
        }),
      })
    );

    expect(await (await keys.fetch(new Request('https://do/device-keys/list'))).json()).toEqual([
      'DEVICE1',
    ]);
    expect(
      await (
        await keys.fetch(new Request('https://do/device-keys/get?device_id=DEVICE1'))
      ).json()
    ).toEqual({ algorithms: ['m.olm.v1.curve25519-aes-sha2'] });
    expect(
      await (await keys.fetch(new Request('https://do/device-keys/get'))).json()
    ).toEqual({
      DEVICE1: { algorithms: ['m.olm.v1.curve25519-aes-sha2'] },
    });
  });

  it('round-trips cross-signing put/get/delete', async () => {
    const { do: keys } = makeKeys();
    expect(await (await keys.fetch(new Request('https://do/cross-signing/get'))).json()).toEqual(
      {}
    );

    await keys.fetch(
      new Request('https://do/cross-signing/put', {
        method: 'POST',
        body: JSON.stringify({ master: { keys: { 'ed25519:A': 'pub' } } }),
      })
    );
    expect(await (await keys.fetch(new Request('https://do/cross-signing/get'))).json()).toEqual({
      master: { keys: { 'ed25519:A': 'pub' } },
    });

    await keys.fetch(new Request('https://do/cross-signing/delete', { method: 'POST' }));
    expect(await (await keys.fetch(new Request('https://do/cross-signing/get'))).json()).toEqual(
      {}
    );
  });
});

describe('UserKeysDurableObject TOKENMAXX edge paths after #58', () => {
  it('merges cross-signing keys across puts', async () => {
    const { do: keys } = makeKeys();
    await keys.fetch(
      new Request('https://do/cross-signing/put', {
        method: 'POST',
        body: JSON.stringify({ master: { keys: { 'ed25519:M': 'm' } } }),
      })
    );
    await keys.fetch(
      new Request('https://do/cross-signing/put', {
        method: 'POST',
        body: JSON.stringify({ self_signing: { keys: { 'ed25519:S': 's' } } }),
      })
    );
    expect(await (await keys.fetch(new Request('https://do/cross-signing/get'))).json()).toEqual({
      master: { keys: { 'ed25519:M': 'm' } },
      self_signing: { keys: { 'ed25519:S': 's' } },
    });
  });

  it('stores signatures once, filters by target_key_id, and skips duplicates', async () => {
    const { do: keys } = makeKeys();
    const sig = {
      signer_user_id: '@a:ex.com',
      signer_key_id: 'ed25519:S',
      target_user_id: '@b:ex.com',
      target_key_id: 'ed25519:T',
      signature: 'abc',
    };

    expect(
      await (
        await keys.fetch(
          new Request('https://do/signatures/put', {
            method: 'POST',
            body: JSON.stringify(sig),
          })
        )
      ).json()
    ).toEqual({ success: true });
    await keys.fetch(
      new Request('https://do/signatures/put', {
        method: 'POST',
        body: JSON.stringify(sig),
      })
    );

    expect(await (await keys.fetch(new Request('https://do/signatures/get'))).json()).toEqual([
      sig,
    ]);
    expect(
      await (
        await keys.fetch(new Request('https://do/signatures/get?target_key_id=ed25519:T'))
      ).json()
    ).toEqual([sig]);
    expect(
      await (
        await keys.fetch(new Request('https://do/signatures/get?target_key_id=missing'))
      ).json()
    ).toEqual([]);
  });

  it('returns 500 for malformed JSON on POST endpoints', async () => {
    const { do: keys } = makeKeys();
    const res = await keys.fetch(
      new Request('https://do/signatures/put', { method: 'POST', body: '{not-json' })
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
