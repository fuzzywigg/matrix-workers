/**
 * TOKENMAXX HEAVY leftovers after #286 — senary *filters + appservice + auth*
 * concurrent-race niches not covered by quinary (#286), quaternary (#276),
 * or tertiary (#274) floods.
 *
 * Distinct from #286 quinary:
 *   other-user bad-JSON 403; getAppServices 0/2/1; excludeAsId null;
 *   exclusive room; multi-AS; room-shaped state_key; whitespace state_key;
 *   sent_at throw; malformed protocols; SERVER_NAME case; empty sender;
 *   invalid+good .some; optionalAuth AS ignore.
 *
 * Senary deepen after #286 tip (wave-2 leftovers that missed squash + wave-3):
 *   excludeAsId NaN; first exclusive wins; sender+state_key multi-AS;
 *   protocols ' '/'' ByToken∥list∥auth; users:{} gate skip; dup access_token;
 *   retry_count UPDATE throw; last_row_id 0; rate_limited -1/99;
 *   state_key '0'; bad user-ns blocks room interest; multi-event txn body;
 *   url path-prefix concat; restrictive ns + sender outside; users:[null,good].
 *
 * Tests-only. Fixtures use example.com / matrix.example.com only.
 * No product inventing. Does not touch auth.ts source (HITL).
 * Reversible by deleting this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServiceRegistration } from '../src/services/appservice';
import {
  getAppServices,
  getAppServiceByToken,
  getInterestedAppServices,
  isExclusiveAppServiceAlias,
  isExclusiveAppServiceUser,
  sendAppServiceTransaction,
} from '../src/services/appservice';
import {
  extractAccessToken,
  requireAuth,
} from '../src/middleware/auth';
import { hashToken } from '../src/utils/crypto';

const AS_SERVER = 'example.com';
const AS_ESC = AS_SERVER.replace(/\./g, '\\.');
const AUTH_SERVER = 'matrix.example.com';

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

type TokenRow = { user_id: string; device_id: string | null };
type AsRow = {
  id: string;
  url: string;
  as_token: string;
  hs_token: string;
  sender_localpart: string;
  rate_limited: number;
  protocols: string | null;
  namespaces: string;
};

function createAuthDb(
  opts: {
    tokens?: Map<string, TokenRow>;
    appservices?: Map<string, AsRow>;
    throwOnAs?: boolean;
  } = {}
) {
  const tokens = opts.tokens ?? new Map<string, TokenRow>();
  const appservices = opts.appservices ?? new Map<string, AsRow>();
  return {
    tokens,
    appservices,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM access_tokens') && sql.includes('token_hash')) {
                const hash = args[0] as string;
                return (tokens.get(hash) as T) ?? null;
              }
              if (sql.includes('FROM appservice_registrations') && sql.includes('as_token')) {
                if (opts.throwOnAs) throw new Error('as lookup failed');
                const token = args[0] as string;
                return (appservices.get(token) as T) ?? null;
              }
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database & {
    tokens: Map<string, TokenRow>;
    appservices: Map<string, AsRow>;
  };
}

function asRow(
  partial: Partial<AsRow> & Pick<AsRow, 'as_token' | 'sender_localpart'>
): AsRow {
  return {
    id: partial.id ?? 'as1',
    url: partial.url ?? 'https://as.example.com',
    as_token: partial.as_token,
    hs_token: partial.hs_token ?? 'hs',
    sender_localpart: partial.sender_localpart,
    rate_limited: partial.rate_limited ?? 0,
    protocols: partial.protocols ?? null,
    namespaces:
      partial.namespaces ??
      JSON.stringify({
        users: [{ exclusive: true, regex: '@bot_.*:matrix\\.example\\.com' }],
        rooms: [],
        aliases: [],
      }),
  };
}

function makeAuthCtx(opts: {
  url?: string;
  headers?: Record<string, string>;
  db: D1Database;
  serverName?: string;
}) {
  const url = opts.url ?? `https://${AUTH_SERVER}/_matrix/client/v3/sync`;
  const headers = new Headers(opts.headers ?? {});
  const raw = new Request(url, { headers });
  const store = new Map<string, unknown>();
  return {
    req: {
      raw,
      url,
      header: (name: string) => headers.get(name),
    },
    env: { DB: opts.db, SERVER_NAME: opts.serverName ?? AUTH_SERVER },
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
    _store: store,
  } as any;
}

async function jsonBody(
  res: Response
): Promise<{ errcode: string; error: string; status: number }> {
  const body = (await res.json()) as { errcode: string; error: string };
  return { ...body, status: res.status };
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

// ===========================================================================
// AUTH — protocols whitespace / users:{} / dup access_token
// ===========================================================================

describe('race senary auth after #286 (real requireAuth)', () => {
  // requireAuth is the real export (no filter mock in this file)
  const realRequireAuth = requireAuth;

  describe('protocols whitespace throws under race', () => {
    for (let i = 0; i < 8; i++) {
      it(`protocols ' ' → unknown ∥ ''→[] ∥ null→[] flood-${i}`, async () => {
        const tokWs = `as_proto_ws_${i}`;
        const tokEmpty = `as_proto_empty_${i}`;
        const tokNull = `as_proto_null_${i}`;
        const dbWs = createAuthDb({
          appservices: new Map([
            [
              tokWs,
              asRow({
                as_token: tokWs,
                sender_localpart: 'wsproto',
                // " " is truthy → JSON.parse(" ") throws → swallowed to unknown
                protocols: ' ',
                namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
              }),
            ],
          ]),
        });
        const dbEmpty = createAuthDb({
          appservices: new Map([
            [
              tokEmpty,
              asRow({
                as_token: tokEmpty,
                sender_localpart: 'emptyproto',
                // "" is falsy → [] (same as null), not throw
                protocols: '',
                namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
              }),
            ],
          ]),
        });
        const dbNull = createAuthDb({
          appservices: new Map([
            [
              tokNull,
              asRow({
                as_token: tokNull,
                sender_localpart: 'nullproto',
                protocols: null,
                namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
              }),
            ],
          ]),
        });

        const wsCtx = makeAuthCtx({
          db: dbWs,
          headers: { Authorization: `Bearer ${tokWs}` },
        });
        const emptyCtx = makeAuthCtx({
          db: dbEmpty,
          headers: { Authorization: `Bearer ${tokEmpty}` },
        });
        const nullCtx = makeAuthCtx({
          db: dbNull,
          headers: { Authorization: `Bearer ${tokNull}` },
        });

        const [wsRes, emptyRes, nullRes] = await Promise.all([
          realRequireAuth()(wsCtx, vi.fn()),
          realRequireAuth()(emptyCtx, vi.fn(async () => 'empty')),
          realRequireAuth()(nullCtx, vi.fn(async () => 'ok')),
        ]);

        expect(await jsonBody(wsRes as Response)).toMatchObject({
          errcode: 'M_UNKNOWN_TOKEN',
          status: 401,
        });
        expect(emptyRes).toBe('empty');
        expect(emptyCtx.get('userId')).toBe(`@emptyproto:${AUTH_SERVER}`);
        expect(nullRes).toBe('ok');
        expect(nullCtx.get('userId')).toBe(`@nullproto:${AUTH_SERVER}`);
      });
    }
  });

  describe('namespaces.users {} skips gate', () => {
    for (let i = 0; i < 8; i++) {
      it(`users:{} allows any local ∥ foreign forbid ∥ array deny flood-${i}`, async () => {
        const tokObj = `as_users_obj_${i}`;
        const tokArr = `as_users_arr_${i}`;
        const dbObj = createAuthDb({
          appservices: new Map([
            [
              tokObj,
              asRow({
                as_token: tokObj,
                sender_localpart: 'objbot',
                // {}.length is undefined → gate skipped
                namespaces: JSON.stringify({
                  users: {},
                  rooms: [],
                  aliases: [],
                }),
              }),
            ],
          ]),
        });
        const dbArr = createAuthDb({
          appservices: new Map([
            [
              tokArr,
              asRow({
                as_token: tokArr,
                sender_localpart: 'arrbot',
                namespaces: JSON.stringify({
                  users: [
                    {
                      exclusive: true,
                      regex: `@arr_only_.*:${AUTH_SERVER.replace(/\./g, '\\.')}`,
                    },
                  ],
                  rooms: [],
                  aliases: [],
                }),
              }),
            ],
          ]),
        });

        const localAny = `@anyone_${i}:${AUTH_SERVER}`;
        const foreign = `@anyone_${i}:other.example.com`;
        const denied = `@anyone_${i}:${AUTH_SERVER}`;

        const [localRes, foreignRes, denyRes] = await Promise.all([
          realRequireAuth()(
            makeAuthCtx({
              db: dbObj,
              url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localAny)}`,
              headers: { Authorization: `Bearer ${tokObj}` },
            }),
            vi.fn(async () => 'local')
          ),
          realRequireAuth()(
            makeAuthCtx({
              db: dbObj,
              url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(foreign)}`,
              headers: { Authorization: `Bearer ${tokObj}` },
            }),
            vi.fn()
          ),
          realRequireAuth()(
            makeAuthCtx({
              db: dbArr,
              url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(denied)}`,
              headers: { Authorization: `Bearer ${tokArr}` },
            }),
            vi.fn()
          ),
        ]);

        expect(localRes).toBe('local');
        expect(await jsonBody(foreignRes as Response)).toMatchObject({
          errcode: 'M_FORBIDDEN',
          error: 'Cannot impersonate users on other servers',
          status: 403,
        });
        expect(await jsonBody(denyRes as Response)).toMatchObject({
          errcode: 'M_FORBIDDEN',
          error: 'User not in application service namespace',
          status: 403,
        });
      });
    }
  });

  describe('duplicate access_token query first-wins', () => {
    for (let i = 0; i < 8; i++) {
      it(`good&bad → good ∥ bad&good → unknown under race flood-${i}`, async () => {
        const good = `syt_dup_good_${i}`;
        const bad = `syt_dup_bad_${i}`;
        const goodHash = await hashToken(good);
        const db = createAuthDb({
          tokens: new Map([
            [goodHash, { user_id: `@dup_${i}:${AUTH_SERVER}`, device_id: 'D' }],
          ]),
        });

        // URLSearchParams.get returns first value only
        const goodFirst = makeAuthCtx({
          db,
          url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(good)}&access_token=${encodeURIComponent(bad)}`,
        });
        const badFirst = makeAuthCtx({
          db,
          url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(bad)}&access_token=${encodeURIComponent(good)}`,
        });

        expect(
          extractAccessToken(
            new Request(
              `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(good)}&access_token=${encodeURIComponent(bad)}`
            )
          )
        ).toBe(good);
        expect(
          extractAccessToken(
            new Request(
              `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(bad)}&access_token=${encodeURIComponent(good)}`
            )
          )
        ).toBe(bad);

        const [goodRes, badRes] = await Promise.all([
          realRequireAuth()(goodFirst, vi.fn(async () => 'good')),
          realRequireAuth()(badFirst, vi.fn()),
        ]);

        expect(goodRes).toBe('good');
        expect(goodFirst.get('userId')).toBe(`@dup_${i}:${AUTH_SERVER}`);
        expect(await jsonBody(badRes as Response)).toMatchObject({
          errcode: 'M_UNKNOWN_TOKEN',
          status: 401,
        });
      });
    }
  });
});

// ===========================================================================
// Senary deepen wave-2 (missed #286 squash) — appservice NaN / retry-throw / first-wins / cross-axis
// ===========================================================================

describe('race senary appservice excludeAsId NaN after #286', () => {
  for (let i = 0; i < 10; i++) {
    it(`excludeAsId NaN still matches exclusive user∥alias flood-${i}`, async () => {
      const bridge = registration('bridge', {
        users: [{ exclusive: true, regex: `^@_bridge_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_bridge_.*:${AS_ESC}$` }],
      });
      const other = registration('other', {
        users: [{ exclusive: true, regex: `^@_other_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_other_.*:${AS_ESC}$` }],
      });
      const services = [bridge, other];
      const uid = `@_bridge_u_${i}:${AS_SERVER}`;
      const alias = `#_bridge_a_${i}:${AS_SERVER}`;
      const falsyNan = NaN as unknown as string;

      const [uNan, uBridge, aNan, aBridge] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser(services, uid, falsyNan)),
        Promise.resolve(isExclusiveAppServiceUser(services, uid, 'bridge')),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, falsyNan)),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, 'bridge')),
      ]);
      expect(uNan?.id).toBe('bridge');
      expect(uBridge).toBeNull();
      expect(aNan?.id).toBe('bridge');
      expect(aBridge).toBeNull();
    });
  }
});

describe('race senary appservice first exclusive wins under race after #286', () => {
  for (let i = 0; i < 10; i++) {
    it(`[first,second] same regex → first ∥ exclude first → second flood-${i}`, async () => {
      const first = registration('first', {
        users: [{ exclusive: true, regex: `^@_shared_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_shared_.*:${AS_ESC}$` }],
      });
      const second = registration('second', {
        users: [{ exclusive: true, regex: `^@_shared_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_shared_.*:${AS_ESC}$` }],
      });
      const services = [first, second];
      const uid = `@_shared_bot_${i}:${AS_SERVER}`;
      const alias = `#_shared_room_${i}:${AS_SERVER}`;

      const [uFirst, uExcl, aFirst, aExcl] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser(services, uid)),
        Promise.resolve(isExclusiveAppServiceUser(services, uid, 'first')),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias)),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, 'first')),
      ]);
      expect(uFirst?.id).toBe('first');
      expect(uExcl?.id).toBe('second');
      expect(aFirst?.id).toBe('first');
      expect(aExcl?.id).toBe('second');
    });
  }
});

describe('race senary appservice cross-axis sender+state_key multi-AS after #286', () => {
  for (let i = 0; i < 10; i++) {
    it(`bridge sender + soft state_key → ['bridge','soft'] flood-${i}`, async () => {
      const bridge = registration('bridge', {
        users: [{ exclusive: false, regex: `^@_bridge_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [],
      });
      const soft = registration('soft', {
        users: [{ exclusive: false, regex: `^@_soft_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [],
      });
      const services = [bridge, soft];

      const [both, senderOnly, skOnly, neither] = await Promise.all([
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@_bridge_bot_${i}:${AS_SERVER}`,
            state_key: `@_soft_ghost_${i}:${AS_SERVER}`,
            type: 'm.room.member',
          })
        ),
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@_bridge_bot_${i}:${AS_SERVER}`,
            state_key: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.member',
          })
        ),
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: `@_soft_ghost_${i}:${AS_SERVER}`,
            type: 'm.room.member',
          })
        ),
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: `@bob_${i}:${AS_SERVER}`,
            type: 'm.room.member',
          })
        ),
      ]);
      expect(both.map((a) => a.id)).toEqual(['bridge', 'soft']);
      expect(senderOnly.map((a) => a.id)).toEqual(['bridge']);
      expect(skOnly.map((a) => a.id)).toEqual(['soft']);
      expect(neither).toEqual([]);
    });
  }
});

describe('race senary appservice protocols whitespace∥empty list/ByToken after #286', () => {
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

  function createListDb(rows: Record<string, unknown>[]) {
    return {
      prepare(_sql: string) {
        return {
          bind(..._args: unknown[]) {
            return this;
          },
          async all<T>() {
            return { results: rows as T[] };
          },
        };
      },
    } as unknown as D1Database;
  }

  for (let i = 0; i < 8; i++) {
    it(`protocols ' ' throw ∥ ''→[] ∥ null→[] ByToken∥list flood-${i}`, async () => {
      const tokWs = `tok-ws-${i}`;
      const tokEmpty = `tok-empty-${i}`;
      const tokNull = `tok-null-${i}`;
      const wsRow = {
        id: `ws_${i}`,
        url: 'https://ws.example.com',
        as_token: tokWs,
        hs_token: 'hs',
        sender_localpart: 'bot',
        rate_limited: 0,
        protocols: ' ',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      };
      const emptyRow = {
        id: `empty_${i}`,
        url: 'https://empty.example.com',
        as_token: tokEmpty,
        hs_token: 'hs',
        sender_localpart: 'bot',
        rate_limited: 0,
        protocols: '',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      };
      const nullRow = {
        id: `null_${i}`,
        url: 'https://null.example.com',
        as_token: tokNull,
        hs_token: 'hs',
        sender_localpart: 'bot',
        rate_limited: 0,
        protocols: null,
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      };

      const [byWs, byEmpty, byNull, listWs, listEmpty, listNull] = await Promise.all([
        Promise.resolve()
          .then(() => getAppServiceByToken(createAsDb(new Map([[tokWs, wsRow]])), tokWs))
          .then((v) => ({ ok: true as const, v }))
          .catch((e) => ({ ok: false as const, err: e })),
        getAppServiceByToken(createAsDb(new Map([[tokEmpty, emptyRow]])), tokEmpty),
        getAppServiceByToken(createAsDb(new Map([[tokNull, nullRow]])), tokNull),
        Promise.resolve()
          .then(() => getAppServices(createListDb([wsRow])))
          .then((v) => ({ ok: true as const, v }))
          .catch((e) => ({ ok: false as const, err: e })),
        getAppServices(createListDb([emptyRow])),
        getAppServices(createListDb([nullRow])),
      ]);

      expect(byWs.ok).toBe(false);
      expect(byEmpty).toMatchObject({ id: `empty_${i}`, protocols: [] });
      expect(byNull).toMatchObject({ id: `null_${i}`, protocols: [] });
      expect(listWs.ok).toBe(false);
      expect(listEmpty[0]).toMatchObject({ id: `empty_${i}`, protocols: [] });
      expect(listNull[0]).toMatchObject({ id: `null_${i}`, protocols: [] });
    });
  }
});

describe('race senary appservice retry_count UPDATE throw after #286', () => {
  const NOW = 1_700_000_200_000;

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

  function createTxnDb(opts: { throwOnRetry?: boolean; startRowId?: number } = {}) {
    const inserts: Array<{ appservice_id: string; events: string; created_at: number }> = [];
    const updates: Array<{ kind: 'sent' | 'retry'; args: unknown[] }> = [];
    let nextRowId = opts.startRowId ?? 100;

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
                  if (opts.throwOnRetry) {
                    throw new Error('retry_count update failed');
                  }
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
    it(`500 + retry throw rejects ∥ sibling 200 sent_at ok flood-${i}`, async () => {
      const failDb = createTxnDb({ throwOnRetry: true });
      const okDb = createTxnDb();
      // Distinct URLs so fetch mock is race-safe under Promise.all
      const failAs = registration(
        'fail',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://fail.example.com' }
      );
      const okAs = registration(
        'ok',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok.example.com' }
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (String(url).includes('fail.example.com')) {
            return new Response('boom', { status: 500 });
          }
          return new Response('{}', { status: 200 });
        })
      );

      const [failed, ok] = await Promise.all([
        Promise.resolve()
          .then(() =>
            sendAppServiceTransaction(failDb, failAs, [{ type: 'm.room.message', n: i }])
          )
          .then((v) => ({ ok: true as const, v }))
          .catch((e) => ({ ok: false as const, err: e })),
        sendAppServiceTransaction(okDb, okAs, [{ type: 'm.room.message', n: i }]),
      ]);

      // retry_count UPDATE is outside try — throw propagates (unlike sent_at)
      expect(failed.ok).toBe(false);
      expect(ok).toBe(true);
      expect(failDb.updates.some((u) => u.kind === 'sent')).toBe(false);
      expect(okDb.updates).toEqual([{ kind: 'sent', args: [NOW, 100] }]);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`last_row_id 0 → …/transactions/0 under parallel flood-${i}`, async () => {
      const db = createTxnDb({ startRowId: 0 });
      const bridge = registration('bridge', { users: [], rooms: [], aliases: [] });
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response('{}', { status: 200 })
      );

      const ok = await sendAppServiceTransaction(db, bridge, [
        { type: 'm.room.message', n: i },
      ]);
      expect(ok).toBe(true);
      const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toBe(
        'https://bridge.example.com/_matrix/app/v1/transactions/0'
      );
      expect(db.updates).toEqual([{ kind: 'sent', args: [NOW, 0] }]);
    });
  }
});

// ===========================================================================
// Senary wave-3 — residual edges after #286 quinary tip
// ===========================================================================

describe('race senary appservice rate_limited -1/99 after #286', () => {
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

  function createListDb(rows: Record<string, unknown>[]) {
    return {
      prepare(_sql: string) {
        return {
          bind(..._args: unknown[]) {
            return this;
          },
          async all<T>() {
            return { results: rows as T[] };
          },
        };
      },
    } as unknown as D1Database;
  }

  for (let i = 0; i < 8; i++) {
    it(`rate_limited -1∥99 → false ∥ 1 → true ByToken∥list flood-${i}`, async () => {
      const mk = (id: string, rate: number, tok: string) => ({
        id,
        url: `https://${id}.example.com`,
        as_token: tok,
        hs_token: 'hs',
        sender_localpart: 'bot',
        rate_limited: rate,
        protocols: null,
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const tokNeg = `tok-neg-${i}`;
      const tokBig = `tok-big-${i}`;
      const tokOn = `tok-on-${i}`;
      const neg = mk(`neg_${i}`, -1, tokNeg);
      const big = mk(`big_${i}`, 99, tokBig);
      const on = mk(`on_${i}`, 1, tokOn);
      const db = createAsDb(
        new Map([
          [tokNeg, neg],
          [tokBig, big],
          [tokOn, on],
        ])
      );

      const [byNeg, byBig, byOn, list] = await Promise.all([
        getAppServiceByToken(db, tokNeg),
        getAppServiceByToken(db, tokBig),
        getAppServiceByToken(db, tokOn),
        getAppServices(createListDb([neg, big, on])),
      ]);
      expect(byNeg).toMatchObject({ rate_limited: false });
      expect(byBig).toMatchObject({ rate_limited: false });
      expect(byOn).toMatchObject({ rate_limited: true });
      expect(list.map((a) => a.rate_limited)).toEqual([false, false, true]);
    });
  }
});

describe('race senary appservice state_key "0" truthy after #286', () => {
  for (let i = 0; i < 8; i++) {
    it(`state_key '0' hits ^0$ ∥ '' skips under race flood-${i}`, async () => {
      const zero = registration('zero', {
        users: [{ exclusive: false, regex: '^0$' }],
        rooms: [],
        aliases: [],
      });

      const [hit, emptySkip, miss] = await Promise.all([
        Promise.resolve(
          getInterestedAppServices([zero], {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: '0',
            type: 'm.room.member',
          })
        ),
        Promise.resolve(
          getInterestedAppServices([zero], {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: '',
            type: 'm.room.member',
          })
        ),
        Promise.resolve(
          getInterestedAppServices([zero], {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: '1',
            type: 'm.room.member',
          })
        ),
      ]);
      expect(hit.map((a) => a.id)).toEqual(['zero']);
      expect(emptySkip).toEqual([]);
      expect(miss).toEqual([]);
    });
  }
});

describe('race senary appservice bad user-ns blocks room interest after #286', () => {
  for (let i = 0; i < 8; i++) {
    it(`same AS bad user-ns throw ∥ room-only sibling hit flood-${i}`, async () => {
      const poisoned = registration('poisoned', {
        users: [{ exclusive: false, regex: '[' }],
        rooms: [{ exclusive: false, regex: `^!bridge_.*:${AS_ESC}$` }],
        aliases: [],
      });
      const roomOnly = registration('roomy', {
        users: [],
        rooms: [{ exclusive: false, regex: `^!bridge_.*:${AS_ESC}$` }],
        aliases: [],
      });

      const [poison, ok] = await Promise.all([
        Promise.resolve()
          .then(() =>
            getInterestedAppServices([poisoned], {
              room_id: `!bridge_room_${i}:${AS_SERVER}`,
              sender: `@alice_${i}:${AS_SERVER}`,
              type: 'm.room.message',
            })
          )
          .then((v) => ({ ok: true as const, v }))
          .catch((e) => ({ ok: false as const, err: e })),
        Promise.resolve(
          getInterestedAppServices([roomOnly], {
            room_id: `!bridge_room_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
      ]);
      // User-ns loop throws before room loop on same AS
      expect(poison.ok).toBe(false);
      expect(ok.map((a) => a.id)).toEqual(['roomy']);
    });
  }
});

describe('race senary appservice multi-event txn body + path-prefix after #286', () => {
  const NOW = 1_700_000_300_000;

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

  function createTxnDb(startRowId = 200) {
    const inserts: Array<{ appservice_id: string; events: string; created_at: number }> = [];
    const updates: Array<{ kind: 'sent' | 'retry'; args: unknown[] }> = [];
    let nextRowId = startRowId;
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

  for (let i = 0; i < 8; i++) {
    it(`2-event body bind ∥ 1-event sibling under race flood-${i}`, async () => {
      const dualDb = createTxnDb(200);
      const singleDb = createTxnDb(300);
      const dualAs = registration(
        'dual',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://dual.example.com' }
      );
      const singleAs = registration(
        'single',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://single.example.com' }
      );
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));

      const dualEvents = [
        { type: 'm.room.message', n: i },
        { type: 'm.reaction', n: i },
      ];
      const singleEvents = [{ type: 'm.room.message', n: i }];

      const [dualOk, singleOk] = await Promise.all([
        sendAppServiceTransaction(dualDb, dualAs, dualEvents),
        sendAppServiceTransaction(singleDb, singleAs, singleEvents),
      ]);
      expect(dualOk).toBe(true);
      expect(singleOk).toBe(true);

      const dualCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes('dual.example.com')
      );
      const singleCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes('single.example.com')
      );
      expect(dualCall).toBeTruthy();
      expect(singleCall).toBeTruthy();
      const dualBody = JSON.parse((dualCall![1] as RequestInit).body as string) as {
        events: unknown[];
      };
      const singleBody = JSON.parse((singleCall![1] as RequestInit).body as string) as {
        events: unknown[];
      };
      expect(dualBody.events).toHaveLength(2);
      expect(singleBody.events).toHaveLength(1);
      expect(dualCall![0]).toBe(
        'https://dual.example.com/_matrix/app/v1/transactions/200'
      );
      expect(singleCall![0]).toBe(
        'https://single.example.com/_matrix/app/v1/transactions/300'
      );
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`url path-prefix concat ∥ bare-host sibling flood-${i}`, async () => {
      const prefixDb = createTxnDb(400);
      const bareDb = createTxnDb(500);
      const prefixAs = registration(
        'pfx',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://as.example.com/prefix' }
      );
      const bareAs = registration(
        'bare',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://bare.example.com' }
      );
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));

      const [a, b] = await Promise.all([
        sendAppServiceTransaction(prefixDb, prefixAs, [{ type: 'm.room.message', n: i }]),
        sendAppServiceTransaction(bareDb, bareAs, [{ type: 'm.room.message', n: i }]),
      ]);
      expect(a).toBe(true);
      expect(b).toBe(true);
      const pfxUrl = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes('/prefix/')
      )![0] as string;
      const bareUrl = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes('bare.example.com')
      )![0] as string;
      expect(pfxUrl).toBe(
        'https://as.example.com/prefix/_matrix/app/v1/transactions/400'
      );
      expect(bareUrl).toBe(
        'https://bare.example.com/_matrix/app/v1/transactions/500'
      );
    });
  }
});

describe('race senary auth restrictive ns + sender outside after #286', () => {
  for (let i = 0; i < 8; i++) {
    it(`no user_id → @otherbot ok ∥ user_id=@otherbot forbid flood-${i}`, async () => {
      const tok = `as_restrict_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            tok,
            asRow({
              as_token: tok,
              sender_localpart: 'otherbot',
              namespaces: JSON.stringify({
                users: [
                  {
                    exclusive: true,
                    regex: `@_bridge_.*:${AUTH_SERVER.replace(/\./g, '\\.')}`,
                  },
                ],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
        ]),
      });

      const senderCtx = makeAuthCtx({
        db,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const forbidUid = `@otherbot:${AUTH_SERVER}`;
      const forbidCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(forbidUid)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const allowUid = `@_bridge_ghost_${i}:${AUTH_SERVER}`;
      const allowCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(allowUid)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });

      const [senderRes, forbidRes, allowRes] = await Promise.all([
        requireAuth()(senderCtx, vi.fn(async () => 'sender')),
        requireAuth()(forbidCtx, vi.fn()),
        requireAuth()(allowCtx, vi.fn(async () => 'allow')),
      ]);

      // Namespace gate only when user_id is set — sender fallback skips it
      expect(senderRes).toBe('sender');
      expect(senderCtx.get('userId')).toBe(`@otherbot:${AUTH_SERVER}`);
      expect(await jsonBody(forbidRes as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'User not in application service namespace',
        status: 403,
      });
      expect(allowRes).toBe('allow');
      expect(allowCtx.get('userId')).toBe(allowUid);
    });
  }
});

describe('race senary auth users:[null,good] .some OR after #286', () => {
  for (let i = 0; i < 8; i++) {
    it(`[null, good] allow ∥ [null] forbid under race flood-${i}`, async () => {
      const esc = AUTH_SERVER.replace(/\./g, '\\.');
      const tokOr = `as_null_or_${i}`;
      const tokNull = `as_null_only_${i}`;
      const dbOr = createAuthDb({
        appservices: new Map([
          [
            tokOr,
            asRow({
              as_token: tokOr,
              sender_localpart: 'nullor',
              namespaces: JSON.stringify({
                users: [
                  null,
                  { exclusive: true, regex: `@null_or_.*:${esc}` },
                ],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
        ]),
      });
      const dbNull = createAuthDb({
        appservices: new Map([
          [
            tokNull,
            asRow({
              as_token: tokNull,
              sender_localpart: 'nullonly',
              namespaces: JSON.stringify({
                users: [null],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
        ]),
      });

      const uid = `@null_or_${i}:${AUTH_SERVER}`;
      const [orRes, nullRes] = await Promise.all([
        requireAuth()(
          makeAuthCtx({
            db: dbOr,
            url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(uid)}`,
            headers: { Authorization: `Bearer ${tokOr}` },
          }),
          vi.fn(async () => 'allowed')
        ),
        requireAuth()(
          makeAuthCtx({
            db: dbNull,
            url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(uid)}`,
            headers: { Authorization: `Bearer ${tokNull}` },
          }),
          vi.fn()
        ),
      ]);

      // null element → throw on ns.regex → false; good entry allows
      expect(orRes).toBe('allowed');
      expect(await jsonBody(nullRes as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'User not in application service namespace',
        status: 403,
      });
    });
  }
});
