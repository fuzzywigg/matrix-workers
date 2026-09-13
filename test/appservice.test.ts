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

  it('does not match membership state_key against room namespaces', () => {
    expect(
      getInterestedAppServices([bridge], {
        room_id: '!plain:example.com',
        sender: '@admin:example.com',
        state_key: '!bridge_portal:example.com',
        type: 'm.room.member',
      })
    ).toEqual([]);
  });
});

describe('isExclusiveAppServiceAlias excludeAsId', () => {
  it('honors excludeAsId for exclusive aliases', () => {
    expect(
      isExclusiveAppServiceAlias([bridge], '#_bridge_room:example.com', 'bridge')
    ).toBeNull();
    expect(
      isExclusiveAppServiceAlias([bridge], '#_bridge_room:example.com', 'other')
    ).toBe(bridge);
  });
});

describe('appservice empty namespaces', () => {
  it('handles registrations with empty namespace lists', () => {
    const empty = registration('empty', { users: [], rooms: [], aliases: [] });
    expect(isExclusiveAppServiceUser([empty], '@anyone:example.com')).toBeNull();
    expect(isExclusiveAppServiceAlias([empty], '#anyone:example.com')).toBeNull();
    expect(
      getInterestedAppServices([empty], {
        room_id: '!r:example.com',
        sender: '@a:example.com',
        type: 'm.room.message',
      })
    ).toEqual([]);
  });
});

describe('appservice interest failure edges', () => {
  it('does not treat exclusive room namespaces as exclusive users', () => {
    const roomOnly = registration('roomy', {
      users: [],
      rooms: [{ exclusive: true, regex: '^!secret_.*:example\\.com$' }],
      aliases: [],
    });
    expect(isExclusiveAppServiceUser([roomOnly], '@anyone:example.com')).toBeNull();
    expect(
      getInterestedAppServices([roomOnly], {
        room_id: '!secret_portal:example.com',
        sender: '@alice:example.com',
        type: 'm.room.message',
      })
    ).toEqual([roomOnly]);
  });

  it('matches non-exclusive user namespaces for interest but not exclusivity', () => {
    expect(isExclusiveAppServiceUser([soft], '@_soft_bot:example.com')).toBeNull();
    expect(
      getInterestedAppServices([soft], {
        room_id: '!plain:example.com',
        sender: '@_soft_bot:example.com',
        type: 'm.room.message',
      })
    ).toEqual([soft]);
  });

  it('returns empty interest for an empty appservice list', () => {
    expect(
      getInterestedAppServices([], {
        room_id: '!r:example.com',
        sender: '@a:example.com',
        type: 'm.room.message',
      })
    ).toEqual([]);
  });
});


describe('appservice TOKENMAXX edge paths after #49', () => {
  it('returns the first exclusive user registration when multiple match', () => {
    const first = registration('first', {
      users: [{ exclusive: true, regex: '^@_shared_.*:example\\.com$' }],
      rooms: [],
      aliases: [],
    });
    const second = registration('second', {
      users: [{ exclusive: true, regex: '^@_shared_.*:example\\.com$' }],
      rooms: [],
      aliases: [],
    });
    expect(isExclusiveAppServiceUser([first, second], '@_shared_bot:example.com')).toBe(first);
  });
});

describe('appservice TOKENMAXX edge paths after #50', () => {
  it('lets the first exclusive alias registration win among duplicates', () => {
    const first = registration('first', {
      users: [],
      rooms: [],
      aliases: [{ exclusive: true, regex: '^#_shared_.*:example\\.com$' }],
    });
    const second = registration('second', {
      users: [],
      rooms: [],
      aliases: [{ exclusive: true, regex: '^#_shared_.*:example\\.com$' }],
    });
    expect(isExclusiveAppServiceAlias([first, second], '#_shared_room:example.com')).toBe(first);
  });

  it('is interested when the sender matches an exclusive user ns even if room ns misses', () => {
    const interested = getInterestedAppServices(
      [bridge],
      {
        type: 'm.room.message',
        sender: '@_bridge_bot:example.com',
        room_id: '!unrelated:example.com',
        content: { body: 'hi', msgtype: 'm.text' },
      } as never
    );
    expect(interested.map((r) => r.id)).toContain('bridge');
  });
});
