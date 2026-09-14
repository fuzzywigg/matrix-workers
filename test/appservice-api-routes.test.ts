/**
 * TOKENMAXX HEAVY deepen after #122 — different slice: Application Service HTTP API routes.
 * Avoids federation keys/events/S2S (#121/#122), sliding-sync/sync/voip/rooms/oidc/media/relations.
 * Orthogonal to service-layer appservice.test.ts (namespaces / transactions).
 * Tests-only — no product inventing. Exercises Hono app.request() on src/api/appservice.ts.
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
const AS_TOKEN = 'as-token-bridge-abc';
const USER = `@_bridge_alice:${SERVER}`;
const USER_ENC = encodeURIComponent(USER);
const ALIAS = `#_bridge_room:${SERVER}`;
const ALIAS_ENC = encodeURIComponent(ALIAS);
const PROTOCOL = 'irc';

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

function createAliasDb(opts: { aliases?: AliasRow[]; throwOnAlias?: boolean } = {}) {
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

function bearer(token: string, extras: Record<string, string> = {}): RequestInit {
  return {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, ...extras },
  };
}

function authOk() {
  getAppServiceByToken.mockResolvedValue(BRIDGE_REG);
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
// Auth middleware (shared by every /_matrix/app/v1/* route)
// ---------------------------------------------------------------------------

describe('appservice requireAppServiceAuth — shared gate', () => {
  const paths = [
    `/_matrix/app/v1/users/${USER_ENC}`,
    `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
    `/_matrix/app/v1/thirdparty/protocol/${PROTOCOL}`,
    `/_matrix/app/v1/thirdparty/user/${PROTOCOL}`,
    `/_matrix/app/v1/thirdparty/location/${PROTOCOL}`,
  ];

  it.each(paths)('returns M_MISSING_TOKEN when Authorization absent on %s', async (path) => {
    const { status, body } = await request(path);
    expect(status).toBe(401);
    expect(body).toMatchObject({
      errcode: 'M_MISSING_TOKEN',
      error: 'Missing AS token',
    });
    expect(getAppServiceByToken).not.toHaveBeenCalled();
  });

  it.each(paths)('returns M_MISSING_TOKEN for non-Bearer scheme on %s', async (path) => {
    const { status, body } = await request(path, {
      headers: { Authorization: `Basic ${AS_TOKEN}` },
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN', error: 'Missing AS token' });
    expect(getAppServiceByToken).not.toHaveBeenCalled();
  });

  it.each(paths)('returns M_MISSING_TOKEN for bare "Bearer" (no space+token) on %s', async (path) => {
    const { status, body } = await request(path, {
      headers: { Authorization: 'Bearer' },
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
    expect(getAppServiceByToken).not.toHaveBeenCalled();
  });

  it.each(paths)('returns M_UNKNOWN_TOKEN when AS token is not registered on %s', async (path) => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(path, bearer('bogus-as-token'));
    expect(status).toBe(401);
    expect(body).toMatchObject({
      errcode: 'M_UNKNOWN_TOKEN',
      error: 'Invalid AS token',
    });
    expect(getAppServiceByToken).toHaveBeenCalledTimes(1);
    expect(getAppServiceByToken.mock.calls[0][1]).toBe('bogus-as-token');
  });

  it.each(paths)('passes sliced Bearer token to getAppServiceByToken on %s', async (path) => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER });
    await request(path, bearer(AS_TOKEN), makeEnv({ db: createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] }) }));
    expect(getAppServiceByToken).toHaveBeenCalledWith(expect.anything(), AS_TOKEN);
  });

  it('Fetch Headers trim trailing space on "Bearer " → becomes bare Bearer → M_MISSING_TOKEN', async () => {
    // undici/Fetch Header values trim whitespace; "Bearer " collapses to "Bearer"
    // which fails startsWith("Bearer ") and never calls getAppServiceByToken.
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, {
      headers: { Authorization: 'Bearer ' },
    });
    expect(getAppServiceByToken).not.toHaveBeenCalled();
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('does not treat lowercase "bearer " as Bearer (scheme is case-sensitive here)', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, {
      headers: { Authorization: `bearer ${AS_TOKEN}` },
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
    expect(getAppServiceByToken).not.toHaveBeenCalled();
  });

  it('rejects Authorization token schemes that merely contain Bearer', async () => {
    const { status } = await request(`/_matrix/app/v1/users/${USER_ENC}`, {
      headers: { Authorization: `NotBearer ${AS_TOKEN}` },
    });
    expect(status).toBe(401);
    expect(getAppServiceByToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /_matrix/app/v1/users/:userId
// ---------------------------------------------------------------------------

describe('appservice GET /_matrix/app/v1/users/:userId', () => {
  it('returns 404 M_NOT_FOUND when user does not exist', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({
      errcode: 'M_NOT_FOUND',
      error: 'User not found',
    });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('returns empty JSON object when user exists', async () => {
    authOk();
    getUserById.mockResolvedValue({
      user_id: USER,
      localpart: '_bridge_alice',
      display_name: 'Bridge Alice',
    });
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('decodes percent-encoded userId before getUserById', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER });
    // Hono param is already decoded from the path; encodeURIComponent round-trip
    await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(getUserById.mock.calls[0][1]).toBe(USER);
  });

  it('looks up users with special localparts (@, :, encoded)', async () => {
    authOk();
    const weird = `@user+tag:${SERVER}`;
    getUserById.mockResolvedValue({ user_id: weird });
    const { status, body } = await request(
      `/_matrix/app/v1/users/${encodeURIComponent(weird)}`,
      bearer(AS_TOKEN)
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), weird);
  });

  it('does not call getUserById when AS auth fails', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad'));
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('propagates getUserById thrown errors as HTTP 500', async () => {
    authOk();
    getUserById.mockRejectedValue(new Error('db down'));
    const { status } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(500);
  });

  it('passes env.DB as first argument to getUserById', async () => {
    authOk();
    const db = createAliasDb();
    getUserById.mockResolvedValue({ user_id: USER });
    await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), makeEnv({ db }));
    expect(getUserById.mock.calls[0][0]).toBe(db);
  });

  it('truthy user row of any shape still returns {}', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, admin: 0, is_guest: 1 });
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it.each([
    `@alice:${SERVER}`,
    `@_bridge_bot:${SERVER}`,
    `@ghost_1:${SERVER}`,
    `@UPPER:${SERVER}`,
  ])('queries exact userId string %s', async (userId) => {
    authOk();
    getUserById.mockResolvedValue(null);
    await request(`/_matrix/app/v1/users/${encodeURIComponent(userId)}`, bearer(AS_TOKEN));
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), userId);
  });
});

// ---------------------------------------------------------------------------
// GET /_matrix/app/v1/rooms/:roomAlias
// ---------------------------------------------------------------------------

describe('appservice GET /_matrix/app/v1/rooms/:roomAlias', () => {
  it('returns 404 when alias is unknown', async () => {
    authOk();
    const db = createAliasDb({ aliases: [] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({
      errcode: 'M_NOT_FOUND',
      error: 'Room alias not found',
    });
    expect(db.selects[0].args).toEqual([ALIAS]);
  });

  it('returns empty JSON object when alias exists', async () => {
    authOk();
    const db = createAliasDb({
      aliases: [{ alias: ALIAS, room_id: '!bridge_portal:example.com' }],
    });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('binds decoded roomAlias to SELECT room_id FROM room_aliases', async () => {
    authOk();
    const spaced = `#bridge space:${SERVER}`;
    const db = createAliasDb({
      aliases: [{ alias: spaced, room_id: '!r:example.com' }],
    });
    await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(spaced)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(db.selects[0].sql).toContain('FROM room_aliases');
    expect(db.selects[0].args).toEqual([spaced]);
  });

  it('does not leak room_id in the success response body', async () => {
    authOk();
    const db = createAliasDb({
      aliases: [{ alias: ALIAS, room_id: '!secret:example.com' }],
    });
    const { body } = await request(
      `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(body).toEqual({});
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('surfaces alias DB errors as HTTP 500', async () => {
    authOk();
    const db = createAliasDb({ throwOnAlias: true });
    const { status } = await request(
      `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(500);
  });

  it('does not query aliases when AS auth fails', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const db = createAliasDb({
      aliases: [{ alias: ALIAS, room_id: '!r:example.com' }],
    });
    await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer('bad'), makeEnv({ db }));
    expect(db.selects).toHaveLength(0);
  });

  it.each([
    `#general:${SERVER}`,
    `#_bridge_dm:${SERVER}`,
    `#Café:${SERVER}`,
  ])('looks up alias %s exactly', async (alias) => {
    authOk();
    const db = createAliasDb();
    await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(db.selects[0].args[0]).toBe(alias);
  });

  it('distinguishes aliases that differ only by case', async () => {
    authOk();
    const db = createAliasDb({
      aliases: [{ alias: `#Bridge:${SERVER}`, room_id: '!r:example.com' }],
    });
    const miss = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(`#bridge:${SERVER}`)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(miss.status).toBe(404);

    const hit = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(`#Bridge:${SERVER}`)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(hit.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /_matrix/app/v1/thirdparty/protocol/:protocol
// ---------------------------------------------------------------------------

describe('appservice GET /_matrix/app/v1/thirdparty/protocol/:protocol', () => {
  it('returns stub empty protocol info for any protocol when authenticated', async () => {
    authOk();
    const { status, body } = await request(
      `/_matrix/app/v1/thirdparty/protocol/${PROTOCOL}`,
      bearer(AS_TOKEN)
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      user_fields: [],
      location_fields: [],
      field_types: {},
      instances: [],
    });
  });

  it('does not call getUserById or touch room_aliases for protocol stub', async () => {
    authOk();
    const db = createAliasDb({
      aliases: [{ alias: ALIAS, room_id: '!r:example.com' }],
    });
    await request(
      `/_matrix/app/v1/thirdparty/protocol/irc`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(getUserById).not.toHaveBeenCalled();
    expect(db.selects).toHaveLength(0);
  });

  it.each(['irc', 'slack', 'telegram', 'm.protocol.custom', 'x'])(
    'returns the same stub shape for protocol %s',
    async (protocol) => {
      authOk();
      const { status, body } = await request(
        `/_matrix/app/v1/thirdparty/protocol/${encodeURIComponent(protocol)}`,
        bearer(AS_TOKEN)
      );
      expect(status).toBe(200);
      expect(body).toEqual({
        user_fields: [],
        location_fields: [],
        field_types: {},
        instances: [],
      });
    }
  );

  it('still requires valid AS auth before returning stub', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(
      `/_matrix/app/v1/thirdparty/protocol/irc`,
      bearer('nope')
    );
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('response field_types is a fresh empty object (not shared mutable singleton leak across calls)', async () => {
    authOk();
    const a = await request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN));
    const b = await request(`/_matrix/app/v1/thirdparty/protocol/slack`, bearer(AS_TOKEN));
    const aBody = a.body as { field_types: Record<string, unknown>; instances: unknown[] };
    const bBody = b.body as { field_types: Record<string, unknown>; instances: unknown[] };
    aBody.field_types['x'] = 1;
    aBody.instances.push('leak');
    expect(bBody.field_types).toEqual({});
    expect(bBody.instances).toEqual([]);
  });

  it('ignores query string parameters on protocol stub', async () => {
    authOk();
    const { status, body } = await request(
      `/_matrix/app/v1/thirdparty/protocol/irc?userid=alice&searchFields=1`,
      bearer(AS_TOKEN)
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      user_fields: [],
      location_fields: [],
      field_types: {},
      instances: [],
    });
  });
});

// ---------------------------------------------------------------------------
// GET /_matrix/app/v1/thirdparty/user/:protocol
// ---------------------------------------------------------------------------

describe('appservice GET /_matrix/app/v1/thirdparty/user/:protocol', () => {
  it('returns empty array stub when authenticated', async () => {
    authOk();
    const { status, body } = await request(
      `/_matrix/app/v1/thirdparty/user/${PROTOCOL}`,
      bearer(AS_TOKEN)
    );
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it.each(['irc', 'slack', 'gitter', 'custom'])(
    'returns [] for protocol %s',
    async (protocol) => {
      authOk();
      const { status, body } = await request(
        `/_matrix/app/v1/thirdparty/user/${encodeURIComponent(protocol)}`,
        bearer(AS_TOKEN)
      );
      expect(status).toBe(200);
      expect(body).toEqual([]);
    }
  );

  it('requires AS auth', async () => {
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/irc`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('does not call getUserById', async () => {
    authOk();
    await request(`/_matrix/app/v1/thirdparty/user/irc`, bearer(AS_TOKEN));
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('returns a fresh array each call (no shared mutable stub)', async () => {
    authOk();
    const a = await request(`/_matrix/app/v1/thirdparty/user/irc`, bearer(AS_TOKEN));
    const b = await request(`/_matrix/app/v1/thirdparty/user/irc`, bearer(AS_TOKEN));
    (a.body as unknown[]).push({ leaked: true });
    expect(b.body).toEqual([]);
  });

  it('ignores userid / fields query params (stub always empty)', async () => {
    authOk();
    const { status, body } = await request(
      `/_matrix/app/v1/thirdparty/user/irc?userid=@alice:example.com&fields=nick`,
      bearer(AS_TOKEN)
    );
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /_matrix/app/v1/thirdparty/location/:protocol
// ---------------------------------------------------------------------------

describe('appservice GET /_matrix/app/v1/thirdparty/location/:protocol', () => {
  it('returns empty array stub when authenticated', async () => {
    authOk();
    const { status, body } = await request(
      `/_matrix/app/v1/thirdparty/location/${PROTOCOL}`,
      bearer(AS_TOKEN)
    );
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it.each(['irc', 'slack', 'matrix'])(
    'returns [] for location protocol %s',
    async (protocol) => {
      authOk();
      const { status, body } = await request(
        `/_matrix/app/v1/thirdparty/location/${encodeURIComponent(protocol)}`,
        bearer(AS_TOKEN)
      );
      expect(status).toBe(200);
      expect(body).toEqual([]);
    }
  );

  it('requires AS auth', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(
      `/_matrix/app/v1/thirdparty/location/irc`,
      bearer('x')
    );
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('does not query room aliases', async () => {
    authOk();
    const db = createAliasDb({
      aliases: [{ alias: ALIAS, room_id: '!r:example.com' }],
    });
    await request(
      `/_matrix/app/v1/thirdparty/location/irc`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(db.selects).toHaveLength(0);
  });

  it('returns a fresh array each call', async () => {
    authOk();
    const a = await request(`/_matrix/app/v1/thirdparty/location/irc`, bearer(AS_TOKEN));
    const b = await request(`/_matrix/app/v1/thirdparty/location/irc`, bearer(AS_TOKEN));
    (a.body as unknown[]).push(1);
    expect(b.body).toEqual([]);
  });

  it('ignores searchFields query params', async () => {
    authOk();
    const { body } = await request(
      `/_matrix/app/v1/thirdparty/location/irc?searchFields=%23channel`,
      bearer(AS_TOKEN)
    );
    expect(body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Auth registration object wiring
// ---------------------------------------------------------------------------

describe('appservice auth — registration object wiring', () => {
  it('accepts any truthy AppServiceRegistration from getAppServiceByToken', async () => {
    const minimal: AppServiceRegistration = {
      id: 'min',
      url: 'https://min.example.com',
      as_token: 'min-tok',
      hs_token: 'hs',
      sender_localpart: 'min_bot',
      rate_limited: true,
      protocols: [],
      namespaces: { users: [], rooms: [], aliases: [] },
    };
    getAppServiceByToken.mockResolvedValue(minimal);
    getUserById.mockResolvedValue({ user_id: USER });
    const { status } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('min-tok'));
    expect(status).toBe(200);
    expect(getAppServiceByToken).toHaveBeenCalledWith(expect.anything(), 'min-tok');
  });

  it('passes env.DB into getAppServiceByToken', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER });
    const db = createAliasDb();
    await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), makeEnv({ db }));
    expect(getAppServiceByToken.mock.calls[0][0]).toBe(db);
  });

  it('propagates getAppServiceByToken rejection as HTTP 500', async () => {
    getAppServiceByToken.mockRejectedValue(new Error('kv timeout'));
    const { status } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(500);
  });

  it('token with embedded spaces is sliced exactly after "Bearer "', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    await request(`/_matrix/app/v1/thirdparty/protocol/irc`, {
      headers: { Authorization: 'Bearer tok with spaces' },
    });
    expect(getAppServiceByToken.mock.calls[0][1]).toBe('tok with spaces');
  });

  it('very long AS tokens are forwarded unchanged', async () => {
    const longTok = 'a'.repeat(4096);
    getAppServiceByToken.mockResolvedValue({ ...BRIDGE_REG, as_token: longTok });
    getUserById.mockResolvedValue({ user_id: USER });
    const { status } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(longTok));
    expect(status).toBe(200);
    expect(getAppServiceByToken.mock.calls[0][1]).toBe(longTok);
  });
});

// ---------------------------------------------------------------------------
// Cross-endpoint integration / isolation
// ---------------------------------------------------------------------------

describe('appservice TOKENMAXX cross-endpoint isolation after #122', () => {
  it('user hit + alias miss on same token are independent', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER });
    const db = createAliasDb({ aliases: [] });
    const env = makeEnv({ db });

    const user = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    const room = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);

    expect(user.status).toBe(200);
    expect(room.status).toBe(404);
    expect(getAppServiceByToken).toHaveBeenCalledTimes(2);
  });

  it('user miss + alias hit on same token are independent', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const db = createAliasDb({
      aliases: [{ alias: ALIAS, room_id: '!r:example.com' }],
    });
    const env = makeEnv({ db });

    const user = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    const room = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);

    expect(user.status).toBe(404);
    expect(room.status).toBe(200);
  });

  it('thirdparty stubs succeed even when user and alias lookups would 404', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const db = createAliasDb();
    const env = makeEnv({ db });

    const protocol = await request(
      `/_matrix/app/v1/thirdparty/protocol/irc`,
      bearer(AS_TOKEN),
      env
    );
    const userTp = await request(`/_matrix/app/v1/thirdparty/user/irc`, bearer(AS_TOKEN), env);
    const loc = await request(
      `/_matrix/app/v1/thirdparty/location/irc`,
      bearer(AS_TOKEN),
      env
    );

    expect(protocol.status).toBe(200);
    expect(userTp.status).toBe(200);
    expect(loc.status).toBe(200);
    expect(getUserById).not.toHaveBeenCalled();
    expect(db.selects).toHaveLength(0);
  });

  it('full happy-path sweep across all five endpoints', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER });
    const db = createAliasDb({
      aliases: [{ alias: ALIAS, room_id: '!bridge_1:example.com' }],
    });
    const env = makeEnv({ db });

    const results = await Promise.all([
      request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env),
      request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env),
      request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN), env),
      request(`/_matrix/app/v1/thirdparty/user/irc`, bearer(AS_TOKEN), env),
      request(`/_matrix/app/v1/thirdparty/location/irc`, bearer(AS_TOKEN), env),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results[0].body).toEqual({});
    expect(results[1].body).toEqual({});
    expect(results[2].body).toMatchObject({ user_fields: [], instances: [] });
    expect(results[3].body).toEqual([]);
    expect(results[4].body).toEqual([]);
  });

  it('full auth-failure sweep across all five endpoints', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const paths = [
      `/_matrix/app/v1/users/${USER_ENC}`,
      `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
      `/_matrix/app/v1/thirdparty/protocol/irc`,
      `/_matrix/app/v1/thirdparty/user/irc`,
      `/_matrix/app/v1/thirdparty/location/irc`,
    ];
    for (const path of paths) {
      const { status, body } = await request(path, bearer('bad'));
      expect(status).toBe(401);
      expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
    }
  });

  it('missing-token sweep uses dedicated Missing AS token message', async () => {
    const paths = [
      `/_matrix/app/v1/users/${USER_ENC}`,
      `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
      `/_matrix/app/v1/thirdparty/protocol/irc`,
      `/_matrix/app/v1/thirdparty/user/irc`,
      `/_matrix/app/v1/thirdparty/location/irc`,
    ];
    for (const path of paths) {
      const { body } = await request(path);
      expect(body).toMatchObject({
        errcode: 'M_MISSING_TOKEN',
        error: 'Missing AS token',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Path / encoding / method edges
// ---------------------------------------------------------------------------

describe('appservice TOKENMAXX path and method edges after #122', () => {
  it('POST is not registered on users endpoint (404 from Hono)', async () => {
    authOk();
    const { status } = await request(`/_matrix/app/v1/users/${USER_ENC}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AS_TOKEN}` },
    });
    expect(status).toBe(404);
  });

  it('PUT is not registered on rooms endpoint', async () => {
    authOk();
    const { status } = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${AS_TOKEN}` },
    });
    expect(status).toBe(404);
  });

  it('DELETE is not registered on thirdparty protocol endpoint', async () => {
    authOk();
    const { status } = await request(`/_matrix/app/v1/thirdparty/protocol/irc`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AS_TOKEN}` },
    });
    expect(status).toBe(404);
  });

  it('unknown /_matrix/app/v1 path returns 404', async () => {
    authOk();
    const { status } = await request(`/_matrix/app/v1/transactions/1`, bearer(AS_TOKEN));
    expect(status).toBe(404);
  });

  it('double-encoded userId is only decoded once by the router', async () => {
    authOk();
    // encodeURIComponent('@a:example.com') => %40a%3Aexample.com
    // double encode => %2540a%253Aexample.com which decodes once to %40a%3Aexample.com
    const doubleEnc = encodeURIComponent(USER_ENC);
    getUserById.mockResolvedValue(null);
    await request(`/_matrix/app/v1/users/${doubleEnc}`, bearer(AS_TOKEN));
    expect(getUserById.mock.calls[0][1]).toBe(USER_ENC);
  });

  it('alias with multiple colons still binds full decoded string', async () => {
    authOk();
    const odd = `#a:b:c:${SERVER}`;
    const db = createAliasDb();
    await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(odd)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(db.selects[0].args[0]).toBe(odd);
  });
});

// ---------------------------------------------------------------------------
// Error message / status contract matrix
// ---------------------------------------------------------------------------

describe('appservice TOKENMAXX error contract matrix after #122', () => {
  it('M_MISSING_TOKEN is always HTTP 401', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect((body as { errcode: string }).errcode).toBe('M_MISSING_TOKEN');
  });

  it('M_UNKNOWN_TOKEN is always HTTP 401', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(
      `/_matrix/app/v1/users/${USER_ENC}`,
      bearer('x')
    );
    expect(status).toBe(401);
    expect((body as { errcode: string }).errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('user M_NOT_FOUND is HTTP 404 with User not found', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toEqual(
      expect.objectContaining({ errcode: 'M_NOT_FOUND', error: 'User not found' })
    );
  });

  it('alias M_NOT_FOUND is HTTP 404 with Room alias not found', async () => {
    authOk();
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toEqual(
      expect.objectContaining({ errcode: 'M_NOT_FOUND', error: 'Room alias not found' })
    );
  });

  it('success bodies never include errcode', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER });
    const db = createAliasDb({
      aliases: [{ alias: ALIAS, room_id: '!r:example.com' }],
    });
    const env = makeEnv({ db });
    for (const path of [
      `/_matrix/app/v1/users/${USER_ENC}`,
      `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
      `/_matrix/app/v1/thirdparty/protocol/irc`,
      `/_matrix/app/v1/thirdparty/user/irc`,
      `/_matrix/app/v1/thirdparty/location/irc`,
    ]) {
      const { body } = await request(path, bearer(AS_TOKEN), env);
      expect(body).not.toHaveProperty('errcode');
    }
  });
});

// ---------------------------------------------------------------------------
// Repeated auth / token matrix
// ---------------------------------------------------------------------------

describe('appservice TOKENMAXX AS token matrix after #122', () => {
  // Authorization values must be ByteString (latin1); no non-ASCII code points.
  const tokens = [
    'simple',
    'tok-with-dashes',
    'tok_with_underscores',
    'tok.with.dots',
    'tok/with/slashes',
    'tok+plus',
    'tok=equals',
    'tok%XX-percent',
    '1234567890',
  ];

  it.each(tokens)('forwards AS token %j to getAppServiceByToken', async (tok) => {
    getAppServiceByToken.mockResolvedValue({ ...BRIDGE_REG, as_token: tok });
    getUserById.mockResolvedValue({ user_id: USER });
    const { status } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(tok));
    expect(status).toBe(200);
    expect(getAppServiceByToken.mock.calls[0][1]).toBe(tok);
  });

  it.each(tokens)('rejects unknown token %j with M_UNKNOWN_TOKEN', async (tok) => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(
      `/_matrix/app/v1/thirdparty/protocol/irc`,
      bearer(tok)
    );
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid AS token' });
  });
});

// ---------------------------------------------------------------------------
// User existence matrix
// ---------------------------------------------------------------------------

describe('appservice TOKENMAXX user existence matrix after #122', () => {
  beforeEach(() => {
    authOk();
  });

  it.each([
    null,
    undefined,
    false,
    0,
    '',
  ])('treats falsy getUserById result %j as not found', async (value) => {
    getUserById.mockResolvedValue(value);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it.each([
    { user_id: USER },
    { user_id: USER, extra: true },
    { any: 'shape' },
    [],
    'present',
    1,
    true,
  ])('treats truthy getUserById result as exists → {}', async (value) => {
    getUserById.mockResolvedValue(value);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Alias existence matrix
// ---------------------------------------------------------------------------

describe('appservice TOKENMAXX alias existence matrix after #122', () => {
  beforeEach(() => {
    authOk();
  });

  it('returns 404 when aliases table empty', async () => {
    const db = createAliasDb({ aliases: [] });
    const { status } = await request(
      `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(404);
  });

  it('returns 404 when other aliases exist but target does not', async () => {
    const db = createAliasDb({
      aliases: [
        { alias: `#other:${SERVER}`, room_id: '!o:example.com' },
        { alias: `#also:${SERVER}`, room_id: '!a:example.com' },
      ],
    });
    const { status } = await request(
      `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(404);
  });

  it('returns 200 when target alias is among many', async () => {
    const db = createAliasDb({
      aliases: [
        { alias: `#other:${SERVER}`, room_id: '!o:example.com' },
        { alias: ALIAS, room_id: '!hit:example.com' },
        { alias: `#also:${SERVER}`, room_id: '!a:example.com' },
      ],
    });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('SQL uses SELECT room_id FROM room_aliases WHERE alias = ?', async () => {
    const db = createAliasDb({
      aliases: [{ alias: ALIAS, room_id: '!r:example.com' }],
    });
    await request(
      `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(db.selects[0].sql).toMatch(/SELECT room_id FROM room_aliases WHERE alias = \?/);
  });
});

// ---------------------------------------------------------------------------
// Protocol stub field contract
// ---------------------------------------------------------------------------

describe('appservice TOKENMAXX thirdparty protocol field contract after #122', () => {
  beforeEach(() => {
    authOk();
  });

  it('protocol stub keys are exactly the four Spec fields', async () => {
    const { body } = await request(
      `/_matrix/app/v1/thirdparty/protocol/irc`,
      bearer(AS_TOKEN)
    );
    expect(Object.keys(body as object).sort()).toEqual([
      'field_types',
      'instances',
      'location_fields',
      'user_fields',
    ]);
  });

  it('user_fields and location_fields are arrays', async () => {
    const { body } = await request(
      `/_matrix/app/v1/thirdparty/protocol/irc`,
      bearer(AS_TOKEN)
    );
    const b = body as {
      user_fields: unknown;
      location_fields: unknown;
      field_types: unknown;
      instances: unknown;
    };
    expect(Array.isArray(b.user_fields)).toBe(true);
    expect(Array.isArray(b.location_fields)).toBe(true);
    expect(Array.isArray(b.instances)).toBe(true);
    expect(typeof b.field_types).toBe('object');
    expect(b.field_types).not.toBeNull();
  });

  it('user and location stubs are arrays (not objects)', async () => {
    const user = await request(`/_matrix/app/v1/thirdparty/user/irc`, bearer(AS_TOKEN));
    const loc = await request(`/_matrix/app/v1/thirdparty/location/irc`, bearer(AS_TOKEN));
    expect(Array.isArray(user.body)).toBe(true);
    expect(Array.isArray(loc.body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Concurrent request stress (same mocked AS)
// ---------------------------------------------------------------------------

describe('appservice TOKENMAXX concurrent request stress after #122', () => {
  it('handles many concurrent user lookups', async () => {
    authOk();
    getUserById.mockImplementation(async (_db: unknown, userId: string) =>
      userId.endsWith(':example.com') ? { user_id: userId } : null
    );

    const ids = Array.from({ length: 40 }, (_, i) => `@u${i}:${SERVER}`);
    const results = await Promise.all(
      ids.map((id) =>
        request(`/_matrix/app/v1/users/${encodeURIComponent(id)}`, bearer(AS_TOKEN))
      )
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getAppServiceByToken).toHaveBeenCalledTimes(40);
    expect(getUserById).toHaveBeenCalledTimes(40);
  });

  it('handles many concurrent alias lookups with mixed hits/misses', async () => {
    authOk();
    const aliases = Array.from({ length: 20 }, (_, i) => ({
      alias: `#hit${i}:${SERVER}`,
      room_id: `!r${i}:example.com`,
    }));
    const db = createAliasDb({ aliases });
    const env = makeEnv({ db });

    const paths = [
      ...aliases.map((a) => `/_matrix/app/v1/rooms/${encodeURIComponent(a.alias)}`),
      ...Array.from({ length: 20 }, (_, i) =>
        `/_matrix/app/v1/rooms/${encodeURIComponent(`#miss${i}:${SERVER}`)}`
      ),
    ];

    const results = await Promise.all(
      paths.map((path) => request(path, bearer(AS_TOKEN), env))
    );

    expect(results.slice(0, 20).every((r) => r.status === 200)).toBe(true);
    expect(results.slice(20).every((r) => r.status === 404)).toBe(true);
  });

  it('interleaves thirdparty stubs under concurrency without shared mutation', async () => {
    authOk();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => {
        const kind = i % 3;
        if (kind === 0) {
          return request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN));
        }
        if (kind === 1) {
          return request(`/_matrix/app/v1/thirdparty/user/irc`, bearer(AS_TOKEN));
        }
        return request(`/_matrix/app/v1/thirdparty/location/irc`, bearer(AS_TOKEN));
      })
    );

    for (const r of results) {
      expect(r.status).toBe(200);
    }
    // mutate first protocol body — others must stay clean
    const firstProtocol = results.find(
      (r) => r.body && typeof r.body === 'object' && !Array.isArray(r.body)
    );
    (firstProtocol!.body as { instances: unknown[] }).instances.push('x');
    const otherProtocols = results.filter(
      (r) =>
        r !== firstProtocol &&
        r.body &&
        typeof r.body === 'object' &&
        !Array.isArray(r.body)
    );
    for (const r of otherProtocols) {
      expect((r.body as { instances: unknown[] }).instances).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Registration id isolation (auth success does not depend on id)
// ---------------------------------------------------------------------------

describe('appservice TOKENMAXX registration id / protocol list isolation after #122', () => {
  it.each(['a', 'bridge', 'IRC-Bridge', 'com.example.as'])(
    'auth succeeds for registration id %s',
    async (id) => {
      getAppServiceByToken.mockResolvedValue({ ...BRIDGE_REG, id });
      getUserById.mockResolvedValue({ user_id: USER });
      const { status } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
      expect(status).toBe(200);
    }
  );

  it('rate_limited / protocols fields on registration do not affect HTTP responses', async () => {
    getAppServiceByToken.mockResolvedValue({
      ...BRIDGE_REG,
      rate_limited: true,
      protocols: ['irc', 'slack', 'telegram'],
    });
    getUserById.mockResolvedValue({ user_id: USER });
    const user = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    const proto = await request(
      `/_matrix/app/v1/thirdparty/protocol/irc`,
      bearer(AS_TOKEN)
    );
    expect(user.status).toBe(200);
    expect(proto.body).toEqual({
      user_fields: [],
      location_fields: [],
      field_types: {},
      instances: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Content-Type / body ignored on GETs
// ---------------------------------------------------------------------------

describe('appservice TOKENMAXX GET content-type / extra headers ignored after #122', () => {
  it('ignores Content-Type on users GET (no body — Request forbids GET bodies)', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER });
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${AS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Ignored': 'yes',
      },
    });
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('ignores Content-Type on rooms GET; still binds path alias', async () => {
    authOk();
    const db = createAliasDb({
      aliases: [{ alias: ALIAS, room_id: '!r:example.com' }],
    });
    const { status } = await request(
      `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${AS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(db.selects[0].args[0]).toBe(ALIAS);
  });
});

// ---------------------------------------------------------------------------
// Auth header whitespace / prefix edges
// ---------------------------------------------------------------------------

describe('appservice TOKENMAXX Authorization header edges after #122', () => {
  it('Fetch Headers trim leading whitespace before Bearer → auth lookup still runs', async () => {
    // undici trims header values, so " Bearer tok" becomes "Bearer tok"
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, {
      headers: { Authorization: ` Bearer ${AS_TOKEN}` },
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
    expect(getAppServiceByToken).toHaveBeenCalledWith(expect.anything(), AS_TOKEN);
  });

  it('accepts Bearer with tab? — only space after Bearer is specified; tab fails startsWith', async () => {
    const { status } = await request(`/_matrix/app/v1/users/${USER_ENC}`, {
      headers: { Authorization: `Bearer\t${AS_TOKEN}` },
    });
    // "Bearer\t..." does start with "Bearer " ? No — fourth char after Bearer is tab not space
    // Actually "Bearer\t".startsWith("Bearer ") is false because " " !== "\t"
    expect(status).toBe(401);
    expect(getAppServiceByToken).not.toHaveBeenCalled();
  });

  it('Bearer with multiple spaces includes the extra spaces in the token', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    await request(`/_matrix/app/v1/users/${USER_ENC}`, {
      headers: { Authorization: `Bearer  ${AS_TOKEN}` },
    });
    expect(getAppServiceByToken.mock.calls[0][1]).toBe(` ${AS_TOKEN}`);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: auth → user → alias → thirdparty sequence
// ---------------------------------------------------------------------------

describe('appservice TOKENMAXX sequential workflow after #122', () => {
  it('register-like AS session: probe user, probe alias, list protocol', async () => {
    const calls: string[] = [];
    getAppServiceByToken.mockImplementation(async () => {
      calls.push('auth');
      return BRIDGE_REG;
    });
    getUserById.mockImplementation(async () => {
      calls.push('user');
      return { user_id: USER };
    });
    const db = createAliasDb({
      aliases: [{ alias: ALIAS, room_id: '!r:example.com' }],
    });
    // wrap select to record
    const origPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      const origBind = stmt.bind.bind(stmt);
      return {
        bind(...args: unknown[]) {
          calls.push('alias');
          return origBind(...args);
        },
      };
    }) as typeof db.prepare;

    const env = makeEnv({ db });
    expect(
      (await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env)).status
    ).toBe(200);
    expect(
      (await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env)).status
    ).toBe(200);
    expect(
      (await request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN), env)).status
    ).toBe(200);

    expect(calls.filter((c) => c === 'auth')).toHaveLength(3);
    expect(calls.filter((c) => c === 'user')).toHaveLength(1);
    expect(calls.filter((c) => c === 'alias')).toHaveLength(1);
  });
});
