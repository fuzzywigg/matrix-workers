/**
 * TOKENMAXX HEAVY leftovers after #236 / tip after #253 — residual
 * *appservice API* concurrent-race / soft niches not covered by
 * appservice-api-concurrent-race leftovers (#217/#236) or route soft floods (#154).
 *
 * Distinct from #236: empty/whitespace Bearer; hs_token≠as_token; query ignore
 * *with* Bearer present; double-encode; unicode proto; alias mutate inject;
 * getUserById throw; auth call-count; Accept soft.
 *
 * Residual deepen after #253 tip:
 *   query-only access_token → M_MISSING_TOKEN; leading/trailing token space;
 *   AS namespace not enforced on HS query routes; room-id-shaped alias path;
 *   missing ping; throwOnAlias∥user∥thirdparty three-way; case-sensitive Bearer;
 *   success body key-bind under race.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import type { AppServiceRegistration } from '../src/services/appservice';

const getAppServiceByToken = vi.fn();
const getUserById = vi.fn();

vi.mock('../src/services/appservice', () => ({
  getAppServiceByToken: (...args: unknown[]) => getAppServiceByToken(...args),
}));

vi.mock('../src/services/database', () => ({
  getUserById: (...args: unknown[]) => getUserById(...args),
}));

import appservice from '../src/api/appservice';

const SERVER = 'example.com';
const AS_TOKEN = 'as-token-bridge-residual';
const USER = `@_bridge_alice:${SERVER}`;
const USER_ENC = encodeURIComponent(USER);
const ALIAS = `#_bridge_room:${SERVER}`;
const ALIAS_ENC = encodeURIComponent(ALIAS);
const OUT_NS_USER = `@alice:${SERVER}`;
const OUT_NS_USER_ENC = encodeURIComponent(OUT_NS_USER);
const OUT_NS_ALIAS = `#general:${SERVER}`;
const OUT_NS_ALIAS_ENC = encodeURIComponent(OUT_NS_ALIAS);
const ROOM_ID = `!room:${SERVER}`;
const ROOM_ID_ENC = encodeURIComponent(ROOM_ID);

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

type AliasRow = { alias: string; room_id: string };
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

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status);
}

beforeEach(() => {
  getAppServiceByToken.mockReset();
  getUserById.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Residual: query-only access_token (no Authorization) → M_MISSING_TOKEN
// ---------------------------------------------------------------------------

describe('race residual appservice query-only token after #236', () => {
  for (let i = 0; i < 12; i++) {
    it(`query-only access_token missing∥Bearer ok flood-${i}`, async () => {
      getAppServiceByToken.mockImplementation(async (_db: unknown, tok: string) =>
        tok === AS_TOKEN ? BRIDGE_REG : null
      );
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const before = getAppServiceByToken.mock.calls.length;
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}?access_token=${AS_TOKEN}`),
        request(`/_matrix/app/v1/thirdparty/protocol/irc?access_token=${AS_TOKEN}`),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}?access_token=x`, bearer(AS_TOKEN), makeEnv({
          db: createAliasDb({ aliases: [{ alias: ALIAS, room_id: ROOM_ID }] }),
        })),
      ]);
      expect(results[0].status).toBe(401);
      expect(results[0].body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
      expect(results[1].status).toBe(401);
      expect(results[1].body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(200);
      // Query-only must not call getAppServiceByToken
      const newCalls = getAppServiceByToken.mock.calls.length - before;
      expect(newCalls).toBe(2); // only the two Bearer paths
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: leading/trailing space on token after "Bearer " (slice(7) no trim)
// ---------------------------------------------------------------------------

describe('race residual appservice token spacing after #236', () => {
  for (let i = 0; i < 12; i++) {
    it(`leading space unknown; Headers-trim trailing ok flood-${i}`, async () => {
      getAppServiceByToken.mockImplementation(async (_db: unknown, tok: string) =>
        tok === AS_TOKEN ? BRIDGE_REG : null
      );
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, {
          // slice(7) keeps leading space → unknown (distinct from #236 mid double-space)
          headers: { Authorization: `Bearer  ${AS_TOKEN}` },
        }),
        request(`/_matrix/app/v1/users/${USER_ENC}`, {
          // Fetch Headers trim trailing whitespace → token still matches
          headers: { Authorization: `Bearer ${AS_TOKEN} ` },
        }),
        request(`/_matrix/app/v1/thirdparty/user/irc`, {
          headers: { Authorization: `Bearer ${AS_TOKEN}\t` },
        }),
        request(`/_matrix/app/v1/thirdparty/location/irc`, bearer(AS_TOKEN)),
      ]);
      expect(results[0].status).toBe(401);
      expect(results[0].body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
      expect(results[1].status).toBe(200);
      expect(results[1].body).toEqual({});
      expect(results[2].status).toBe(200);
      expect(results[2].body).toEqual([]);
      expect(results[3].status).toBe(200);
      expect(results[3].body).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: AS namespaces NOT enforced on HS /users|/rooms query routes
// ---------------------------------------------------------------------------

describe('race residual appservice namespace not enforced on routes after #236', () => {
  for (let i = 0; i < 12; i++) {
    it(`out-of-ns user/alias resolved by DB only flood-${i}`, async () => {
      authOk();
      getUserById.mockImplementation(async (_db: unknown, id: string) =>
        id === OUT_NS_USER ? ({ user_id: OUT_NS_USER } as never) : null
      );
      const db = createAliasDb({
        aliases: [{ alias: OUT_NS_ALIAS, room_id: ROOM_ID }],
      });
      const env = makeEnv({ db });
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${OUT_NS_USER_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${OUT_NS_ALIAS_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/users/${encodeURIComponent(`@missing_${i}:${SERVER}`)}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env),
      ]);
      // Handlers never read c.get('appservice').namespaces — hit/miss by DB only
      expect(results[0].status).toBe(200);
      expect(results[0].body).toEqual({});
      expect(results[1].status).toBe(200);
      expect(results[1].body).toEqual({});
      expect(results[2].status).toBe(404);
      expect(results[2].body).toMatchObject({ errcode: 'M_NOT_FOUND' });
      expect(results[3].status).toBe(404); // USER not in getUserById mock
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: room-id-shaped path on /rooms/:roomAlias
// ---------------------------------------------------------------------------

describe('race residual appservice room-id-as-alias path after #236', () => {
  for (let i = 0; i < 10; i++) {
    it(`room-id path on rooms endpoint → 404 flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const db = createAliasDb({
        aliases: [
          { alias: ALIAS, room_id: ROOM_ID },
          // deliberately no alias equal to ROOM_ID
        ],
      });
      const env = makeEnv({ db });
      const results = await Promise.all([
        request(`/_matrix/app/v1/rooms/${ROOM_ID_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env),
      ]);
      expect(results[0].status).toBe(404);
      expect(results[0].body).toMatchObject({ errcode: 'M_NOT_FOUND' });
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(200);
      expect(db.selects.some((s) => s.args[0] === ROOM_ID)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: missing ping endpoint + thirdparty control
// ---------------------------------------------------------------------------

describe('race residual appservice missing ping after #236', () => {
  for (let i = 0; i < 10; i++) {
    it(`ping GET/POST 404∥thirdparty 200 flood-${i}`, async () => {
      authOk();
      const results = await Promise.all([
        request(`/_matrix/app/v1/ping`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/ping`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${AS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ transaction_id: `txn-${i}` }),
        }),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/protocol`, bearer(AS_TOKEN)),
      ]);
      expect([404, 405]).toContain(results[0].status);
      expect([404, 405]).toContain(results[1].status);
      expect(results[2].status).toBe(200);
      expect(results[2].body).toEqual({
        user_fields: [],
        location_fields: [],
        field_types: {},
        instances: [],
      });
      expect([404, 405]).toContain(results[3].status);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: throwOnAlias ∥ user-ok ∥ thirdparty-ok three-way
// ---------------------------------------------------------------------------

describe('race residual appservice throwOnAlias three-way after #236', () => {
  for (let i = 0; i < 12; i++) {
    it(`alias throw∥user ok∥tp ok flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const env = makeEnv({ db: createAliasDb({ throwOnAlias: true }) });
      const results = await Promise.all([
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/user/irc`, bearer(AS_TOKEN), env),
      ]);
      expect(results[0].status).toBeGreaterThanOrEqual(500);
      expect(results[1].status).toBe(200);
      expect(results[1].body).toEqual({});
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(200);
      expect(results[3].body).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: case-sensitive Bearer scheme (startsWith('Bearer '))
// ---------------------------------------------------------------------------

describe('race residual appservice Bearer case-sensitivity after #236', () => {
  for (let i = 0; i < 12; i++) {
    it(`BEARER/BeArEr/bearer missing∥Bearer ok flood-${i}`, async () => {
      getAppServiceByToken.mockImplementation(async (_db: unknown, tok: string) =>
        tok === AS_TOKEN ? BRIDGE_REG : null
      );
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const variants = ['BEARER', 'BeArEr', 'bearer', 'bEaReR'];
      const scheme = variants[i % variants.length];
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, {
          headers: { Authorization: `${scheme} ${AS_TOKEN}` },
        }),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, {
          headers: { Authorization: `${scheme} ${AS_TOKEN}` },
        }),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN)),
      ]);
      expect(results[0].status).toBe(401);
      expect(results[0].body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
      expect(results[1].status).toBe(401);
      expect(results[1].body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
      expect(results[2].status).toBe(200);
      expect(getAppServiceByToken).toHaveBeenCalledTimes(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: success body key-bind under race
// ---------------------------------------------------------------------------

describe('race residual appservice success body key-bind after #236', () => {
  for (let i = 0; i < 10; i++) {
    it(`users/rooms {} and protocol field set flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const env = makeEnv({
        db: createAliasDb({ aliases: [{ alias: ALIAS, room_id: ROOM_ID }] }),
      });
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/user/slack`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/location/slack`, bearer(AS_TOKEN), env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 200, 200, 200]);
      expect(results[0].body).toEqual({});
      expect(Object.keys(results[0].body as object)).toEqual([]);
      expect(results[1].body).toEqual({});
      expect(Object.keys(results[2].body as object).sort()).toEqual([
        'field_types',
        'instances',
        'location_fields',
        'user_fields',
      ]);
      expect(results[3].body).toEqual([]);
      expect(results[4].body).toEqual([]);
      // Mutation of returned array must not poison next response
      (results[3].body as unknown[]).push({ poisoned: true });
      const again = await request(`/_matrix/app/v1/thirdparty/user/slack`, bearer(AS_TOKEN), env);
      expect(again.body).toEqual([]);
    });
  }
});
