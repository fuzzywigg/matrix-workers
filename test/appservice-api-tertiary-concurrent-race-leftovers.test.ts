/**
 * TOKENMAXX HEAVY leftovers after #266 — tertiary *appservice API + service*
 * concurrent-race / error-path niches not covered by residual (#266) or
 * #217/#236/#154 concurrent/route soft floods.
 *
 * Distinct from #266 residual:
 *   query-only token; leading/trailing space; ns not enforced on HS routes;
 *   room-id-as-alias; missing ping; throwOnAlias three-way; Bearer case;
 *   success body key-bind.
 *
 * Tertiary deepen after #266 tip:
 *   alias row room_id null∥'' still 200 {}; MXID path on /rooms → 404;
 *   odd protocol stubs (0/-/%20) ∥ `.` 404; response.ok 201/299 vs 300/301;
 *   INSERT throw before fetch; excludeAsId '' falsy; state_key-only interest.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 * Reversible by deleting this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import type { AppServiceRegistration } from '../src/services/appservice';
import {
  getInterestedAppServices,
  isExclusiveAppServiceAlias,
  isExclusiveAppServiceUser,
  sendAppServiceTransaction,
} from '../src/services/appservice';

const getAppServiceByToken = vi.fn();
const getUserById = vi.fn();

vi.mock('../src/services/appservice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/appservice')>();
  return {
    ...actual,
    getAppServiceByToken: (...args: unknown[]) => getAppServiceByToken(...args),
  };
});

vi.mock('../src/services/database', () => ({
  getUserById: (...args: unknown[]) => getUserById(...args),
}));

import appservice from '../src/api/appservice';

const SERVER = 'example.com';
const AS_TOKEN = 'as-token-bridge-tertiary';
const USER = `@_bridge_alice:${SERVER}`;
const USER_ENC = encodeURIComponent(USER);
const ALIAS = `#_bridge_room:${SERVER}`;
const ALIAS_ENC = encodeURIComponent(ALIAS);
const ROOM_ID = `!room:${SERVER}`;
const MXID_AS_ALIAS = `@notanalias:${SERVER}`;
const MXID_AS_ALIAS_ENC = encodeURIComponent(MXID_AS_ALIAS);

const BRIDGE_REG: AppServiceRegistration = {
  id: 'bridge',
  url: 'https://bridge.example.com',
  as_token: AS_TOKEN,
  hs_token: 'hs-token-bridge',
  sender_localpart: 'bridge_bot',
  rate_limited: false,
  protocols: ['irc', 'slack'],
  namespaces: {
    users: [{ exclusive: true, regex: `^@_bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
    rooms: [{ exclusive: false, regex: `^!bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
    aliases: [{ exclusive: true, regex: `^#_bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
  },
};

type AliasRow = { alias: string; room_id: string | null };
type SqlCall = { sql: string; args: unknown[] };

function createAliasDb(
  opts: {
    aliases?: AliasRow[];
    throwOnAlias?: boolean;
  } = {}
) {
  const aliases = [...(opts.aliases ?? [])];
  const selects: SqlCall[] = [];

  const db = {
    aliases,
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (opts.throwOnAlias && sql.includes('FROM room_aliases')) {
                throw new Error('alias query failed');
              }
              if (sql.includes('FROM room_aliases') && sql.includes('SELECT room_id')) {
                const alias = args[0] as string;
                const row = aliases.find((a) => a.alias === alias);
                return (row ? { room_id: row.room_id } : null) as T;
              }
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 140)}`);
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              return { success: true, meta: { changes: 0, last_row_id: 0 } };
            },
          };
        },
      };
    },
  };

  return db as unknown as D1Database & { aliases: AliasRow[]; selects: SqlCall[] };
}

function makeEnv(opts: { db?: ReturnType<typeof createAliasDb> } = {}): Env {
  return {
    SERVER_NAME: SERVER,
    DB: opts.db ?? createAliasDb(),
  } as unknown as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = makeEnv()
): Promise<{ status: number; body: unknown; res: Response }> {
  const res = await appservice.request(`http://localhost${path}`, init, env);
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, res };
}

function bearer(token: string): RequestInit {
  return {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  };
}

function authOk() {
  getAppServiceByToken.mockResolvedValue(BRIDGE_REG);
}

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
  getAppServiceByToken.mockReset();
  getUserById.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tertiary: alias row hit with null/empty room_id still returns {}
// ---------------------------------------------------------------------------

describe('race tertiary appservice alias null/empty room_id after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`alias row room_id null∥'' → 200 {} ∥ miss 404 flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const nullAlias = `#null_${i}:${SERVER}`;
      const emptyAlias = `#empty_${i}:${SERVER}`;
      const db = createAliasDb({
        aliases: [
          { alias: nullAlias, room_id: null },
          { alias: emptyAlias, room_id: '' },
          { alias: ALIAS, room_id: ROOM_ID },
        ],
      });
      const env = makeEnv({ db });
      const results = await Promise.all([
        request(`/_matrix/app/v1/rooms/${encodeURIComponent(nullAlias)}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${encodeURIComponent(emptyAlias)}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${encodeURIComponent(`#missing_${i}:${SERVER}`)}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env),
      ]);
      // Handler only checks `if (!result)` — null/'' room_id rows are truthy hits
      expect(results[0].status).toBe(200);
      expect(results[0].body).toEqual({});
      expect(results[1].status).toBe(200);
      expect(results[1].body).toEqual({});
      expect(results[2].status).toBe(404);
      expect(results[2].body).toMatchObject({ errcode: 'M_NOT_FOUND' });
      expect(results[3].status).toBe(200);
      expect(results[4].status).toBe(200);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`null room_id hit ∥ throwOnAlias ∥ tp ok three-way flood-${i}`, async () => {
      authOk();
      const okDb = createAliasDb({
        aliases: [{ alias: ALIAS, room_id: null }],
      });
      const throwEnv = makeEnv({ db: createAliasDb({ throwOnAlias: true }) });
      const okEnv = makeEnv({ db: okDb });
      const results = await Promise.all([
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), okEnv),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), throwEnv),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN), okEnv),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[0].body).toEqual({});
      expect(results[1].status).toBeGreaterThanOrEqual(500);
      expect(results[2].status).toBe(200);
    });
  }
});

// ---------------------------------------------------------------------------
// Tertiary: MXID-shaped path on /rooms/:roomAlias (inverse of room-id-as-alias)
// ---------------------------------------------------------------------------

describe('race tertiary appservice mxid-on-rooms path after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`mxid path on rooms → 404 ∥ real alias hit flood-${i}`, async () => {
      authOk();
      getUserById.mockImplementation(async (_db: unknown, id: string) =>
        id === USER ? ({ user_id: USER } as never) : null
      );
      const db = createAliasDb({
        aliases: [{ alias: ALIAS, room_id: ROOM_ID }],
      });
      const env = makeEnv({ db });
      const results = await Promise.all([
        request(`/_matrix/app/v1/rooms/${MXID_AS_ALIAS_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/users/${MXID_AS_ALIAS_ENC}`, bearer(AS_TOKEN), env),
      ]);
      expect(results[0].status).toBe(404);
      expect(results[0].body).toMatchObject({ errcode: 'M_NOT_FOUND' });
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(200);
      // MXID on /users still looks up by user id — not found unless mocked
      expect(results[3].status).toBe(404);
      expect(db.selects.some((s) => s.args[0] === MXID_AS_ALIAS)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Tertiary: odd protocol stub paths under race (`.` 404s in Hono; use 0/-/%20)
// ---------------------------------------------------------------------------

describe('race tertiary appservice odd protocol stubs after #266', () => {
  const oddProtocols = ['0', '-', '_', '%20', 'x.y'];

  for (let i = 0; i < 12; i++) {
    it(`protocol odd∥irc stub coherency flood-${i}`, async () => {
      authOk();
      const proto = oddProtocols[i % oddProtocols.length];
      const results = await Promise.all([
        request(`/_matrix/app/v1/thirdparty/protocol/${proto}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/user/${proto}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/location/${proto}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/user/irc`, bearer(AS_TOKEN)),
      ]);
      // Protocol param is ignored by stubs — odd segments still return empty shape
      expect(results[0].status).toBe(200);
      expect(results[0].body).toEqual({
        user_fields: [],
        location_fields: [],
        field_types: {},
        instances: [],
      });
      expect(results[1].status).toBe(200);
      expect(results[1].body).toEqual([]);
      expect(results[2].status).toBe(200);
      expect(results[2].body).toEqual([]);
      expect(results[3].status).toBe(200);
      expect(results[3].body).toEqual(results[0].body);
      expect(results[4].body).toEqual([]);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`odd protocol∥missing token isolation flood-${i}`, async () => {
      getAppServiceByToken.mockImplementation(async (_db: unknown, tok: string) =>
        tok === AS_TOKEN ? BRIDGE_REG : null
      );
      const proto = oddProtocols[i % oddProtocols.length];
      const results = await Promise.all([
        request(`/_matrix/app/v1/thirdparty/protocol/${proto}`),
        request(`/_matrix/app/v1/thirdparty/user/${proto}`, {
          headers: { Authorization: 'Bearer ' },
        }),
        request(`/_matrix/app/v1/thirdparty/protocol/${proto}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/location/${proto}`, bearer('wrong')),
        // bare `.` path segments 404 before auth (Hono does not match)
        request(`/_matrix/app/v1/thirdparty/protocol/.`, bearer(AS_TOKEN)),
      ]);
      expect(results[0].status).toBe(401);
      expect(results[0].body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
      expect(results[1].status).toBe(401);
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(401);
      expect(results[3].body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
      expect(results[4].status).toBe(404);
    });
  }
});

// ---------------------------------------------------------------------------
// Tertiary: sendAppServiceTransaction response.ok status boundary
// ---------------------------------------------------------------------------

describe('race tertiary appservice txn response.ok boundary after #266', () => {
  const NOW = 1_700_000_100_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createTxnDb(opts: { throwOnInsert?: boolean } = {}) {
    const inserts: Array<{ appservice_id: string; events: string; created_at: number }> = [];
    const updates: Array<{ kind: 'sent' | 'retry'; args: unknown[] }> = [];
    let nextRowId = 40;

    const db = {
      inserts,
      updates,
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                if (sql.includes('INSERT INTO appservice_transactions')) {
                  if (opts.throwOnInsert) throw new Error('insert failed');
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
    it(`201∥299 → sent_at under parallel flood-${i}`, async () => {
      const dbA = createTxnDb();
      const dbB = createTxnDb();
      const bridge = registration('bridge', { users: [], rooms: [], aliases: [] });
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 201 }))
        .mockResolvedValueOnce(new Response('{}', { status: 299 }));

      const [okA, okB] = await Promise.all([
        sendAppServiceTransaction(dbA, bridge, [{ type: 'm.room.message', n: i }]),
        sendAppServiceTransaction(dbB, bridge, [{ type: 'm.room.member', n: i }]),
      ]);
      expect(okA).toBe(true);
      expect(okB).toBe(true);
      expect(dbA.updates).toEqual([{ kind: 'sent', args: [NOW, 40] }]);
      expect(dbB.updates).toEqual([{ kind: 'sent', args: [NOW, 40] }]);
      expect(dbA.updates.some((u) => u.kind === 'retry')).toBe(false);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`300∥301∥400 → retry_count no sent_at flood-${i}`, async () => {
      const statuses = [300, 301, 400];
      const status = statuses[i % statuses.length];
      const db = createTxnDb();
      const bridge = registration('bridge', { users: [], rooms: [], aliases: [] });
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response('nope', { status })
      );

      const ok = await sendAppServiceTransaction(db, bridge, [{ type: 'm.room.message' }]);
      expect(ok).toBe(false);
      expect(db.updates).toEqual([{ kind: 'retry', args: [40] }]);
      expect(db.updates.some((u) => u.kind === 'sent')).toBe(false);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`201 ok∥301 retry mixed outcome flood-${i}`, async () => {
      const dbOk = createTxnDb();
      const dbRetry = createTxnDb();
      const bridge = registration('bridge', { users: [], rooms: [], aliases: [] });
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status: 201 }))
        .mockResolvedValueOnce(new Response(null, { status: 301 }));

      const [ok, retry] = await Promise.all([
        sendAppServiceTransaction(dbOk, bridge, []),
        sendAppServiceTransaction(dbRetry, bridge, []),
      ]);
      expect(ok).toBe(true);
      expect(retry).toBe(false);
      expect(dbOk.updates.map((u) => u.kind)).toEqual(['sent']);
      expect(dbRetry.updates.map((u) => u.kind)).toEqual(['retry']);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`INSERT throw → no fetch∥sibling ok isolation flood-${i}`, async () => {
      const throwDb = createTxnDb({ throwOnInsert: true });
      const okDb = createTxnDb();
      const bridge = registration('bridge', { users: [], rooms: [], aliases: [] });
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response('{}', { status: 200 })
      );

      const [thrown, ok] = await Promise.allSettled([
        sendAppServiceTransaction(throwDb, bridge, [{ type: 'm.room.message' }]),
        sendAppServiceTransaction(okDb, bridge, [{ type: 'm.room.message' }]),
      ]);
      expect(thrown.status).toBe('rejected');
      expect(ok.status).toBe('fulfilled');
      expect(ok.status === 'fulfilled' && ok.value).toBe(true);
      // INSERT throw must skip fetch and never bump retry
      expect(throwDb.inserts.length).toBe(0);
      expect(throwDb.updates.length).toBe(0);
      expect(okDb.inserts.length).toBe(1);
      expect(okDb.updates.map((u) => u.kind)).toEqual(['sent']);
      // Only the sibling should have fetched
      expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Tertiary: falsy excludeAsId '' does not exclude
// ---------------------------------------------------------------------------

describe('race tertiary appservice excludeAsId empty-string after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`excludeAsId '' still matches exclusive user∥alias flood-${i}`, async () => {
      const bridge = registration('bridge', {
        users: [{ exclusive: true, regex: `^@_bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
      });
      const other = registration('other', {
        users: [{ exclusive: true, regex: `^@_other_.*:${SERVER.replace(/\./g, '\\.')}$` }],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_other_.*:${SERVER.replace(/\./g, '\\.')}$` }],
      });
      const services = [bridge, other];
      const uid = `@_bridge_u_${i}:${SERVER}`;
      const alias = `#_bridge_a_${i}:${SERVER}`;

      const [uEmpty, uBridge, uUndef, aEmpty, aBridge] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser(services, uid, '')),
        Promise.resolve(isExclusiveAppServiceUser(services, uid, 'bridge')),
        Promise.resolve(isExclusiveAppServiceUser(services, uid, undefined)),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, '')),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, 'bridge')),
      ]);
      // '' is falsy → `if (excludeAsId && ...)` never skips
      expect(uEmpty?.id).toBe('bridge');
      expect(uBridge).toBeNull();
      expect(uUndef?.id).toBe('bridge');
      expect(aEmpty?.id).toBe('bridge');
      expect(aBridge).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// Tertiary: state_key-only interest under Promise.all (sender miss)
// ---------------------------------------------------------------------------

describe('race tertiary appservice state_key-only interest after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`state_key hit∥sender miss∥room miss interest flood-${i}`, async () => {
      const bridge = registration('bridge', {
        users: [{ exclusive: false, regex: `^@_bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
        rooms: [{ exclusive: false, regex: `^!bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
        aliases: [{ exclusive: true, regex: `^#_bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
      });
      const aliasOnly = registration('aliasy', {
        users: [],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^@_bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
      });
      const services = [bridge, aliasOnly];

      const [skHit, senderMiss, roomHit, aliasNo] = await Promise.all([
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${SERVER}`,
            sender: `@alice_${i}:${SERVER}`,
            state_key: `@_bridge_target_${i}:${SERVER}`,
            type: 'm.room.member',
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
            sender: `@alice_${i}:${SERVER}`,
            type: 'm.room.message',
          })
        ),
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${SERVER}`,
            sender: `@alice_${i}:${SERVER}`,
            state_key: `@_bridge_target_${i}:${SERVER}`,
            type: 'm.room.member',
          }).filter((as) => as.id === 'aliasy')
        ),
      ]);
      expect(skHit.map((a) => a.id)).toEqual(['bridge']);
      expect(senderMiss).toEqual([]);
      expect(roomHit.map((a) => a.id)).toEqual(['bridge']);
      // alias ns never consulted for interest
      expect(aliasNo).toEqual([]);
    });
  }
});
