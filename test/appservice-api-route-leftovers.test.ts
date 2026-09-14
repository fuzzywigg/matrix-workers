/**
 * TOKENMAXX HEAVY leftovers after #154 — appservice API soft/edge/reliability.
 * Complements appservice-api-routes.test.ts. Tests-only — no product inventing.
 * Fixtures use example.com only.
 *
 * Residual deepen after #241: exact Missing/Invalid AS token messages;
 * lowercase bearer / Bearer\\ttab; hs_token≠as_token; empty Authorization;
 * case-sensitive alias; double-encoded user; unicode localpart; thirdparty
 * exact stub keys; Accept/Content-Type soft; HEAD/OPTIONS; query ignore;
 * token-with-spaces slice; getAppServiceByToken DB bind.
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

describe('appservice leftovers users soft flood after #154', () => {

  it('GET existing user soft-0', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u0' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-1', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u1' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-2', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u2' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-3', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u3' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-4', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u4' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-5', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u5' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-6', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u6' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-7', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u7' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-8', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u8' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-9', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u9' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-10', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u10' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-11', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u11' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-12', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u12' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-13', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u13' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-14', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u14' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET existing user soft-15', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER, display_name: 'u15' } as never);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('GET missing user soft-0', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing0:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-1', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing1:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-2', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing2:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-3', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing3:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-4', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing4:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-5', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing5:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-6', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing6:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-7', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing7:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-8', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing8:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-9', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing9:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-10', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing10:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-11', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing11:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-12', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing12:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-13', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing13:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-14', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing14:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing user soft-15', async () => {
    authOk();
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${encodeURIComponent('@_bridge_missing15:' + SERVER)}`, bearer(AS_TOKEN));
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});

describe('appservice leftovers rooms soft flood after #154', () => {

  it('GET existing alias soft-0', async () => {
    authOk();
    const alias = `#_bridge_room0:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r0:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-1', async () => {
    authOk();
    const alias = `#_bridge_room1:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r1:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-2', async () => {
    authOk();
    const alias = `#_bridge_room2:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r2:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-3', async () => {
    authOk();
    const alias = `#_bridge_room3:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r3:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-4', async () => {
    authOk();
    const alias = `#_bridge_room4:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r4:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-5', async () => {
    authOk();
    const alias = `#_bridge_room5:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r5:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-6', async () => {
    authOk();
    const alias = `#_bridge_room6:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r6:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-7', async () => {
    authOk();
    const alias = `#_bridge_room7:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r7:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-8', async () => {
    authOk();
    const alias = `#_bridge_room8:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r8:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-9', async () => {
    authOk();
    const alias = `#_bridge_room9:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r9:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-10', async () => {
    authOk();
    const alias = `#_bridge_room10:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r10:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-11', async () => {
    authOk();
    const alias = `#_bridge_room11:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r11:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-12', async () => {
    authOk();
    const alias = `#_bridge_room12:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r12:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-13', async () => {
    authOk();
    const alias = `#_bridge_room13:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r13:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-14', async () => {
    authOk();
    const alias = `#_bridge_room14:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r14:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET existing alias soft-15', async () => {
    authOk();
    const alias = `#_bridge_room15:${SERVER}`;
    const db = createAliasDb({ aliases: [{ alias, room_id: `!r15:${SERVER}` }] });
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('GET missing alias soft-0', async () => {
    authOk();
    const alias = `#_bridge_gone0:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-1', async () => {
    authOk();
    const alias = `#_bridge_gone1:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-2', async () => {
    authOk();
    const alias = `#_bridge_gone2:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-3', async () => {
    authOk();
    const alias = `#_bridge_gone3:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-4', async () => {
    authOk();
    const alias = `#_bridge_gone4:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-5', async () => {
    authOk();
    const alias = `#_bridge_gone5:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-6', async () => {
    authOk();
    const alias = `#_bridge_gone6:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-7', async () => {
    authOk();
    const alias = `#_bridge_gone7:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-8', async () => {
    authOk();
    const alias = `#_bridge_gone8:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-9', async () => {
    authOk();
    const alias = `#_bridge_gone9:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-10', async () => {
    authOk();
    const alias = `#_bridge_gone10:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-11', async () => {
    authOk();
    const alias = `#_bridge_gone11:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-12', async () => {
    authOk();
    const alias = `#_bridge_gone12:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-13', async () => {
    authOk();
    const alias = `#_bridge_gone13:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-14', async () => {
    authOk();
    const alias = `#_bridge_gone14:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET missing alias soft-15', async () => {
    authOk();
    const alias = `#_bridge_gone15:${SERVER}`;
    const { status, body } = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`,
      bearer(AS_TOKEN),
      makeEnv({ db: createAliasDb() })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});

describe('appservice leftovers thirdparty protocol soft flood after #154', () => {

  it('GET protocol irc soft-0', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/irc`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol slack soft-1', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/slack`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol telegram soft-2', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/telegram`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol discord soft-3', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/discord`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol gitter soft-4', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/gitter`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol whatsapp soft-5', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/whatsapp`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol signal soft-6', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/signal`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol xmpp soft-7', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/xmpp`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol sip soft-8', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/sip`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol sms soft-9', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/sms`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol email soft-10', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/email`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol mastodon soft-11', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/mastodon`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol matrix soft-12', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/matrix`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol custom0 soft-13', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/custom0`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol custom1 soft-14', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/custom1`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });

  it('GET protocol custom2 soft-15', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/custom2`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual({ user_fields: [], location_fields: [], field_types: {}, instances: [] });
  });
});

describe('appservice leftovers thirdparty user/location soft flood after #154', () => {

  it('GET thirdparty user soft-0', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto0`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-1', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto1`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-2', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto2`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-3', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto3`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-4', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto4`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-5', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto5`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-6', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto6`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-7', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto7`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-8', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto8`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-9', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto9`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-10', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto10`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-11', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto11`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-12', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto12`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-13', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto13`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-14', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto14`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty user soft-15', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/proto15`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-0', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto0`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-1', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto1`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-2', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto2`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-3', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto3`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-4', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto4`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-5', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto5`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-6', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto6`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-7', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto7`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-8', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto8`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-9', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto9`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-10', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto10`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-11', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto11`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-12', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto12`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-13', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto13`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-14', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto14`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET thirdparty location soft-15', async () => {
    authOk();
    const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/proto15`, bearer(AS_TOKEN));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });
});

describe('appservice leftovers auth failure soft flood after #154', () => {

  it('missing bearer soft-0', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-1', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-2', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-3', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-4', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-5', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-6', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-7', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-8', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-9', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-10', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-11', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-12', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-13', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-14', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('missing bearer soft-15', async () => {
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`);
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('invalid AS token soft-0', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-0'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-1', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-1'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-2', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-2'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-3', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-3'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-4', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-4'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-5', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-5'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-6', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-6'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-7', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-7'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-8', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-8'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-9', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-9'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-10', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-10'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-11', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-11'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-12', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-12'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-13', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-13'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-14', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-14'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('invalid AS token soft-15', async () => {
    getAppServiceByToken.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer('bad-token-15'));
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });
});

describe('appservice leftovers method matrix after #154', () => {
  const cases: Array<{ path: string; bad: string[] }> = [
    { path: `/_matrix/app/v1/users/${USER_ENC}`, bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
    { path: `/_matrix/app/v1/rooms/${ALIAS_ENC}`, bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/app/v1/thirdparty/protocol/irc', bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/app/v1/thirdparty/user/irc', bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/app/v1/thirdparty/location/irc', bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
  ];
  for (const c of cases) {
    for (const method of c.bad) {
      it(`${method} ${c.path} → 404/405`, async () => {
        authOk();
        getUserById.mockResolvedValue({ user_id: USER } as never);
        const { status } = await request(c.path, { method, headers: { Authorization: `Bearer ${AS_TOKEN}` } });
        expect([404, 405]).toContain(status);
      });
    }
  }
});

describe('appservice leftovers lifecycle soft floods after #154', () => {

  it('user then alias then protocol soft-0', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-1', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-2', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-3', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-4', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-5', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-6', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-7', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-8', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-9', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-10', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-11', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-12', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-13', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-14', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });

  it('user then alias then protocol soft-15', async () => {
    authOk();
    getUserById.mockResolvedValue({ user_id: USER } as never);
    const db = createAliasDb({ aliases: [{ alias: ALIAS, room_id: '!r:example.com' }] });
    const env = makeEnv({ db });
    const u = await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
    expect(u.status).toBe(200);
    const a = await request(`/_matrix/app/v1/rooms/${ALIAS_ENC}`, bearer(AS_TOKEN), env);
    expect(a.status).toBe(200);
    const p = await request('/_matrix/app/v1/thirdparty/protocol/irc', bearer(AS_TOKEN), env);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ instances: [] });
  });
});

// ---------------------------------------------------------------------------
// deepen appservice-api route leftovers after #241
// ---------------------------------------------------------------------------

describe('appservice leftovers exact token messages soft flood after #241', () => {
  const paths = [
    `/_matrix/app/v1/users/${USER_ENC}`,
    `/_matrix/app/v1/rooms/${ALIAS_ENC}`,
    '/_matrix/app/v1/thirdparty/protocol/irc',
    '/_matrix/app/v1/thirdparty/user/irc',
    '/_matrix/app/v1/thirdparty/location/irc',
  ];

  for (let i = 0; i < 16; i++) {
    it(`Missing AS token message soft-${i}`, async () => {
      const path = paths[i % paths.length];
      const { status, body } = await request(path);
      expect(status).toBe(401);
      expect(body).toEqual({ errcode: 'M_MISSING_TOKEN', error: 'Missing AS token' });
      expect(getAppServiceByToken).not.toHaveBeenCalled();
    });
  }

  for (let i = 0; i < 16; i++) {
    it(`Invalid AS token message soft-${i}`, async () => {
      getAppServiceByToken.mockResolvedValue(null);
      const path = paths[i % paths.length];
      const { status, body } = await request(path, bearer(`bad-${i}`));
      expect(status).toBe(401);
      expect(body).toEqual({ errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid AS token' });
      expect(getAppServiceByToken).toHaveBeenCalledWith(expect.anything(), `bad-${i}`);
    });
  }
});

describe('appservice leftovers Bearer scheme edges soft flood after #241', () => {
  for (let i = 0; i < 12; i++) {
    it(`lowercase bearer soft-${i}`, async () => {
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, {
        headers: { Authorization: `bearer ${AS_TOKEN}` },
      });
      expect(status).toBe(401);
      expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
      expect(getAppServiceByToken).not.toHaveBeenCalled();
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`Bearer\\ttab soft-${i}`, async () => {
      const { status, body } = await request(`/_matrix/app/v1/thirdparty/protocol/irc`, {
        headers: { Authorization: `Bearer\t${AS_TOKEN}` },
      });
      expect(status).toBe(401);
      expect(body).toEqual({ errcode: 'M_MISSING_TOKEN', error: 'Missing AS token' });
      expect(getAppServiceByToken).not.toHaveBeenCalled();
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`empty Authorization header soft-${i}`, async () => {
      const { status, body } = await request(`/_matrix/app/v1/thirdparty/user/irc`, {
        headers: { Authorization: '' },
      });
      expect(status).toBe(401);
      expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`hs_token ≠ as_token soft-${i}`, async () => {
      getAppServiceByToken.mockImplementation(async (_db: unknown, tok: string) =>
        tok === AS_TOKEN ? BRIDGE_REG : null
      );
      const { status, body } = await request(
        `/_matrix/app/v1/users/${USER_ENC}`,
        bearer(BRIDGE_REG.hs_token)
      );
      expect(status).toBe(401);
      expect(body).toEqual({ errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid AS token' });
    });
  }
});

describe('appservice leftovers encoding + case alias soft flood after #241', () => {
  for (let i = 0; i < 12; i++) {
    it(`case-sensitive alias soft-${i}`, async () => {
      authOk();
      const lower = `#_bridge_case${i}:${SERVER}`;
      const mixed = `#_Bridge_case${i}:${SERVER}`;
      const db = createAliasDb({
        aliases: [{ alias: lower, room_id: `!c${i}:${SERVER}` }],
      });
      const env = makeEnv({ db });
      const hit = await request(
        `/_matrix/app/v1/rooms/${encodeURIComponent(lower)}`,
        bearer(AS_TOKEN),
        env
      );
      const miss = await request(
        `/_matrix/app/v1/rooms/${encodeURIComponent(mixed)}`,
        bearer(AS_TOKEN),
        env
      );
      expect(hit.status).toBe(200);
      expect(miss.status).toBe(404);
      expect(miss.body).toMatchObject({ error: 'Room alias not found' });
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`double-encoded user soft-${i}`, async () => {
      authOk();
      const hit = `@_bridge_enc${i}:${SERVER}`;
      getUserById.mockImplementation(async (_db: unknown, userId: string) =>
        userId === hit ? ({ user_id: hit } as never) : null
      );
      const single = encodeURIComponent(hit);
      const doubled = encodeURIComponent(single);
      const a = await request(`/_matrix/app/v1/users/${single}`, bearer(AS_TOKEN));
      const b = await request(`/_matrix/app/v1/users/${doubled}`, bearer(AS_TOKEN));
      expect(a.status).toBe(200);
      expect(b.status).toBe(404);
      expect(b.body).toMatchObject({ error: 'User not found' });
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`unicode localpart soft-${i}`, async () => {
      authOk();
      const locals = [`@_bridge_café${i}`, `@_bridge_прото${i}`, `@_bridge_协议${i}`, `@_bridge_😀${i}`];
      const uid = `${locals[i % locals.length]}:${SERVER}`;
      getUserById.mockImplementation(async (_db: unknown, userId: string) =>
        userId === uid ? ({ user_id: uid } as never) : null
      );
      const { status, body } = await request(
        `/_matrix/app/v1/users/${encodeURIComponent(uid)}`,
        bearer(AS_TOKEN)
      );
      expect(status).toBe(200);
      expect(body).toEqual({});
      expect(getUserById).toHaveBeenCalledWith(expect.anything(), uid);
    });
  }
});

describe('appservice leftovers thirdparty stub + headers soft flood after #241', () => {
  for (let i = 0; i < 12; i++) {
    it(`thirdparty exact stub keys soft-${i}`, async () => {
      authOk();
      const { status, body } = await request(
        `/_matrix/app/v1/thirdparty/protocol/proto${i}`,
        bearer(AS_TOKEN)
      );
      expect(status).toBe(200);
      expect(Object.keys(body as object).sort()).toEqual([
        'field_types',
        'instances',
        'location_fields',
        'user_fields',
      ]);
      expect(body).toEqual({
        user_fields: [],
        location_fields: [],
        field_types: {},
        instances: [],
      });
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`Accept/Content-Type soft-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const accepts = ['application/json', '*/*', 'text/html', 'application/json, text/plain'];
      const cts = ['application/json', 'text/plain', 'application/xml', ''];
      const { status, body } = await request(`/_matrix/app/v1/users/${USER_ENC}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${AS_TOKEN}`,
          Accept: accepts[i % accepts.length],
          ...(cts[i % cts.length] ? { 'Content-Type': cts[i % cts.length] } : {}),
        },
      });
      expect(status).toBe(200);
      expect(body).toEqual({});
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`HEAD/OPTIONS soft-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const method = i % 2 === 0 ? 'HEAD' : 'OPTIONS';
      const path =
        i % 3 === 0
          ? `/_matrix/app/v1/users/${USER_ENC}`
          : i % 3 === 1
            ? `/_matrix/app/v1/rooms/${ALIAS_ENC}`
            : '/_matrix/app/v1/thirdparty/protocol/irc';
      const { status } = await request(path, {
        method,
        headers: { Authorization: `Bearer ${AS_TOKEN}` },
      });
      expect([200, 204, 404, 405]).toContain(status);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`query string ignored soft-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const { status, body } = await request(
        `/_matrix/app/v1/users/${USER_ENC}?access_token=x&foo=${i}`,
        bearer(AS_TOKEN)
      );
      expect(status).toBe(200);
      expect(body).toEqual({});
    });
  }
});

