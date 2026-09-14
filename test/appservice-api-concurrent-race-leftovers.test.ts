/**
 * TOKENMAXX HEAVY leftovers after #214 / #217 — appservice-api *concurrent race /
 * TOCTOU* + residual failure soft edges (first concurrent-race pass #217).
 *
 * Complements appservice-api-routes.test.ts (#122 concurrent stress) and
 * appservice-api-route-leftovers.test.ts (#154 soft floods). Orthogonal to
 * keys-media-appservice-concurrent-race (#158) which races service-layer
 * sendTransaction / interest / exclusive — not pure HS `/_matrix/app/v1/*`
 * route isolation under Promise.all with mid-flight mutation barriers.
 *
 * Focus: auth fail∥ok isolation; user hit∥miss mid-flight TOCTOU; alias
 * map mutation barriers; thirdparty stub coherency; method soft floods;
 * errcode contracts under race; cross-endpoint isolation.
 *
 * Residual deepen after #232: empty/whitespace Bearer; hs_token≠as_token;
 * query-string ignore; double-encode user/alias; unicode protocol; alias
 * mutate inject (not only wipe); getUserById throw∥ok; auth lookup count
 * bind; Accept/Content-Type soft; thirdparty special-char paths.
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
const AS_TOKEN = 'as-token-bridge-race';
const USER = `@_bridge_alice:${SERVER}`;
const USER_ENC = encodeURIComponent(USER);
const ALIAS = `#_bridge_room:${SERVER}`;
const ALIAS_ENC = encodeURIComponent(ALIAS);

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

type AliasBarrier = {
  match: (alias: string) => boolean;
  count: number;
};

async function withAliasBarrier(
  barrier: AliasBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  alias: string
) {
  if (!barrier || !barrier.match(alias)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
}

function createAliasDb(
  opts: {
    aliases?: AliasRow[];
    throwOnAlias?: boolean;
    getBarrier?: AliasBarrier;
    mutateAfterGets?: { after: number; next: AliasRow[] };
  } = {}
) {
  const aliases = [...(opts.aliases ?? [])];
  const selects: SqlCall[] = [];
  const waiters = { list: [] as Array<() => void> };
  let getBarrier = opts.getBarrier;
  let getCount = 0;

  const db = {
    aliases,
    selects,
    get getCount() {
      return getCount;
    },
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
                await withAliasBarrier(getBarrier, waiters, () => {
                  getBarrier = undefined;
                }, alias);
                getCount += 1;
                const row = aliases.find((a) => a.alias === alias);
                if (opts.mutateAfterGets && getCount === opts.mutateAfterGets.after) {
                  aliases.splice(0, aliases.length, ...opts.mutateAfterGets.next);
                }
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

  return db as unknown as D1Database & {
    aliases: AliasRow[];
    selects: SqlCall[];
    getCount: number;
  };
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
// Auth fail∥ok isolation under Promise.all
// ---------------------------------------------------------------------------

describe('race appservice auth fail∥ok isolation after #214', () => {
  for (let i = 0; i < 16; i++) {
    it(`missing∥ok parallel flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN)),
      ]);
      expect(statusesOf(results)).toEqual([401, 200, 200]);
      expect(results[0].body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
      expect(results[1].body).toEqual({});
      expect(results[2].body).toMatchObject({ instances: [] });
    });
  }

  for (let i = 0; i < 16; i++) {
    it(`unknown∥ok parallel flood-${i}`, async () => {
      getAppServiceByToken.mockImplementation(async (_db: unknown, tok: string) =>
        tok === AS_TOKEN ? BRIDGE_REG : null
      );
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(`bad-tok-${i}`)),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(`bad-tok-${i}`), makeEnv({
          db: createAliasDb({ aliases: [{ alias: ALIAS, room_id: `!r:${SERVER}` }] }),
        })),
      ]);
      expect(results[0].status).toBe(401);
      expect(results[0].body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(401);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`non-Bearer∥ok parallel flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, {
          headers: { Authorization: `Basic ${AS_TOKEN}` },
        }),
        request(`/_matrix/app/v1/thirdparty/user/irc`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/location/irc`, {
          headers: { Authorization: `bearer ${AS_TOKEN}` },
        }),
      ]);
      expect(statusesOf(results)).toEqual([401, 200, 401]);
      expect(getUserById).toHaveBeenCalledTimes(0);
    });
  }
});

// ---------------------------------------------------------------------------
// User hit∥miss mid-flight TOCTOU
// ---------------------------------------------------------------------------

describe('race appservice user hit∥miss mid-flight after #214', () => {
  for (let i = 0; i < 16; i++) {
    it(`parallel distinct user hit∥miss flood-${i}`, async () => {
      authOk();
      const hit = `@_bridge_hit${i}:${SERVER}`;
      const miss = `@_bridge_miss${i}:${SERVER}`;
      getUserById.mockImplementation(async (_db: unknown, userId: string) =>
        userId === hit ? ({ user_id: hit } as never) : null
      );
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${encodeURIComponent(hit)}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/users/${encodeURIComponent(miss)}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/users/${encodeURIComponent(hit)}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/users/${encodeURIComponent(miss)}`, bearer(AS_TOKEN)),
      ]);
      expect(statusesOf(results)).toEqual([200, 404, 200, 404]);
      expect(results[0].body).toEqual({});
      expect(results[1].body).toMatchObject({ errcode: 'M_NOT_FOUND' });
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`mid-flight getUserById flip flood-${i}`, async () => {
      authOk();
      let calls = 0;
      const waiters: Array<() => void> = [];
      getUserById.mockImplementation(async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          if (waiters.length >= 2) {
            const all = [...waiters];
            waiters.length = 0;
            for (const r of all) r();
          }
        });
        // After barrier: first pair both see flip based on call order snapshot
        return calls <= 2 ? ({ user_id: USER } as never) : null;
      });
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN)),
      ]);
      // Both entered before flip completed; both see truthy rows from first two calls
      expect(results.every((r) => r.status === 200)).toBe(true);
      const later = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN)),
      ]);
      expect(statusesOf(later)).toEqual([404, 404]);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`auth-fail never calls getUserById under race flood-${i}`, async () => {
      getAppServiceByToken.mockResolvedValue(null);
      getUserById.mockResolvedValue({ user_id: USER } as never);
      await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad')),
        request(`/_matrix/app/v1/users/${USER_ENC}`),
        request(`/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_x${i}:${SERVER}`)}`, bearer('bad')),
      ]);
      expect(getUserById).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Alias map mutation barriers / hit∥miss
// ---------------------------------------------------------------------------

describe('race appservice alias hit∥miss TOCTOU after #214', () => {
  for (let i = 0; i < 16; i++) {
    it(`parallel alias hit∥miss flood-${i}`, async () => {
      authOk();
      const hit = `#_bridge_hit${i}:${SERVER}`;
      const miss = `#_bridge_miss${i}:${SERVER}`;
      const db = createAliasDb({
        aliases: [{ alias: hit, room_id: `!r${i}:${SERVER}` }],
      });
      const env = makeEnv({ db });
      const results = await Promise.all([
        request(`/_matrix/app/v1/rooms/${encodeURIComponent(hit)}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${encodeURIComponent(miss)}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${encodeURIComponent(hit)}`, bearer(AS_TOKEN), env),
      ]);
      expect(statusesOf(results)).toEqual([200, 404, 200]);
      expect(results[0].body).toEqual({});
      expect(results[1].body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Room alias not found' });
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`alias get-barrier mutate-after-pair flood-${i}`, async () => {
      authOk();
      const alias = `#_bridge_barrier${i}:${SERVER}`;
      const db = createAliasDb({
        aliases: [{ alias, room_id: `!before${i}:${SERVER}` }],
        getBarrier: { match: (a) => a === alias, count: 2 },
        mutateAfterGets: {
          after: 2,
          next: [], // wipe after both barriered reads complete post-increment
        },
      });
      const env = makeEnv({ db });
      const results = await Promise.all([
        request(`/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`, bearer(AS_TOKEN), env),
      ]);
      // Both barriered gets read pre-mutation snapshot
      expect(results.every((r) => r.status === 200)).toBe(true);
      const after = await request(
        `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
        bearer(AS_TOKEN),
        env
      );
      expect(after.status).toBe(404);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`alias throw∥ok isolation flood-${i}`, async () => {
      authOk();
      const okAlias = `#_bridge_ok${i}:${SERVER}`;
      const badAlias = `#_bridge_bad${i}:${SERVER}`;
      const db = createAliasDb({
        aliases: [{ alias: okAlias, room_id: `!ok${i}:${SERVER}` }],
        throwOnAlias: false,
      });
      // Selective throw via mock wrapper on prepare path: use two DBs
      const throwDb = createAliasDb({ throwOnAlias: true });
      const [a, b] = await Promise.all([
        request(
          `/_matrix/app/v1/rooms/${encodeURIComponent(okAlias)}`,
          bearer(AS_TOKEN),
          makeEnv({ db })
        ),
        request(
          `/_matrix/app/v1/rooms/${encodeURIComponent(badAlias)}`,
          bearer(AS_TOKEN),
          makeEnv({ db: throwDb })
        ),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(500);
    });
  }
});

// ---------------------------------------------------------------------------
// Thirdparty stub coherency under race
// ---------------------------------------------------------------------------

describe('race appservice thirdparty stub coherency after #214', () => {
  for (let i = 0; i < 16; i++) {
    it(`protocol∥user∥location parallel flood-${i}`, async () => {
      authOk();
      const proto = `proto${i}`;
      const results = await Promise.all([
        request(`/_matrix/app/v1/thirdparty/protocol/${proto}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/user/${proto}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/location/${proto}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/protocol/${proto}`, bearer(AS_TOKEN)),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 200, 200]);
      const p0 = results[0].body as {
        user_fields: unknown[];
        location_fields: unknown[];
        field_types: Record<string, unknown>;
        instances: unknown[];
      };
      const p1 = results[3].body as typeof p0;
      p0.instances.push(`leak-${i}`);
      p0.field_types.x = i;
      expect(p1.instances).toEqual([]);
      expect(p1.field_types).toEqual({});
      expect(results[1].body).toEqual([]);
      expect(results[2].body).toEqual([]);
      (results[1].body as unknown[]).push(i);
      expect(results[2].body).toEqual([]);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`thirdparty auth-required under race flood-${i}`, async () => {
      getAppServiceByToken.mockResolvedValue(null);
      const results = await Promise.all([
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer('x')),
        request(`/_matrix/app/v1/thirdparty/user/irc`),
        request(`/_matrix/app/v1/thirdparty/location/irc`, bearer('y')),
      ]);
      expect(statusesOf(results)).toEqual([401, 401, 401]);
      expect(results.map((r) => (r.body as { errcode: string }).errcode)).toEqual([
        'M_UNKNOWN_TOKEN',
        'M_MISSING_TOKEN',
        'M_UNKNOWN_TOKEN',
      ]);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-endpoint isolation under Promise.all
// ---------------------------------------------------------------------------

describe('race appservice cross-endpoint isolation after #214', () => {
  for (let i = 0; i < 16; i++) {
    it(`user-hit∥alias-miss∥tp-ok flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const db = createAliasDb();
      const env = makeEnv({ db });
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/user/slack`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/location/xmpp`, bearer(AS_TOKEN), env),
      ]);
      expect(statusesOf(results)).toEqual([200, 404, 200, 200, 200]);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`user-miss∥alias-hit∥auth-fail flood-${i}`, async () => {
      getAppServiceByToken.mockImplementation(async (_db: unknown, tok: string) =>
        tok === AS_TOKEN ? BRIDGE_REG : null
      );
      getUserById.mockResolvedValue(null);
      const db = createAliasDb({
        aliases: [{ alias: ALIAS, room_id: `!r:${SERVER}` }],
      });
      const env = makeEnv({ db });
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('nope'), env),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, env),
      ]);
      expect(statusesOf(results)).toEqual([404, 200, 401, 401]);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`getAppServiceByToken reject∥ok isolation flood-${i}`, async () => {
      getAppServiceByToken.mockImplementation(async (_db: unknown, tok: string) => {
        if (String(tok).startsWith('fail-')) throw new Error(`as down ${i}`);
        return BRIDGE_REG;
      });
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(`fail-${i}-a`)),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(`fail-${i}-b`)),
        request(`/_matrix/app/v1/thirdparty/user/irc`, bearer(AS_TOKEN)),
      ]);
      expect(results[0].status).toBe(500);
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(500);
      expect(results[3].status).toBe(200);
    });
  }
});

// ---------------------------------------------------------------------------
// Method soft floods under concurrency
// ---------------------------------------------------------------------------

describe('race appservice method soft floods after #214', () => {
  const paths = [
    `/_matrix/app/v1/users/${USER_ENC}`,
    `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
    '/_matrix/app/v1/thirdparty/protocol/irc',
    '/_matrix/app/v1/thirdparty/user/irc',
    '/_matrix/app/v1/thirdparty/location/irc',
  ];

  for (let i = 0; i < 12; i++) {
    it(`bad methods∥GET ok flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const db = createAliasDb({
        aliases: [{ alias: ALIAS, room_id: `!r:${SERVER}` }],
      });
      const env = makeEnv({ db });
      const path = paths[i % paths.length];
      const results = await Promise.all([
        request(path, { method: 'POST', headers: { Authorization: `Bearer ${AS_TOKEN}` } }, env),
        request(path, { method: 'PUT', headers: { Authorization: `Bearer ${AS_TOKEN}` } }, env),
        request(path, { method: 'DELETE', headers: { Authorization: `Bearer ${AS_TOKEN}` } }, env),
        request(path, bearer(AS_TOKEN), env),
      ]);
      expect([404, 405]).toContain(results[0].status);
      expect([404, 405]).toContain(results[1].status);
      expect([404, 405]).toContain(results[2].status);
      expect(results[3].status).toBe(200);
    });
  }
});

// ---------------------------------------------------------------------------
// Errcode contract soft floods under race
// ---------------------------------------------------------------------------

describe('race appservice errcode contracts under parallel after #214', () => {
  for (let i = 0; i < 16; i++) {
    it(`M_MISSING_TOKEN contract flood-${i}`, async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => request(`/_matrix/app/v1/users/${USER_ENC}`))
      );
      for (const r of results) {
        expect(r.status).toBe(401);
        expect(r.body).toMatchObject({
          errcode: 'M_MISSING_TOKEN',
          error: 'Missing AS token',
        });
      }
    });
  }

  for (let i = 0; i < 16; i++) {
    it(`M_UNKNOWN_TOKEN contract flood-${i}`, async () => {
      getAppServiceByToken.mockResolvedValue(null);
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, j) =>
          request(`/_matrix/app/v1/thirdparty/protocol/p${j}`, bearer(`bad-${i}-${j}`))
        )
      );
      for (const r of results) {
        expect(r.status).toBe(401);
        expect(r.body).toMatchObject({
          errcode: 'M_UNKNOWN_TOKEN',
          error: 'Invalid AS token',
        });
      }
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`success bodies never leak errcode flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const db = createAliasDb({
        aliases: [{ alias: ALIAS, room_id: `!r:${SERVER}` }],
      });
      const env = makeEnv({ db });
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN), env),
      ]);
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(r.body).not.toHaveProperty('errcode');
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Lifecycle chains under soft concurrency
// ---------------------------------------------------------------------------

describe('race appservice lifecycle chains after #214', () => {
  for (let i = 0; i < 16; i++) {
    it(`auth→user→alias→tp chain flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const db = createAliasDb({
        aliases: [{ alias: ALIAS, room_id: `!r:${SERVER}` }],
      });
      const env = makeEnv({ db });
      const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
      expect(u.status).toBe(200);
      const [a, p, tu, loc] = await Promise.all([
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/user/irc`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/location/irc`, bearer(AS_TOKEN), env),
      ]);
      expect(statusesOf([a, p, tu, loc])).toEqual([200, 200, 200, 200]);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #232 — empty / whitespace Bearer + hs_token confusion
// ---------------------------------------------------------------------------

describe('race appservice Bearer edges after #232', () => {
  for (let i = 0; i < 12; i++) {
    it(`empty∥whitespace Bearer∥ok soft flood-${i}`, async () => {
      getAppServiceByToken.mockImplementation(async (_db: unknown, tok: string) =>
        tok === AS_TOKEN ? BRIDGE_REG : null
      );
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, {
          headers: { Authorization: 'Bearer ' },
        }),
        request(`/_matrix/app/v1/users/${USER_ENC}`, {
          headers: { Authorization: 'Bearer' },
        }),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, {
          headers: { Authorization: `Bearer  tok-space-${i}` },
        }),
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN)),
      ]);
      // Header parsers typically trim "Bearer " → missing; bare "Bearer" is missing
      expect(results[0].status).toBe(401);
      expect(results[0].body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
      expect(results[1].status).toBe(401);
      expect(results[1].body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
      expect(results[2].status).toBe(401);
      expect(results[2].body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
      expect(results[3].status).toBe(200);
      expect(results[3].body).toEqual({});
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`hs_token ≠ as_token soft flood-${i}`, async () => {
      getAppServiceByToken.mockImplementation(async (_db: unknown, tok: string) =>
        tok === AS_TOKEN ? BRIDGE_REG : null
      );
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const hs = BRIDGE_REG.hs_token;
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(hs)),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(hs), makeEnv({
          db: createAliasDb({ aliases: [{ alias: ALIAS, room_id: `!r:${SERVER}` }] }),
        })),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN)),
      ]);
      expect(results[0].status).toBe(401);
      expect(results[0].body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
      expect(results[1].status).toBe(401);
      expect(results[2].status).toBe(200);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`Authorization missing vs empty header soft flood-${i}`, async () => {
      authOk();
      const results = await Promise.all([
        request(`/_matrix/app/v1/thirdparty/user/irc`),
        request(`/_matrix/app/v1/thirdparty/user/irc`, { headers: { Authorization: '' } }),
        request(`/_matrix/app/v1/thirdparty/location/irc`, bearer(AS_TOKEN)),
      ]);
      expect(results[0].status).toBe(401);
      expect(results[0].body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
      expect(results[1].status).toBe(401);
      expect(results[1].body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
      expect(results[2].status).toBe(200);
      expect(results[2].body).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #232 — query ignore + double-encode + unicode proto
// ---------------------------------------------------------------------------

describe('race appservice encoding + query soft after #232', () => {
  for (let i = 0; i < 12; i++) {
    it(`query string ignored soft flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const db = createAliasDb({
        aliases: [{ alias: ALIAS, room_id: `!r:${SERVER}` }],
      });
      const env = makeEnv({ db });
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}?foo=bar&access_token=x`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}?limit=1`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/protocol/irc?x=${i}`, bearer(AS_TOKEN), env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 200]);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`double-encoded userId soft flood-${i}`, async () => {
      authOk();
      const hit = `@_bridge_enc${i}:${SERVER}`;
      getUserById.mockImplementation(async (_db: unknown, userId: string) =>
        userId === hit ? ({ user_id: hit } as never) : null
      );
      const single = encodeURIComponent(hit);
      const doubled = encodeURIComponent(single);
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${single}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/users/${doubled}`, bearer(AS_TOKEN)),
      ]);
      expect(results[0].status).toBe(200);
      // Double-encode typically yields wrong decoded id → not found
      expect(results[1].status).toBe(404);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`unicode protocol path soft flood-${i}`, async () => {
      authOk();
      const protos = [`café${i}`, `прото${i}`, `协议${i}`, `😀${i}`];
      const proto = encodeURIComponent(protos[i % protos.length]);
      const results = await Promise.all([
        request(`/_matrix/app/v1/thirdparty/protocol/${proto}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/user/${proto}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/location/${proto}`, bearer(AS_TOKEN)),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 200]);
      expect(results[0].body).toMatchObject({ instances: [], user_fields: [] });
      expect(results[1].body).toEqual([]);
      expect(results[2].body).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #232 — alias mutate inject + getUserById throw
// ---------------------------------------------------------------------------

describe('race appservice mutate inject + user throw after #232', () => {
  for (let i = 0; i < 12; i++) {
    it(`alias mutate inject other soft flood-${i}`, async () => {
      authOk();
      const a = `#_bridge_a${i}:${SERVER}`;
      const b = `#_bridge_b${i}:${SERVER}`;
      const db = createAliasDb({
        aliases: [{ alias: a, room_id: `!a${i}:${SERVER}` }],
        getBarrier: { match: (x) => x === a, count: 2 },
        mutateAfterGets: {
          after: 2,
          next: [{ alias: b, room_id: `!b${i}:${SERVER}` }],
        },
      });
      const env = makeEnv({ db });
      const [r1, r2] = await Promise.all([
        request(`/_matrix/app/v1/rooms/${encodeURIComponent(a)}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${encodeURIComponent(a)}`, bearer(AS_TOKEN), env),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      const [gone, present] = await Promise.all([
        request(`/_matrix/app/v1/rooms/${encodeURIComponent(a)}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${encodeURIComponent(b)}`, bearer(AS_TOKEN), env),
      ]);
      expect(gone.status).toBe(404);
      expect(present.status).toBe(200);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`getUserById throw∥ok isolation flood-${i}`, async () => {
      authOk();
      getUserById.mockImplementation(async (_db: unknown, userId: string) => {
        if (userId.includes(`_throw${i}:`)) throw new Error(`user lookup fail ${i}`);
        return { user_id: userId } as never;
      });
      const ok = `@_bridge_ok${i}:${SERVER}`;
      const bad = `@_bridge_throw${i}:${SERVER}`;
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${encodeURIComponent(ok)}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/users/${encodeURIComponent(bad)}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/users/${encodeURIComponent(ok)}`, bearer(AS_TOKEN)),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(500);
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(200);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`getAppServiceByToken call-count bind flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/user/irc`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/users/${USER_ENC}`), // missing — no token lookup
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(401);
      // Three authenticated GETs → three token lookups; missing skips lookup
      expect(getAppServiceByToken).toHaveBeenCalledTimes(3);
      for (const call of getAppServiceByToken.mock.calls) {
        expect(call[1]).toBe(AS_TOKEN);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #232 — Accept/Content-Type + special-char paths
// ---------------------------------------------------------------------------

describe('race appservice Accept Content-Type soft after #232', () => {
  for (let i = 0; i < 10; i++) {
    it(`Accept header soft flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const accepts = ['application/json', '*/*', 'application/json, text/plain', 'text/html'];
      const accept = accepts[i % accepts.length];
      const results = await Promise.all([
        request(
          `/_matrix/app/v1/users/${USER_ENC}`,
          { method: 'GET', headers: { Authorization: `Bearer ${AS_TOKEN}`, Accept: accept } }
        ),
        request(
          `/_matrix/app/v1/thirdparty/protocol/irc`,
          { method: 'GET', headers: { Authorization: `Bearer ${AS_TOKEN}`, Accept: accept } }
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`thirdparty special-char protocol soft flood-${i}`, async () => {
      authOk();
      const raw = [`irc.v2`, `slack-bot`, `x_mpp`, `a.b.c${i}`][i % 4];
      const results = await Promise.all([
        request(`/_matrix/app/v1/thirdparty/protocol/${encodeURIComponent(raw)}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/user/${encodeURIComponent(raw)}`, bearer(AS_TOKEN)),
        request(`/_matrix/app/v1/thirdparty/location/${encodeURIComponent(raw)}`, bearer(AS_TOKEN)),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 200]);
      const proto = results[0].body as { field_types: Record<string, unknown>; instances: unknown[] };
      proto.instances.push(i);
      expect((results[0].body as { instances: unknown[] }).instances).toEqual([i]);
      // Fresh body on next request
      const again = await request(
        `/_matrix/app/v1/thirdparty/protocol/${encodeURIComponent(raw)}`,
        bearer(AS_TOKEN)
      );
      expect(again.body).toMatchObject({ instances: [] });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`user miss∥alias miss∥tp ok errcode isolation flood-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue(null);
      const db = createAliasDb();
      const env = makeEnv({ db });
      const results = await Promise.all([
        request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN), env),
        request(`/_matrix/app/v1/users/${USER_ENC}`, env),
      ]);
      expect(results[0].body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'User not found' });
      expect(results[1].body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Room alias not found' });
      expect(results[2].status).toBe(200);
      expect(results[3].body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
    });
  }
});
