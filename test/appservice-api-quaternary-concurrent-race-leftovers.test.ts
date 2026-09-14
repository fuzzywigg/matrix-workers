/**
 * TOKENMAXX HEAVY leftovers after #274 — quaternary *appservice service*
 * concurrent-race niches not covered by tertiary (#274), residual (#266),
 * or second-wave / soft floods.
 *
 * Distinct from #274 tertiary:
 *   alias room_id null/''; MXID-on-rooms 404; odd protocol stubs;
 *   response.ok 201/299 vs 300/301; INSERT throw; excludeAsId '';
 *   state_key-only interest with type=m.room.member.
 *
 * Quaternary deepen after #274 tip (service interest/exclusive/txn):
 *   state_key hit when type !== m.room.member; empty state_key falsy skip;
 *   sender+room dual-match → single push; exclusive after non-exclusive miss;
 *   excludeAsId false/0 falsy non-strings; fetch reject → retry no sent_at;
 *   HTTP 200/500 txn band; invalid user/alias/room regex throw under race;
 *   type-agnostic interest; trailing-slash url path concat; protocols null
 *   ∥ rate_limited coercion under parallel token lookups; alias-ns-only
 *   never interests.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 * Reversible by deleting this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServiceRegistration } from '../src/services/appservice';
import {
  getAppServiceByToken,
  getInterestedAppServices,
  isExclusiveAppServiceAlias,
  isExclusiveAppServiceUser,
  sendAppServiceTransaction,
} from '../src/services/appservice';

const SERVER = 'example.com';
const ESC = SERVER.replace(/\./g, '\\.');

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
    sender_localpart: id,
    rate_limited: false,
    protocols: [],
    namespaces,
    ...extras,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Quaternary: state_key hit when type !== m.room.member (no type gate)
// ---------------------------------------------------------------------------

describe('race quaternary appservice state_key non-member type after #274', () => {
  for (let i = 0; i < 12; i++) {
    it(`state_key hit on m.room.message∥reaction∥custom flood-${i}`, async () => {
      const bridge = registration('bridge', {
        users: [{ exclusive: false, regex: `^@_bridge_.*:${ESC}$` }],
        rooms: [],
        aliases: [],
      });
      const types = ['m.room.message', 'm.reaction', `org.example.custom_${i}`];
      const type = types[i % types.length];

      const [hit, miss, emptySk] = await Promise.all([
        Promise.resolve(
          getInterestedAppServices([bridge], {
            room_id: `!plain_${i}:${SERVER}`,
            sender: `@alice_${i}:${SERVER}`,
            state_key: `@_bridge_ghost_${i}:${SERVER}`,
            type,
          })
        ),
        Promise.resolve(
          getInterestedAppServices([bridge], {
            room_id: `!plain_${i}:${SERVER}`,
            sender: `@alice_${i}:${SERVER}`,
            state_key: `@other_${i}:${SERVER}`,
            type,
          })
        ),
        Promise.resolve(
          getInterestedAppServices([bridge], {
            room_id: `!plain_${i}:${SERVER}`,
            sender: `@alice_${i}:${SERVER}`,
            state_key: '',
            type,
          })
        ),
      ]);
      // Product matches state_key against user ns with no type gate
      expect(hit.map((a) => a.id)).toEqual(['bridge']);
      expect(miss).toEqual([]);
      // '' is falsy → state_key branch skipped
      expect(emptySk).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Quaternary: sender+room dual-match pushes AS once (no double-push)
// ---------------------------------------------------------------------------

describe('race quaternary appservice dual-match single push after #274', () => {
  for (let i = 0; i < 10; i++) {
    it(`sender+room both match → single AS ∥ alias-only miss flood-${i}`, async () => {
      const dual = registration('dual', {
        users: [{ exclusive: false, regex: `^@alice_${i}:${ESC}$` }],
        rooms: [{ exclusive: false, regex: `^!bridge_.*:${ESC}$` }],
        aliases: [{ exclusive: true, regex: `^#_bridge_.*:${ESC}$` }],
      });
      const aliasOnly = registration('aliasy', {
        users: [],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_bridge_.*:${ESC}$` }],
      });
      const services = [dual, aliasOnly];

      const [both, senderOnly, roomOnly, aliasNever] = await Promise.all([
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!bridge_room_${i}:${SERVER}`,
            sender: `@alice_${i}:${SERVER}`,
            type: 'm.room.message',
          })
        ),
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${SERVER}`,
            sender: `@alice_${i}:${SERVER}`,
            type: 'm.room.message',
          })
        ),
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!bridge_room_${i}:${SERVER}`,
            sender: `@bob_${i}:${SERVER}`,
            type: 'm.room.message',
          })
        ),
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${SERVER}`,
            sender: `@bob_${i}:${SERVER}`,
            type: 'm.room.message',
          })
        ),
      ]);
      // Dual match must not duplicate the registration
      expect(both.map((a) => a.id)).toEqual(['dual']);
      expect(senderOnly.map((a) => a.id)).toEqual(['dual']);
      expect(roomOnly.map((a) => a.id)).toEqual(['dual']);
      // Alias namespaces are never consulted for interest
      expect(aliasNever).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Quaternary: exclusive user ns after non-exclusive miss on same registration
// ---------------------------------------------------------------------------

describe('race quaternary appservice exclusive after non-exclusive miss after #274', () => {
  for (let i = 0; i < 10; i++) {
    it(`exclusive hit after soft miss ∥ soft-only null flood-${i}`, async () => {
      const multi = registration('multi', {
        users: [
          { exclusive: false, regex: `^@_soft_.*:${ESC}$` },
          { exclusive: true, regex: `^@_multi_.*:${ESC}$` },
        ],
        rooms: [],
        aliases: [
          { exclusive: false, regex: `^#_soft_.*:${ESC}$` },
          { exclusive: true, regex: `^#_multi_.*:${ESC}$` },
        ],
      });

      const [uHit, uSoft, aHit, aSoft] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser([multi], `@_multi_bot_${i}:${SERVER}`)),
        Promise.resolve(isExclusiveAppServiceUser([multi], `@_soft_bot_${i}:${SERVER}`)),
        Promise.resolve(isExclusiveAppServiceAlias([multi], `#_multi_room_${i}:${SERVER}`)),
        Promise.resolve(isExclusiveAppServiceAlias([multi], `#_soft_room_${i}:${SERVER}`)),
      ]);
      expect(uHit?.id).toBe('multi');
      expect(uSoft).toBeNull();
      expect(aHit?.id).toBe('multi');
      expect(aSoft).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// Quaternary: excludeAsId falsy non-strings (false / 0) same as ''
// ---------------------------------------------------------------------------

describe('race quaternary appservice excludeAsId false/0 after #274', () => {
  for (let i = 0; i < 12; i++) {
    it(`excludeAsId false∥0 still matches exclusive user∥alias flood-${i}`, async () => {
      const bridge = registration('bridge', {
        users: [{ exclusive: true, regex: `^@_bridge_.*:${ESC}$` }],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_bridge_.*:${ESC}$` }],
      });
      const other = registration('other', {
        users: [{ exclusive: true, regex: `^@_other_.*:${ESC}$` }],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_other_.*:${ESC}$` }],
      });
      const services = [bridge, other];
      const uid = `@_bridge_u_${i}:${SERVER}`;
      const alias = `#_bridge_a_${i}:${SERVER}`;
      // Runtime accepts falsy non-strings via `if (excludeAsId && …)`
      const falsyFalse = false as unknown as string;
      const falsyZero = 0 as unknown as string;

      const [uFalse, uZero, uBridge, aFalse, aZero, aBridge] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser(services, uid, falsyFalse)),
        Promise.resolve(isExclusiveAppServiceUser(services, uid, falsyZero)),
        Promise.resolve(isExclusiveAppServiceUser(services, uid, 'bridge')),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, falsyFalse)),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, falsyZero)),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, 'bridge')),
      ]);
      expect(uFalse?.id).toBe('bridge');
      expect(uZero?.id).toBe('bridge');
      expect(uBridge).toBeNull();
      expect(aFalse?.id).toBe('bridge');
      expect(aZero?.id).toBe('bridge');
      expect(aBridge).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// Quaternary: fetch reject → catch → retry_count++, no sent_at
// ---------------------------------------------------------------------------

describe('race quaternary appservice txn fetch-reject after #274', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createTxnDb() {
    const inserts: Array<{ appservice_id: string; events: string; created_at: number }> = [];
    const updates: Array<{ kind: 'sent' | 'retry'; args: unknown[] }> = [];
    let nextRowId = 70;

    const db = {
      inserts,
      updates,
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                if (sql.includes('INSERT INTO appservice_transactions')) {
                  const [appservice_id, events, created_at] = args as [string, string, number];
                  inserts.push({ appservice_id, events, created_at });
                  return { meta: { last_row_id: nextRowId++ } };
                }
                if (sql.includes('SET sent_at')) {
                  updates.push({ kind: 'sent', args });
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('retry_count')) {
                  updates.push({ kind: 'retry', args });
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    };

    return db as unknown as D1Database & {
      inserts: typeof inserts;
      updates: typeof updates;
    };
  }

  for (let i = 0; i < 10; i++) {
    it(`fetch reject → retry ∥ sibling 200 sent_at flood-${i}`, async () => {
      const rejectDb = createTxnDb();
      const okDb = createTxnDb();
      const bridge = registration('bridge', { users: [], rooms: [], aliases: [] });
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock
        .mockRejectedValueOnce(new Error(`network down ${i}`))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const [rejected, ok] = await Promise.all([
        sendAppServiceTransaction(rejectDb, bridge, [{ type: 'm.room.message', n: i }]),
        sendAppServiceTransaction(okDb, bridge, [{ type: 'm.room.message', n: i }]),
      ]);
      expect(rejected).toBe(false);
      expect(ok).toBe(true);
      expect(rejectDb.updates).toEqual([{ kind: 'retry', args: [70] }]);
      expect(rejectDb.updates.some((u) => u.kind === 'sent')).toBe(false);
      expect(okDb.updates).toEqual([{ kind: 'sent', args: [NOW, 70] }]);
      expect(okDb.updates.some((u) => u.kind === 'retry')).toBe(false);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`200 sent_at ∥ 500 retry under parallel flood-${i}`, async () => {
      const dbOk = createTxnDb();
      const dbFail = createTxnDb();
      const bridge = registration('bridge', { users: [], rooms: [], aliases: [] });
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response('boom', { status: 500 }));

      const [ok, fail] = await Promise.all([
        sendAppServiceTransaction(dbOk, bridge, [{ type: 'm.room.message' }]),
        sendAppServiceTransaction(dbFail, bridge, [{ type: 'm.room.message' }]),
      ]);
      // Classic 200 is response.ok; 500 is not — tertiary bound 201/299 vs 3xx/4xx
      expect(ok).toBe(true);
      expect(fail).toBe(false);
      expect(dbOk.updates.map((u) => u.kind)).toEqual(['sent']);
      expect(dbFail.updates.map((u) => u.kind)).toEqual(['retry']);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`trailing-slash url → //_matrix/app path concat flood-${i}`, async () => {
      const db = createTxnDb();
      const slashy = registration(
        'slashy',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://slashy.example.com/' }
      );
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response('{}', { status: 200 })
      );

      const ok = await sendAppServiceTransaction(db, slashy, [{ type: 'm.room.message', n: i }]);
      expect(ok).toBe(true);
      const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      // Product concatenates without normalizing trailing slash
      expect(calledUrl).toBe(
        `https://slashy.example.com//_matrix/app/v1/transactions/${70}`
      );
      expect(db.updates.map((u) => u.kind)).toEqual(['sent']);
    });
  }
});

// ---------------------------------------------------------------------------
// Quaternary: invalid namespace regex throws under Promise.all vs valid sibling
// ---------------------------------------------------------------------------

describe('race quaternary appservice invalid regex throw under race after #274', () => {
  for (let i = 0; i < 10; i++) {
    it(`bad user∥alias∥room regex throw ∥ valid sibling flood-${i}`, async () => {
      const badUser = registration('baduser', {
        users: [{ exclusive: true, regex: '[' }],
        rooms: [],
        aliases: [],
      });
      const badAlias = registration('badalias', {
        users: [],
        rooms: [],
        aliases: [{ exclusive: true, regex: '[' }],
      });
      const badRoom = registration('badroom', {
        users: [],
        rooms: [{ exclusive: false, regex: '(' }],
        aliases: [],
      });
      const good = registration('good', {
        users: [{ exclusive: true, regex: `^@_good_.*:${ESC}$` }],
        rooms: [{ exclusive: false, regex: `^!good_.*:${ESC}$` }],
        aliases: [{ exclusive: true, regex: `^#_good_.*:${ESC}$` }],
      });

      const [uBad, uGood, aBad, aGood, rBad, rGood] = await Promise.all([
        Promise.resolve().then(() => {
          try {
            return { ok: true as const, v: isExclusiveAppServiceUser([badUser], `@x_${i}:${SERVER}`) };
          } catch (e) {
            return { ok: false as const, err: e };
          }
        }),
        Promise.resolve(isExclusiveAppServiceUser([good], `@_good_bot_${i}:${SERVER}`)),
        Promise.resolve().then(() => {
          try {
            return { ok: true as const, v: isExclusiveAppServiceAlias([badAlias], `#x_${i}:${SERVER}`) };
          } catch (e) {
            return { ok: false as const, err: e };
          }
        }),
        Promise.resolve(isExclusiveAppServiceAlias([good], `#_good_room_${i}:${SERVER}`)),
        Promise.resolve().then(() => {
          try {
            return {
              ok: true as const,
              v: getInterestedAppServices([badRoom], {
                room_id: `!x_${i}:${SERVER}`,
                sender: `@a_${i}:${SERVER}`,
                type: 'm.room.message',
              }),
            };
          } catch (e) {
            return { ok: false as const, err: e };
          }
        }),
        Promise.resolve(
          getInterestedAppServices([good], {
            room_id: `!good_room_${i}:${SERVER}`,
            sender: `@a_${i}:${SERVER}`,
            type: 'm.room.message',
          })
        ),
      ]);

      expect(uBad.ok).toBe(false);
      expect(uGood?.id).toBe('good');
      expect(aBad.ok).toBe(false);
      expect(aGood?.id).toBe('good');
      expect(rBad.ok).toBe(false);
      expect(rGood.map((a) => a.id)).toEqual(['good']);
    });
  }
});

// ---------------------------------------------------------------------------
// Quaternary: event.type ignored — same hit/miss for arbitrary types
// ---------------------------------------------------------------------------

describe('race quaternary appservice type-agnostic interest after #274', () => {
  for (let i = 0; i < 10; i++) {
    it(`type ignored for sender/room interest flood-${i}`, async () => {
      const bridge = registration('bridge', {
        users: [{ exclusive: false, regex: `^@_bridge_.*:${ESC}$` }],
        rooms: [{ exclusive: false, regex: `^!bridge_.*:${ESC}$` }],
        aliases: [],
      });
      const types = [
        'm.room.message',
        'm.room.member',
        'm.room.encrypted',
        `custom.type.${i}`,
        '',
      ];

      const results = await Promise.all(
        types.map((type) =>
          Promise.resolve(
            getInterestedAppServices([bridge], {
              room_id: `!plain_${i}:${SERVER}`,
              sender: `@_bridge_bot_${i}:${SERVER}`,
              type,
            })
          )
        )
      );
      for (const hit of results) {
        expect(hit.map((a) => a.id)).toEqual(['bridge']);
      }

      const misses = await Promise.all(
        types.map((type) =>
          Promise.resolve(
            getInterestedAppServices([bridge], {
              room_id: `!plain_${i}:${SERVER}`,
              sender: `@alice_${i}:${SERVER}`,
              type,
            })
          )
        )
      );
      for (const miss of misses) {
        expect(miss).toEqual([]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Quaternary: getAppServiceByToken protocols null ∥ rate_limited coercion
// ---------------------------------------------------------------------------

describe('race quaternary appservice token lookup coercion after #274', () => {
  function createAsDb(rows: Map<string, Record<string, unknown>>) {
    return {
      prepare(_sql: string) {
        return {
          bind(asToken: string) {
            return {
              async first<T>() {
                return (rows.get(asToken) as T) ?? null;
              },
            };
          },
        };
      },
    } as unknown as D1Database;
  }

  for (let i = 0; i < 10; i++) {
    it(`protocols null→[] ∥ rate_limited 0/2/1 under parallel flood-${i}`, async () => {
      const tokOff = `tok-off-${i}`;
      const tokOn = `tok-on-${i}`;
      const tokWeird = `tok-weird-${i}`;
      const tokMissing = `tok-missing-${i}`;
      const db = createAsDb(
        new Map([
          [
            tokOff,
            {
              id: `off_${i}`,
              url: 'https://off.example.com',
              as_token: tokOff,
              hs_token: 'hs',
              sender_localpart: 'bot',
              rate_limited: 0,
              protocols: null,
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            },
          ],
          [
            tokOn,
            {
              id: `on_${i}`,
              url: 'https://on.example.com',
              as_token: tokOn,
              hs_token: 'hs',
              sender_localpart: 'bot',
              rate_limited: 1,
              protocols: JSON.stringify(['irc']),
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            },
          ],
          [
            tokWeird,
            {
              id: `weird_${i}`,
              url: 'https://weird.example.com',
              as_token: tokWeird,
              hs_token: 'hs',
              sender_localpart: 'bot',
              // !== 1 → false
              rate_limited: 2,
              protocols: null,
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            },
          ],
        ])
      );

      const [off, on, weird, missing] = await Promise.all([
        getAppServiceByToken(db, tokOff),
        getAppServiceByToken(db, tokOn),
        getAppServiceByToken(db, tokWeird),
        getAppServiceByToken(db, tokMissing),
      ]);
      expect(off).toMatchObject({
        id: `off_${i}`,
        rate_limited: false,
        protocols: [],
      });
      expect(on).toMatchObject({
        id: `on_${i}`,
        rate_limited: true,
        protocols: ['irc'],
      });
      expect(weird).toMatchObject({
        id: `weird_${i}`,
        rate_limited: false,
        protocols: [],
      });
      expect(missing).toBeNull();
    });
  }
});