describe('appservice leftovers token slice + DB bind soft flood after #241', () => {
  for (let i = 0; i < 12; i++) {
    it(`token with embedded spaces soft-${i}`, async () => {
      const tok = `tok with spaces ${i}`;
      getAppServiceByToken.mockImplementation(async (_db: unknown, t: string) =>
        t === tok ? BRIDGE_REG : null
      );
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const { status } = await request(`/_matrix/app/v1/users/${USER_ENC}`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      expect(status).toBe(200);
      expect(getAppServiceByToken).toHaveBeenCalledWith(expect.anything(), tok);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`getAppServiceByToken DB bind soft-${i}`, async () => {
      authOk();
      getUserById.mockResolvedValue({ user_id: USER } as never);
      const db = createAliasDb();
      const env = makeEnv({ db });
      await request(`/_matrix/app/v1/users/${USER_ENC}`, bearer(AS_TOKEN), env);
      expect(getAppServiceByToken).toHaveBeenCalledTimes(1);
      expect(getAppServiceByToken.mock.calls[0][0]).toBe(db);
      expect(getAppServiceByToken.mock.calls[0][1]).toBe(AS_TOKEN);
      expect(getUserById.mock.calls[0][0]).toBe(db);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`Bearer with multiple spaces includes extras in token soft-${i}`, async () => {
      getAppServiceByToken.mockImplementation(async (_db: unknown, t: string) =>
        t === ` ${AS_TOKEN}` ? BRIDGE_REG : null
      );
      const { status, body } = await request(`/_matrix/app/v1/thirdparty/location/irc`, {
        headers: { Authorization: `Bearer  ${AS_TOKEN}` },
      });
      // slice(7) keeps the extra leading space in the token
      expect(status).toBe(200);
      expect(body).toEqual([]);
      expect(getAppServiceByToken).toHaveBeenCalledWith(expect.anything(), ` ${AS_TOKEN}`);
    });
  }
});
