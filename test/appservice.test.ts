import { describe, it, expect } from 'vitest';
import {
  isExclusiveAppServiceUser,
  isExclusiveAppServiceAlias,
  getInterestedAppServices,
  type AppServiceRegistration,
} from '../src/services/appservice';

function registration(
  id: string,
  namespaces: AppServiceRegistration['namespaces'],
  extras: Partial<AppServiceRegistration> = {}
): AppServiceRegistration {
  return {
    id,
    url: `https://${id}.example.com`,
    as_token: `as-${id}`,
    hs_token: `hs-${id}`,
    sender_localpart: `${id}_bot`,
    rate_limited: false,
    protocols: [],
    namespaces,
    ...extras,
  };
}

const bridge = registration('bridge', {
  users: [{ exclusive: true, regex: '^@_bridge_.*:example\\.com$' }],
  rooms: [{ exclusive: false, regex: '^!bridge_.*:example\\.com$' }],
  aliases: [{ exclusive: true, regex: '^#_bridge_.*:example\\.com$' }],
});

const soft = registration('soft', {
  users: [{ exclusive: false, regex: '^@_soft_.*:example\\.com$' }],
  rooms: [{ exclusive: false, regex: '^!soft_.*:example\\.com$' }],
  aliases: [{ exclusive: false, regex: '^#_soft_.*:example\\.com$' }],
});

describe('isExclusiveAppServiceUser', () => {
  it('matches exclusive user namespaces', () => {
    expect(isExclusiveAppServiceUser([bridge, soft], '@_bridge_alice:example.com')).toBe(bridge);
  });

  it('ignores non-exclusive user namespaces', () => {
    expect(isExclusiveAppServiceUser([soft], '@_soft_alice:example.com')).toBeNull();
  });

  it('returns null for non-matching users', () => {
    expect(isExclusiveAppServiceUser([bridge], '@alice:example.com')).toBeNull();
  });

  it('honors excludeAsId', () => {
    expect(isExclusiveAppServiceUser([bridge], '@_bridge_alice:example.com', 'bridge')).toBeNull();
    expect(isExclusiveAppServiceUser([bridge], '@_bridge_alice:example.com', 'other')).toBe(bridge);
  });
});

describe('isExclusiveAppServiceAlias', () => {
  it('matches exclusive alias namespaces', () => {
    expect(isExclusiveAppServiceAlias([bridge], '#_bridge_room:example.com')).toBe(bridge);
  });

  it('ignores non-exclusive aliases', () => {
    expect(isExclusiveAppServiceAlias([soft], '#_soft_room:example.com')).toBeNull();
  });

  it('returns null when no alias namespace matches', () => {
    expect(isExclusiveAppServiceAlias([bridge], '#general:example.com')).toBeNull();
  });
});

describe('getInterestedAppServices', () => {
  it('matches on sender user namespace (exclusive or not)', () => {
    const interested = getInterestedAppServices([bridge, soft], {
      room_id: '!other:example.com',
      sender: '@_soft_bot:example.com',
      type: 'm.room.message',
    });
    expect(interested.map((a) => a.id)).toEqual(['soft']);
  });

  it('matches membership state_key against user namespaces', () => {
    const interested = getInterestedAppServices([bridge], {
      room_id: '!room:example.com',
      sender: '@admin:example.com',
      state_key: '@_bridge_ghost:example.com',
      type: 'm.room.member',
    });
    expect(interested).toEqual([bridge]);
  });

  it('matches room namespaces when users do not', () => {
    const interested = getInterestedAppServices([bridge], {
      room_id: '!bridge_portal:example.com',
      sender: '@alice:example.com',
      type: 'm.room.message',
    });
    expect(interested).toEqual([bridge]);
  });

  it('can return multiple interested services', () => {
    const both = getInterestedAppServices([bridge, soft], {
      room_id: '!soft_room:example.com',
      sender: '@_bridge_alice:example.com',
      type: 'm.room.message',
    });
    expect(both.map((a) => a.id).sort()).toEqual(['bridge', 'soft']);
  });

  it('returns empty when nothing matches', () => {
    expect(
      getInterestedAppServices([bridge, soft], {
        room_id: '!plain:example.com',
        sender: '@alice:example.com',
        type: 'm.room.message',
      })
    ).toEqual([]);
  });
});
