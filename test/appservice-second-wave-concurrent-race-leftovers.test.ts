/**
 * TOKENMAXX HEAVY leftovers after tip #266 — second-wave residual
 * *appservice API + service* concurrent-race / soft niches not covered by
 * appservice-api-residual-concurrent-race leftovers (#266) or #257 txn contract.
 *
 * Distinct from #266 residual:
 *   query-only access_token; token spacing; ns not enforced on routes;
 *   room-id-as-alias; missing ping; throwOnAlias three-way; Bearer case;
 *   success body key-bind.
 *
 * Second-wave deepen after #266 tip:
 *   inbound `/transactions/:id` 404 ∥ `/users` 200 under race;
 *   thirdparty Matrix query fields ignored under concurrent hit∥auth-fail;
 *   sendAppServiceTransaction response.ok band (201/299 → sent; 300/399 → retry);
 *   concurrent dual txn distinct last_row_id + hs_token Authorization bind;
 *   getAppServices throws on corrupt namespaces JSON (no try/catch).
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 * Reversible by reverting this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import type { AppServiceRegistration } from '../src/services/appservice';
import {
  getAppServices,
  sendAppServiceTransaction,
} from '../src/services/appservice';

const { getAppServiceByToken, getUserById } = vi.hoisted(() => ({
  getAppServiceByToken: vi.fn(),
  getUserById: vi.fn(),
}));

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
const AS_TOKEN = 'as-token-bridge-second-wave';
const HS_TOKEN = 'hs-token-bridge-second-wave';
const USER = `@_bridge_alice:${SERVER}`;
const USER_ENC = encodeURIComponent(USER);
const ALIAS = `#_bridge_room:${SERVER}`;
const ALIAS_ENC = encodeURIComponent(ALIAS);
const ROOM_ID = `!room:${SERVER}`;

const BRIDGE_REG: AppServiceRegistration = {
  id: 'bridge',
  url: 'https://bridge.example.com',
  as_token: AS_TOKEN,
  hs_token: HS_TOKEN,
  sender_localpart: 'bridge_bot',
  rate_limited: false,
  protocols: ['irc', 'slack'],
  namespaces: {
    users: [{ exclusive: true, regex: `^@_bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
    rooms: [{ exclusive: false, regex: `^!bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
    aliases: [{ exclusive: true, regex: `^#_bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
  },
};

type AliasRow = { alias: string; room_id: string };
type SqlCall = { sql: string; args: unknown[] };

function createAliasDb(
  opts: {
    aliases?: AliasRow[];
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

function registration(
  id: string,
  namespaces: AppServiceRegistration['namespaces'],
  extras: Partial<AppServiceRegistration> = {}
): AppServiceRegistration {
  return {
    id,
    url: extras.url ?? `https://${id}.example.com`,
    as_token: extras.as_token ?? `as-${id}`,
    hs_token: extras.hs_token ?? `hs-${id}`,
    sender_localpart: extras.sender_localpart ?? id,
    rate_limited: extras.rate_limited ?? false,
    protocols: extras.protocols ?? [],
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
// Second-wave: inbound transactions path 404 ∥ users 200 under race
// (#266 claimed missing ping; routes.test single-shot txn 404 only)
// ---------------------------------------------------------------------------

describe('race second-wave appservice inbound txn 404 after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`transactions PUT/GET 404∥users 200 flood-${i}`, async () => {
      getAppServiceByToken.mockResolvedValue(BRIDGE_REG);
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const results = await Promise.all([
        request(`/_matrix/app/v1/transactions/${i}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${AS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ events: [] }),
        }),
        request(`/_matrix/app/v1/transactions/${i}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN)),
      ]);
      expect(results[0].status).toBe(404);
      expect(results[1].status).toBe(404);
      expect(results[2].status).toBe(200);
      expect(results[2].body).toEqual({});
      expect(results[3].status).toBe(200);
      // HS→AS txn endpoint is not mounted on the AS→HS app router
      expect(getAppServiceByToken).toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Second-wave: thirdparty Matrix query fields ignored under concurrent race
// ---------------------------------------------------------------------------

describe('race second-wave appservice thirdparty query fields after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`userid/fields/searchFields ignored∥auth-fail flood-${i}`, async () => {
      getAppServiceByToken.mockImplementation(async (_db: unknown, tok: string) =>
        tok === AS_TOKEN ? BRIDGE_REG : null
      );
      const q =
        `userid=${encodeURIComponent(USER)}&fields=nick&searchFields=%23chan&protocol=irc`;
      const results = await Promise.all([
        request(`/_matrix/app/v1/thirdparty/user/irc?${q}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/location/irc?${q}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/protocol/irc?${q}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/user/irc?${q}`, bearer('wrong-token')),
        request(`/_matrix/app/v1/thirdparty/user/irc?${q}`),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[0].body).toEqual([]);
      expect(results[1].status).toBe(200);
      expect(results[1].body).toEqual([]);
      expect(results[2].status).toBe(200);
      expect(results[2].body).toMatchObject({
        user_fields: [],
        location_fields: [],
        field_types: {},
        instances: [],
      });
      expect(results[3].body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
      expect(results[4].body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
    });
  }
});

// ---------------------------------------------------------------------------
// Second-wave: sendAppServiceTransaction response.ok band edges
// (#257/#62: 200, 204, 500, throw — not 201/299/300/399)
// ---------------------------------------------------------------------------

describe('appservice second-wave txn ok-boundary after #266', () => {
  const NOW = 1_700_100_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createTxnDb(startRowId = 100) {
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

  const okBand = [201, 202, 204, 299];
  const notOkBand = [300, 301, 399, 400];

  for (let i = 0; i < okBand.length; i++) {
    it(`HTTP ${okBand[i]} is response.ok → sent_at flood-${i}`, async () => {
      const db = createTxnDb(200 + i);
      const bridge = registration('bridge', { users: [], rooms: [], aliases: [] }, {
        hs_token: HS_TOKEN,
      });
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(okBand[i] === 204 ? null : '{}', { status: okBand[i] })
      );
      const ok = await sendAppServiceTransaction(db, bridge, [{ type: 'm.room.message' }]);
      expect(ok).toBe(true);
      expect(db.updates).toEqual([{ kind: 'sent', args: [NOW, 200 + i] }]);
    });
  }

  for (let i = 0; i < notOkBand.length; i++) {
    it(`HTTP ${notOkBand[i]} not ok → retry, no sent_at flood-${i}`, async () => {
      const db = createTxnDb(300 + i);
      const bridge = registration('bridge', { users: [], rooms: [], aliases: [] }, {
        hs_token: HS_TOKEN,
      });
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response('nope', { status: notOkBand[i] })
      );
      const ok = await sendAppServiceTransaction(db, bridge, [{ type: 'm.room.member' }]);
      expect(ok).toBe(false);
      expect(db.updates).toEqual([{ kind: 'retry', args: [300 + i] }]);
      expect(db.updates.every((u) => u.kind !== 'sent')).toBe(true);
    });
  }

  it('concurrent dual txn distinct last_row_id + hs_token Authorization bind', async () => {
    const db = createTxnDb(50);
    const bridge = registration('bridge', { users: [], rooms: [], aliases: [] }, {
      url: 'https://bridge.example.com',
      hs_token: HS_TOKEN,
    });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));

    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db, bridge, [{ type: 'm.room.message', room_id: '!a:example.com' }]),
      sendAppServiceTransaction(db, bridge, [{ type: 'm.room.message', room_id: '!b:example.com' }]),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.inserts).toHaveLength(2);
    expect(db.updates.filter((u) => u.kind === 'sent')).toHaveLength(2);

    const urls = fetchMock.mock.calls.map((c) => c[0] as string).sort();
    expect(urls).toEqual([
      'https://bridge.example.com/_matrix/app/v1/transactions/50',
      'https://bridge.example.com/_matrix/app/v1/transactions/51',
    ]);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as { headers: Record<string, string>; method: string; body: string };
      expect(init.method).toBe('PUT');
      expect(init.headers.Authorization).toBe(`Bearer ${HS_TOKEN}`);
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body)).toHaveProperty('events');
    }
  });
});

// ---------------------------------------------------------------------------
// Second-wave: getAppServices throws on corrupt namespaces (no try/catch)
// (#257/#266 corrupt path is auth swallow via getAppServiceByToken)
// ---------------------------------------------------------------------------

describe('appservice second-wave getAppServices parse soft after #266', () => {
  it('corrupt namespaces JSON causes getAppServices to reject', async () => {
    const db = {
      prepare(_sql: string) {
        return {
          bind(..._args: unknown[]) {
            return this;
          },
          async all() {
            return {
              results: [
                {
                  id: 'bad',
                  url: 'https://bad.example.com',
                  as_token: 'as-bad',
                  hs_token: 'hs-bad',
                  sender_localpart: 'bad',
                  rate_limited: 0,
                  protocols: null,
                  namespaces: '{not-json',
                },
              ],
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(getAppServices(db)).rejects.toThrow();
  });

  it('corrupt protocols JSON also rejects (list mapper has no try/catch)', async () => {
    const db = {
      prepare(_sql: string) {
        return {
          bind(..._args: unknown[]) {
            return this;
          },
          async all() {
            return {
              results: [
                {
                  id: 'badp',
                  url: 'https://badp.example.com',
                  as_token: 'as-badp',
                  hs_token: 'hs-badp',
                  sender_localpart: 'badp',
                  rate_limited: 1,
                  protocols: '[oops',
                  namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
                },
              ],
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(getAppServices(db)).rejects.toThrow();
  });

  it('valid row still maps under parallel with empty sibling list', async () => {
    const good = {
      id: 'ok',
      url: 'https://ok.example.com',
      as_token: 'as-ok',
      hs_token: 'hs-ok',
      sender_localpart: 'ok',
      rate_limited: 1,
      protocols: JSON.stringify(['irc']),
      namespaces: JSON.stringify({
        users: [{ exclusive: false, regex: '@_ok_.*:example\\.com' }],
        rooms: [],
        aliases: [],
      }),
    };
    const emptyDb = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: [] };
          },
        };
      },
    } as unknown as D1Database;
    const goodDb = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: [good] };
          },
        };
      },
    } as unknown as D1Database;

    const [empty, mapped] = await Promise.all([getAppServices(emptyDb), getAppServices(goodDb)]);
    expect(empty).toEqual([]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      id: 'ok',
      rate_limited: true,
      protocols: ['irc'],
    });
    expect(mapped[0].namespaces.users[0].regex).toBe('@_ok_.*:example\\.com');
  });
});
