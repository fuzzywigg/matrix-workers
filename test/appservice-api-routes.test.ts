/**
 * TOKENMAXX HEAVY deepen after #121–#123 — different slice: Application Service HS←AS HTTP routes.
 * Helpers already thick in appservice.test.ts; this exercises Hono app.request() for
 * `/_matrix/app/v1/*` (users, rooms, thirdparty stubs) including requireAppServiceAuth.
 * Avoids federation S2S (#122), relations (#123), voip/sync/sliding-sync (#117–#120).
 * Tests-only — no product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import type { AppServiceRegistration } from '../src/services/appservice';

import appserviceApp from '../src/api/appservice';

const SERVER = 'example.com';
const AS_TOKEN = 'as_token_secret_abc';
const HS_TOKEN = 'hs_token_secret_xyz';
const USER = '@alice:example.com';
const BRIDGE_USER = '@_bridge_bot:example.com';
const ALIAS = '#bridge:example.com';
const ROOM = '!room:example.com';
const NOW = 1_700_000_000_000;

const DEFAULT_REG: AppServiceRegistration = {
  id: 'bridge',
  url: 'https://bridge.example.com',
  as_token: AS_TOKEN,
  hs_token: HS_TOKEN,
  sender_localpart: '_bridge_bot',
  rate_limited: false,
  protocols: ['m.protocol.dummy'],
  namespaces: {
    users: [{ exclusive: true, regex: '^@_bridge_.*:example\\.com$' }],
    rooms: [],
    aliases: [{ exclusive: true, regex: '^#bridge.*:example\\.com$' }],
  },
};

type UserRow = {
  user_id: string;
  localpart: string;
  display_name: string | null;
  avatar_url: string | null;
  is_guest: number;
  is_deactivated: number;
  admin: number;
  created_at: number;
};

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

type AliasRow = { alias: string; room_id: string };

type AsDb = {
  registrations: AsRow[];
  users: UserRow[];
  aliases: AliasRow[];
  sqlLog: string[];
  bindLog: unknown[][];
};

function registrationToRow(reg: AppServiceRegistration): AsRow {
  return {
    id: reg.id,
    url: reg.url,
    as_token: reg.as_token,
    hs_token: reg.hs_token,
    sender_localpart: reg.sender_localpart,
    rate_limited: reg.rate_limited ? 1 : 0,
    protocols: reg.protocols.length ? JSON.stringify(reg.protocols) : null,
    namespaces: JSON.stringify(reg.namespaces),
  };
}

function createAsDb(opts: {
  registrations?: AppServiceRegistration[];
  users?: UserRow[];
  aliases?: AliasRow[];
} = {}): D1Database & { store: AsDb } {
  const store: AsDb = {
    registrations: (opts.registrations ?? [DEFAULT_REG]).map(registrationToRow),
    users: opts.users ?? [],
    aliases: opts.aliases ?? [],
    sqlLog: [],
    bindLog: [],
  };

  return {
    store,
    prepare(sql: string) {
      store.sqlLog.push(sql);
      return {
        bind(...args: unknown[]) {
          store.bindLog.push(args);
          return {
            async first<T>() {
              if (sql.includes('FROM appservice_registrations') && sql.includes('as_token')) {
                const [token] = args as [string];
                const row = store.registrations.find((r) => r.as_token === token);
                return (row ?? null) as T;
              }
              if (sql.includes('FROM users WHERE user_id')) {
                const [userId] = args as [string];
                const row = store.users.find((u) => u.user_id === userId);
                return (row ?? null) as T;
              }
              if (sql.includes('FROM room_aliases WHERE alias')) {
                const [alias] = args as [string];
                const row = store.aliases.find((a) => a.alias === alias);
                return (row ? { room_id: row.room_id } : null) as T;
              }
              return null as T;
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
  } as unknown as D1Database & { store: AsDb };
}

function seedUser(partial: Partial<UserRow> & { user_id: string }): UserRow {
  const localpart = partial.localpart ?? partial.user_id.slice(1).split(':')[0];
  return {
    user_id: partial.user_id,
    localpart,
    display_name: partial.display_name ?? null,
    avatar_url: partial.avatar_url ?? null,
    is_guest: partial.is_guest ?? 0,
    is_deactivated: partial.is_deactivated ?? 0,
    admin: partial.admin ?? 0,
    created_at: partial.created_at ?? NOW,
  };
}

function envFor(db: D1Database): Env {
  return { DB: db, SERVER_NAME: SERVER } as unknown as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  opts: {
    db?: D1Database & { store: AsDb };
    token?: string | null;
  } = {}
): Promise<{
  status: number;
  body: unknown;
  headers: Headers;
  text: string;
  db: D1Database & { store: AsDb };
}> {
  const db = opts.db ?? createAsDb();
  const headers = new Headers(init.headers);
  if (opts.token !== null) {
    const token = opts.token === undefined ? AS_TOKEN : opts.token;
    if (token !== undefined && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }
  const res = await appserviceApp.request(
    `http://localhost${path}`,
    { ...init, headers },
    envFor(db)
  );
  const text = await res.text();
  let body: unknown = text;
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json') || (text.startsWith('{') && text.endsWith('}'))) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } else if (text.startsWith('[') && text.endsWith(']')) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers, text, db };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-09-14T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Auth middleware (requireAppServiceAuth)
// ---------------------------------------------------------------------------

describe('appservice requireAppServiceAuth', () => {
  it('rejects missing Authorization header with M_MISSING_TOKEN', async () => {
    const res = await request('/_matrix/app/v1/users/' + encodeURIComponent(USER), {}, { token: null });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_TOKEN', error: 'Missing AS token' });
  });

  it('rejects non-Bearer Authorization schemes', async () => {
    const res = await request(
      '/_matrix/app/v1/users/' + encodeURIComponent(USER),
      { headers: { Authorization: `Basic ${AS_TOKEN}` } },
      { token: null }
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('treats empty Bearer (Headers-trimmed to "Bearer") as missing token', async () => {
    // Fetch Headers trims values, so `Bearer ${''}` becomes `Bearer` without trailing space.
    const res = await request(
      '/_matrix/app/v1/users/' + encodeURIComponent(USER),
      {},
      { token: '' }
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_TOKEN', error: 'Missing AS token' });
  });

  it('rejects unknown tokens that look token-shaped', async () => {
    const res = await request(
      '/_matrix/app/v1/users/' + encodeURIComponent(USER),
      {},
      { token: 'as_token_secret_ABCwrong' }
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid AS token' });
  });

  it('rejects unknown AS tokens with M_UNKNOWN_TOKEN', async () => {
    const res = await request(
      '/_matrix/app/v1/users/' + encodeURIComponent(USER),
      {},
      { token: 'not-a-real-token' }
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid AS token' });
  });

  it('looks up appservice_registrations by as_token (not hs_token)', async () => {
    const db = createAsDb();
    await request('/_matrix/app/v1/thirdparty/protocol/x', {}, { db, token: AS_TOKEN });
    expect(db.store.sqlLog.some((s) => s.includes('as_token'))).toBe(true);
    expect(db.store.bindLog.some((b) => b[0] === AS_TOKEN)).toBe(true);
    // hs_token alone must not authenticate
    const bad = await request('/_matrix/app/v1/thirdparty/protocol/x', {}, { db, token: HS_TOKEN });
    expect(bad.status).toBe(401);
    expect(bad.body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('accepts a valid AS token and proceeds to the handler', async () => {
    const res = await request('/_matrix/app/v1/thirdparty/protocol/irc');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });

  it('maps rate_limited + null protocols through getAppServiceByToken for auth', async () => {
    const db = createAsDb({
      registrations: [
        {
          ...DEFAULT_REG,
          id: 'rl',
          as_token: 'rl_tok',
          rate_limited: true,
          protocols: [],
        },
      ],
    });
    // Force protocols null in the row (registrationToRow uses null for empty)
    db.store.registrations[0].protocols = null;
    db.store.registrations[0].rate_limited = 1;
    const res = await request('/_matrix/app/v1/thirdparty/user/x', {}, { db, token: 'rl_tok' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('Authorization is case-sensitive on the Bearer prefix', async () => {
    const res = await request(
      '/_matrix/app/v1/thirdparty/protocol/x',
      { headers: { Authorization: `bearer ${AS_TOKEN}` } },
      { token: null }
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });
});

// ---------------------------------------------------------------------------
// GET /_matrix/app/v1/users/:userId
// ---------------------------------------------------------------------------

describe('appservice GET /_matrix/app/v1/users/:userId', () => {
  it('returns {} when the user exists', async () => {
    const db = createAsDb({ users: [seedUser({ user_id: USER, display_name: 'Alice' })] });
    const res = await request(`/_matrix/app/v1/users/${encodeURIComponent(USER)}`, {}, { db });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('returns M_NOT_FOUND when the user is missing', async () => {
    const res = await request(`/_matrix/app/v1/users/${encodeURIComponent(USER)}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'User not found' });
  });

  it('percent-decodes the userId path param', async () => {
    const db = createAsDb({ users: [seedUser({ user_id: BRIDGE_USER })] });
    const res = await request(
      `/_matrix/app/v1/users/${encodeURIComponent(BRIDGE_USER)}`,
      {},
      { db }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.store.bindLog.some((b) => b[0] === BRIDGE_USER)).toBe(true);
  });

  it('does not leak user profile fields in the success body', async () => {
    const db = createAsDb({
      users: [
        seedUser({
          user_id: USER,
          display_name: 'Secret',
          avatar_url: 'mxc://example.com/x',
          admin: 1,
        }),
      ],
    });
    const res = await request(`/_matrix/app/v1/users/${encodeURIComponent(USER)}`, {}, { db });
    expect(res.body).toEqual({});
    expect(JSON.stringify(res.body)).not.toContain('Secret');
    expect(JSON.stringify(res.body)).not.toContain('avatar');
  });

  it('treats deactivated users as still existing (empty object)', async () => {
    const db = createAsDb({
      users: [seedUser({ user_id: USER, is_deactivated: 1 })],
    });
    const res = await request(`/_matrix/app/v1/users/${encodeURIComponent(USER)}`, {}, { db });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('treats guest users as existing', async () => {
    const db = createAsDb({
      users: [seedUser({ user_id: '@guest1:example.com', is_guest: 1, localpart: 'guest1' })],
    });
    const res = await request(
      `/_matrix/app/v1/users/${encodeURIComponent('@guest1:example.com')}`,
      {},
      { db }
    );
    expect(res.status).toBe(200);
  });

  it('requires auth before checking the user', async () => {
    const db = createAsDb({ users: [seedUser({ user_id: USER })] });
    const res = await request(
      `/_matrix/app/v1/users/${encodeURIComponent(USER)}`,
      {},
      { db, token: null }
    );
    expect(res.status).toBe(401);
    expect(db.store.sqlLog.every((s) => !s.includes('FROM users'))).toBe(true);
  });

  it('queries users by exact user_id bind', async () => {
    const db = createAsDb({ users: [seedUser({ user_id: USER })] });
    await request(`/_matrix/app/v1/users/${encodeURIComponent(USER)}`, {}, { db });
    const userBinds = db.store.bindLog.filter((_, i) =>
      db.store.sqlLog[i]?.includes('FROM users WHERE user_id')
    );
    // bindLog aligns with prepare+bind order; find the users query bind
    expect(db.store.bindLog.some((b) => b[0] === USER)).toBe(true);
    void userBinds;
  });

  it('does not match a different user_id', async () => {
    const db = createAsDb({ users: [seedUser({ user_id: USER })] });
    const res = await request(
      `/_matrix/app/v1/users/${encodeURIComponent('@bob:example.com')}`,
      {},
      { db }
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /_matrix/app/v1/rooms/:roomAlias
// ---------------------------------------------------------------------------

describe('appservice GET /_matrix/app/v1/rooms/:roomAlias', () => {
  it('returns {} when the alias exists', async () => {
    const db = createAsDb({ aliases: [{ alias: ALIAS, room_id: ROOM }] });
    const res = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(ALIAS)}`,
      {},
      { db }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('returns M_NOT_FOUND when the alias is missing', async () => {
    const res = await request(`/_matrix/app/v1/rooms/${encodeURIComponent(ALIAS)}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Room alias not found' });
  });

  it('percent-decodes the roomAlias path param', async () => {
    const db = createAsDb({ aliases: [{ alias: ALIAS, room_id: ROOM }] });
    const res = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(ALIAS)}`,
      {},
      { db }
    );
    expect(res.status).toBe(200);
    expect(db.store.bindLog.some((b) => b[0] === ALIAS)).toBe(true);
  });

  it('does not leak room_id in the success body', async () => {
    const db = createAsDb({ aliases: [{ alias: ALIAS, room_id: ROOM }] });
    const res = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(ALIAS)}`,
      {},
      { db }
    );
    expect(res.body).toEqual({});
    expect(JSON.stringify(res.body)).not.toContain(ROOM);
  });

  it('requires auth before alias lookup', async () => {
    const db = createAsDb({ aliases: [{ alias: ALIAS, room_id: ROOM }] });
    const res = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(ALIAS)}`,
      {},
      { db, token: null }
    );
    expect(res.status).toBe(401);
    expect(db.store.sqlLog.every((s) => !s.includes('room_aliases'))).toBe(true);
  });

  it('matches aliases exactly (no prefix match)', async () => {
    const db = createAsDb({ aliases: [{ alias: ALIAS, room_id: ROOM }] });
    const res = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent('#bridge')}`,
      {},
      { db }
    );
    expect(res.status).toBe(404);
  });

  it('supports aliases with unusual characters when encoded', async () => {
    const weird = '#café:example.com';
    const db = createAsDb({ aliases: [{ alias: weird, room_id: ROOM }] });
    const res = await request(
      `/_matrix/app/v1/rooms/${encodeURIComponent(weird)}`,
      {},
      { db }
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Third-party protocol stubs
// ---------------------------------------------------------------------------

describe('appservice GET /_matrix/app/v1/thirdparty/protocol/:protocol', () => {
  it('returns empty protocol info stub for any protocol id', async () => {
    const res = await request('/_matrix/app/v1/thirdparty/protocol/irc');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user_fields: [],
      location_fields: [],
      field_types: {},
      instances: [],
    });
  });

  it('does not hit D1 beyond auth for protocol info', async () => {
    const db = createAsDb();
    await request('/_matrix/app/v1/thirdparty/protocol/slack', {}, { db });
    expect(db.store.sqlLog.filter((s) => s.includes('appservice_registrations'))).toHaveLength(1);
    expect(db.store.sqlLog.every((s) => !s.includes('users') && !s.includes('room_aliases'))).toBe(
      true
    );
  });

  it('percent-decodes protocol path segments', async () => {
    const res = await request(`/_matrix/app/v1/thirdparty/protocol/${encodeURIComponent('m.irc')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ field_types: {} });
  });

  it('requires AS auth', async () => {
    const res = await request('/_matrix/app/v1/thirdparty/protocol/irc', {}, { token: null });
    expect(res.status).toBe(401);
  });

  it('returns the same stub shape for empty-looking protocol names', async () => {
    const res = await request('/_matrix/app/v1/thirdparty/protocol/x');
    expect(res.body).toEqual({
      user_fields: [],
      location_fields: [],
      field_types: {},
      instances: [],
    });
  });
});

describe('appservice GET /_matrix/app/v1/thirdparty/user/:protocol', () => {
  it('returns an empty array stub', async () => {
    const res = await request('/_matrix/app/v1/thirdparty/user/irc');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('ignores query string filters (stub)', async () => {
    const res = await request('/_matrix/app/v1/thirdparty/user/irc?userid=alice&fields=nick');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('requires AS auth', async () => {
    const res = await request('/_matrix/app/v1/thirdparty/user/irc', {}, { token: null });
    expect(res.status).toBe(401);
  });

  it('works for arbitrary protocol path values', async () => {
    const res = await request('/_matrix/app/v1/thirdparty/user/gitter');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('appservice GET /_matrix/app/v1/thirdparty/location/:protocol', () => {
  it('returns an empty array stub', async () => {
    const res = await request('/_matrix/app/v1/thirdparty/location/irc');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('ignores query string filters (stub)', async () => {
    const res = await request('/_matrix/app/v1/thirdparty/location/irc?alias=%23chan');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('requires AS auth', async () => {
    const res = await request('/_matrix/app/v1/thirdparty/location/irc', {}, { token: null });
    expect(res.status).toBe(401);
  });

  it('works for arbitrary protocol path values', async () => {
    const res = await request('/_matrix/app/v1/thirdparty/location/telegram');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Method / routing probes
// ---------------------------------------------------------------------------

describe('appservice route method probes', () => {
  const paths = [
    `/_matrix/app/v1/users/${encodeURIComponent(USER)}`,
    `/_matrix/app/v1/rooms/${encodeURIComponent(ALIAS)}`,
    '/_matrix/app/v1/thirdparty/protocol/irc',
    '/_matrix/app/v1/thirdparty/user/irc',
    '/_matrix/app/v1/thirdparty/location/irc',
  ];

  for (const path of paths) {
    it(`rejects POST on ${path}`, async () => {
      const res = await request(path, { method: 'POST', body: '{}' });
      expect(res.status).toBe(404);
    });

    it(`rejects PUT on ${path}`, async () => {
      const res = await request(path, { method: 'PUT', body: '{}' });
      expect(res.status).toBe(404);
    });

    it(`rejects DELETE on ${path}`, async () => {
      const res = await request(path, { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  }

  it('returns 404 for unknown app/v1 paths even with valid auth', async () => {
    const res = await request('/_matrix/app/v1/ping');
    expect(res.status).toBe(404);
  });

  it('does not mount client API paths on the appservice app', async () => {
    const res = await request('/_matrix/client/v3/account/whoami');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Multi-registration / token isolation
// ---------------------------------------------------------------------------

describe('appservice multi-registration token isolation', () => {
  it('authenticates only the matching registration token', async () => {
    const other: AppServiceRegistration = {
      ...DEFAULT_REG,
      id: 'other',
      as_token: 'other_tok',
      sender_localpart: 'otherbot',
    };
    const db = createAsDb({
      registrations: [DEFAULT_REG, other],
      users: [seedUser({ user_id: USER })],
    });

    const ok = await request(
      `/_matrix/app/v1/users/${encodeURIComponent(USER)}`,
      {},
      { db, token: 'other_tok' }
    );
    expect(ok.status).toBe(200);

    const bad = await request(
      `/_matrix/app/v1/users/${encodeURIComponent(USER)}`,
      {},
      { db, token: 'missing' }
    );
    expect(bad.status).toBe(401);
  });

  it('first matching as_token wins when duplicates exist', async () => {
    const dupA: AppServiceRegistration = { ...DEFAULT_REG, id: 'a', as_token: 'dup' };
    const dupB: AppServiceRegistration = { ...DEFAULT_REG, id: 'b', as_token: 'dup' };
    const db = createAsDb({ registrations: [dupA, dupB] });
    // createAsDb find() returns first match — auth succeeds
    const res = await request('/_matrix/app/v1/thirdparty/protocol/x', {}, { db, token: 'dup' });
    expect(res.status).toBe(200);
  });
});
