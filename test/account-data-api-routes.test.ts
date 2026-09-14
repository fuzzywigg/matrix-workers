/**
 * TOKENMAXX HEAVY deepen — account-data HTTP routes (account leftover after #124 devices).
 * Different slice than devices, federation keys/events/S2S, sliding-sync, sync, voip,
 * rooms, oidc, media, relations/threads. Prefer account leftovers over login/push/oauth.
 * Avoids helpers already covered in account-data-helpers.test.ts.
 * Tests-only — no product inventing.
 * Exercises global/room GET+PUT via Hono app.request() with D1/KV/USER_KEYS stubs,
 * isKVAccountData classification, stream ||1, membership exactness, SQL binds,
 * put→get lifecycles, and E2EE DO/KV/D1 fallback ordering.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

import accountDataApp from '../src/api/account-data';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!room:example.com';
const USER_ENC = encodeURIComponent(USER);
const BOB_ENC = encodeURIComponent(BOB);
const ROOM_ENC = encodeURIComponent(ROOM);

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(
  data: Record<string, string> = {},
  opts: { throwOnGet?: boolean; throwOnPut?: boolean } = {}
) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  const kv = {
    data,
    puts,
    deletes,
    get: async (key: string, type?: string) => {
      if (opts.throwOnGet) {
        throw new Error('KV get failed');
      }
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      if (opts.throwOnPut) {
        throw new Error('KV put failed');
      }
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      deletes.push(key);
      delete data[key];
    },
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
    deletes: string[];
  };
}

type AccountDataRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
};

type Membership = { room_id: string; user_id: string; membership: string };

type ChangeRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  stream_position: number;
};

type SqlCall = { sql: string; args: unknown[] };

function createUserKeysStub(opts: {
  accountData?: Record<string, unknown | null>;
  failGet?: boolean;
  failPut?: boolean;
  throwOnFetch?: boolean;
} = {}) {
  const accountData: Record<string, unknown | null> = { ...(opts.accountData ?? {}) };
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];

  const stub = {
    fetches,
    accountData,
    async fetch(req: Request): Promise<Response> {
      if (opts.throwOnFetch) {
        throw new Error('DO network failure');
      }
      const url = new URL(req.url);
      const path = url.pathname;
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      fetches.push({ url: req.url, method: req.method, body });

      if (opts.failGet && path.endsWith('/account-data/get')) {
        return new Response('boom', { status: 500 });
      }
      if (opts.failPut && path.endsWith('/account-data/put')) {
        return new Response('boom', { status: 500 });
      }

      if (path === '/account-data/get') {
        const eventType = url.searchParams.get('event_type');
        if (eventType) {
          if (!(eventType in accountData)) {
            return Response.json(null);
          }
          return Response.json(accountData[eventType]);
        }
        return Response.json(accountData);
      }

      if (path === '/account-data/put') {
        const b = body as { event_type: string; content: unknown };
        accountData[b.event_type] = b.content;
        return Response.json({ success: true });
      }

      return new Response('not found', { status: 404 });
    },
  };

  return stub;
}

function createAccountDataDb(opts: {
  rows?: AccountDataRow[];
  memberships?: Membership[];
  streamPositions?: Record<string, number>;
  /** When true, SELECT position returns null (missing stream_positions row). */
  missingStreamRow?: boolean;
  throwOnAccountDataInsert?: boolean;
} = {}) {
  const rows = [...(opts.rows ?? [])];
  const memberships = [...(opts.memberships ?? [])];
  const streamPositions = { ...(opts.streamPositions ?? { account_data: 10 }) };
  const changes: ChangeRow[] = [];

  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const runs: SqlCall[] = [];
  const firsts: SqlCall[] = [];

  const db = {
    rows,
    memberships,
    streamPositions,
    changes,
    inserts,
    updates,
    runs,
    firsts,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              firsts.push({ sql, args });

              if (sql.includes('SELECT position FROM stream_positions')) {
                if (opts.missingStreamRow) return null as T;
                const name = args[0] as string;
                if (!(name in streamPositions)) return null as T;
                return { position: streamPositions[name] } as T;
              }

              if (sql.includes('SELECT membership FROM room_memberships')) {
                const [roomId, userId] = args as [string, string];
                const hit = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                if (!hit) return null;
                return { membership: hit.membership } as T;
              }

              if (
                sql.includes('SELECT content FROM account_data') &&
                sql.includes("room_id = ''")
              ) {
                const [userId, eventType] = args as [string, string];
                const hit = rows.find(
                  (r) =>
                    r.user_id === userId &&
                    r.event_type === eventType &&
                    r.room_id === ''
                );
                if (!hit) return null;
                return { content: hit.content } as T;
              }

              if (sql.includes('SELECT content FROM account_data')) {
                const [userId, roomId, eventType] = args as [string, string, string];
                const hit = rows.find(
                  (r) =>
                    r.user_id === userId &&
                    r.room_id === roomId &&
                    r.event_type === eventType
                );
                if (!hit) return null;
                return { content: hit.content } as T;
              }

              return null;
            },

            async all<T>() {
              return { results: [] as T[] };
            },

            async run(): Promise<{
              meta: { changes: number; last_row_id: number };
              success: boolean;
            }> {
              runs.push({ sql, args });

              if (sql.includes('UPDATE stream_positions SET position = position + 1')) {
                updates.push({ sql, args });
                const name = args[0] as string;
                streamPositions[name] = (streamPositions[name] ?? 0) + 1;
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('INSERT INTO account_data_changes')) {
                inserts.push({ sql, args });
                const [userId, roomId, eventType, streamPosition] = args as [
                  string,
                  string,
                  string,
                  number,
                ];
                changes.push({
                  user_id: userId,
                  room_id: roomId,
                  event_type: eventType,
                  stream_position: streamPosition,
                });
                return {
                  success: true,
                  meta: { changes: 1, last_row_id: changes.length },
                };
              }

              if (sql.includes('INSERT INTO account_data')) {
                if (opts.throwOnAccountDataInsert) {
                  throw new Error('account_data insert failed');
                }
                inserts.push({ sql, args });
                // Global PUT uses VALUES (?, '', ?, ?) — room_id is a SQL literal.
                // Room PUT uses VALUES (?, ?, ?, ?) with room_id bound.
                const isGlobalLiteral =
                  sql.includes("VALUES (?, '', ?, ?)") || sql.includes("VALUES (?, '',?,?)");
                let userId: string;
                let roomId: string;
                let eventType: string;
                let content: string;
                if (isGlobalLiteral) {
                  [userId, eventType, content] = args as [string, string, string];
                  roomId = '';
                } else {
                  [userId, roomId, eventType, content] = args as [
                    string,
                    string,
                    string,
                    string,
                  ];
                }
                const existing = rows.find(
                  (r) =>
                    r.user_id === userId &&
                    r.room_id === roomId &&
                    r.event_type === eventType
                );
                if (existing) {
                  existing.content = content;
                } else {
                  rows.push({
                    user_id: userId,
                    room_id: roomId,
                    event_type: eventType,
                    content,
                  });
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              throw new Error(
                `Unhandled SQL in account-data route stub: ${sql.slice(0, 160)}`
              );
            },
          };
        },
      };
    },
  };

  return db;
}

type AccountDb = ReturnType<typeof createAccountDataDb>;
type UserKeysStub = ReturnType<typeof createUserKeysStub>;
type AccountKv = ReturnType<typeof mockKv>;

function createEnv(opts: {
  db?: AccountDb;
  accountDataKv?: AccountKv;
  userKeys?: UserKeysStub;
} = {}) {
  const db = opts.db ?? createAccountDataDb();
  const accountDataKv = opts.accountDataKv ?? mockKv();
  const userKeys = opts.userKeys ?? createUserKeysStub();

  const env = {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
    ACCOUNT_DATA: accountDataKv,
    USER_KEYS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => userKeys,
    },
    _db: db,
    _accountData: accountDataKv,
    _userKeys: userKeys,
  };

  return env as unknown as Env & typeof env;
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; headers: Headers; text: string }> {
  const res = await accountDataApp.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers, text };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function globalPath(userIdEnc: string, type: string): string {
  return `/_matrix/client/v3/user/${userIdEnc}/account_data/${encodeURIComponent(type)}`;
}

function roomPath(userIdEnc: string, roomIdEnc: string, type: string): string {
  return `/_matrix/client/v3/user/${userIdEnc}/rooms/${roomIdEnc}/account_data/${encodeURIComponent(type)}`;
}

function joinedDb(extra: Partial<Parameters<typeof createAccountDataDb>[0]> = {}) {
  return createAccountDataDb({
    memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    ...extra,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET global account_data/:type
// ---------------------------------------------------------------------------

describe('account-data GET global /user/:userId/account_data/:type', () => {
  it('forbids reading another user account data', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, 'm.direct'));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(env._userKeys.fetches).toHaveLength(0);
  });

  it('returns E2EE type from Durable Object on hit', async () => {
    const userKeys = createUserKeysStub({
      accountData: { 'm.secret_storage.default_key': { key: 'ssk' } },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: 'ssk' });
    expect(userKeys.fetches[0].url).toContain('event_type=');
    expect(userKeys.fetches[0].url).toContain(encodeURIComponent('m.secret_storage.default_key'));
  });

  it('falls back to KV when DO returns null for m.secret_storage.key.*', async () => {
    const userKeys = createUserKeysStub({ accountData: {} });
    const accountDataKv = mockKv({
      [`global:${USER}:m.secret_storage.key.ABCDEF`]: JSON.stringify({
        algorithm: 'm.secret_storage.v1.aes-hmac-sha2',
      }),
    });
    const env = createEnv({ userKeys, accountDataKv });
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.key.ABCDEF'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ algorithm: 'm.secret_storage.v1.aes-hmac-sha2' });
    expect(userKeys.fetches).toHaveLength(1);
  });

  it('falls back to KV when DO get fails for m.cross_signing.master', async () => {
    const userKeys = createUserKeysStub({ failGet: true });
    const accountDataKv = mockKv({
      [`global:${USER}:m.cross_signing.master`]: JSON.stringify({ keys: { 'ed25519:a': 'x' } }),
    });
    const env = createEnv({ userKeys, accountDataKv });
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.master'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ keys: { 'ed25519:a': 'x' } });
  });

  it('falls back to KV when DO fetch throws for m.cross_signing.self_signing', async () => {
    const userKeys = createUserKeysStub({ throwOnFetch: true });
    const accountDataKv = mockKv({
      [`global:${USER}:m.cross_signing.self_signing`]: JSON.stringify({ usage: ['self_signing'] }),
    });
    const env = createEnv({ userKeys, accountDataKv });
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.self_signing'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ usage: ['self_signing'] });
  });

  it('falls back to D1 when DO miss and KV miss for m.megolm_backup.v1', async () => {
    const userKeys = createUserKeysStub({ accountData: {} });
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.megolm_backup.v1',
          content: JSON.stringify({ algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2' }),
        },
      ],
    });
    const env = createEnv({ userKeys, db, accountDataKv: mockKv() });
    const res = await request(env, globalPath(USER_ENC, 'm.megolm_backup.v1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2' });
  });

  it('falls back to D1 when DO throws and KV miss for m.cross_signing.user_signing', async () => {
    const userKeys = createUserKeysStub({ failGet: true });
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.cross_signing.user_signing',
          content: JSON.stringify({ usage: ['user_signing'] }),
        },
      ],
    });
    const env = createEnv({ userKeys, db });
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.user_signing'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ usage: ['user_signing'] });
  });

  it('returns 404 when E2EE type misses DO, KV, and D1', async () => {
    const env = createEnv({
      userKeys: createUserKeysStub({ accountData: {} }),
      accountDataKv: mockKv(),
      db: createAccountDataDb(),
    });
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('returns {} when E2EE D1 fallback content is corrupt JSON', async () => {
    const userKeys = createUserKeysStub({ accountData: {} });
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.secret_storage.default_key',
          content: '{not-json',
        },
      ],
    });
    const env = createEnv({ userKeys, db });
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('returns non-E2EE type from D1', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ [BOB]: [ROOM] }),
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ [BOB]: [ROOM] });
    expect(env._userKeys.fetches).toHaveLength(0);
  });

  it('returns 404 for missing non-E2EE type', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.ignored_user_list'));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      errcode: 'M_NOT_FOUND',
      error: 'Account data not found',
    });
  });

  it('returns {} when non-E2EE D1 content is corrupt JSON', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'im.vector.setting.breadcrumbs',
          content: 'not-json}}}',
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'im.vector.setting.breadcrumbs'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('treats m.cross_signing* prefix as E2EE (DO consulted)', async () => {
    const userKeys = createUserKeysStub({
      accountData: { 'm.cross_signing.something_custom': { ok: true } },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.something_custom'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(userKeys.fetches).toHaveLength(1);
  });

  it('does not treat near-miss megolm type as E2EE (no DO)', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.megolm_backup.v1.extra',
          content: JSON.stringify({ x: 1 }),
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.megolm_backup.v1.extra'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ x: 1 });
    expect(env._userKeys.fetches).toHaveLength(0);
  });

  it('decodes percent-encoded userId and type path segments', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.tag',
          content: JSON.stringify({ tags: {} }),
        },
      ],
    });
    const env = createEnv({ db });
    // USER_ENC already encodes @ and :
    const res = await request(env, globalPath(USER_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: {} });
  });
});

// ---------------------------------------------------------------------------
// PUT global account_data/:type
// ---------------------------------------------------------------------------

describe('account-data PUT global /user/:userId/account_data/:type', () => {
  it('forbids writing another user account data', async () => {
    const env = createEnv();
    const res = await request(
      env,
      globalPath(BOB_ENC, 'm.direct'),
      jsonInit('PUT', { [BOB]: [ROOM] })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(env._db.inserts).toHaveLength(0);
  });

  it('rejects bad JSON body', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('stores normal type in D1 and bumps account_data stream', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 5 } });
    const env = createEnv({ db });
    const payload = { ignored_users: { [BOB]: {} } };
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.ignored_user_list'),
      jsonInit('PUT', payload)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.rows).toEqual([
      {
        user_id: USER,
        room_id: '',
        event_type: 'm.ignored_user_list',
        content: JSON.stringify(payload),
      },
    ]);
    expect(db.streamPositions.account_data).toBe(6);
    expect(db.changes).toEqual([
      {
        user_id: USER,
        room_id: '',
        event_type: 'm.ignored_user_list',
        stream_position: 6,
      },
    ]);
    expect(env._userKeys.fetches).toHaveLength(0);
    expect(env._accountData.puts).toHaveLength(0);
  });

  it('stores E2EE type in DO then KV then D1 with stream change', async () => {
    const userKeys = createUserKeysStub();
    const accountDataKv = mockKv();
    const db = createAccountDataDb({ streamPositions: { account_data: 1 } });
    const env = createEnv({ userKeys, accountDataKv, db });
    const content = { key: 'defaultKeyId' };
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.secret_storage.default_key'),
      jsonInit('PUT', content)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(userKeys.fetches).toHaveLength(1);
    expect(userKeys.fetches[0].method).toBe('POST');
    expect(userKeys.fetches[0].url).toContain('/account-data/put');
    expect(userKeys.fetches[0].body).toEqual({
      event_type: 'm.secret_storage.default_key',
      content,
    });
    expect(userKeys.accountData['m.secret_storage.default_key']).toEqual(content);
    expect(accountDataKv.puts).toEqual([
      {
        key: `global:${USER}:m.secret_storage.default_key`,
        value: JSON.stringify(content),
        options: undefined,
      },
    ]);
    expect(db.rows[0]).toMatchObject({
      user_id: USER,
      room_id: '',
      event_type: 'm.secret_storage.default_key',
      content: JSON.stringify(content),
    });
    expect(db.changes[0]).toMatchObject({
      event_type: 'm.secret_storage.default_key',
      stream_position: 2,
    });
  });

  it('returns 503 M_UNKNOWN when DO put fails and skips KV/D1', async () => {
    const userKeys = createUserKeysStub({ failPut: true });
    const accountDataKv = mockKv();
    const db = createAccountDataDb();
    const env = createEnv({ userKeys, accountDataKv, db });
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.megolm_backup.v1'),
      jsonInit('PUT', { algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2' })
    );
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      errcode: 'M_UNKNOWN',
      error: 'Failed to store E2EE data',
    });
    expect(accountDataKv.puts).toHaveLength(0);
    expect(db.rows).toHaveLength(0);
    expect(db.changes).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it('returns 503 when DO put throws (network) before D1', async () => {
    const userKeys = createUserKeysStub({ throwOnFetch: true });
    const db = createAccountDataDb();
    const accountDataKv = mockKv();
    const env = createEnv({ userKeys, db, accountDataKv });
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.cross_signing.master'),
      jsonInit('PUT', { keys: {} })
    );
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN' });
    expect(db.rows).toHaveLength(0);
    expect(accountDataKv.puts).toHaveLength(0);
  });

  it('still stores m.secret_storage.default_key with unusual content (no key prop)', async () => {
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createEnv({ userKeys, db });
    const unusual = { partial: true, nested: { a: 1 } };
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.secret_storage.default_key'),
      jsonInit('PUT', unusual)
    );
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.secret_storage.default_key']).toEqual(unusual);
    expect(db.rows[0].content).toBe(JSON.stringify(unusual));
  });

  it('still stores m.secret_storage.default_key when content is a string', async () => {
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createEnv({ userKeys, db });
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.secret_storage.default_key'),
      jsonInit('PUT', 'not-an-object')
    );
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.secret_storage.default_key']).toBe('not-an-object');
  });

  it('still stores m.secret_storage.key.* with unusual content (no algorithm)', async () => {
    const userKeys = createUserKeysStub();
    const accountDataKv = mockKv();
    const db = createAccountDataDb();
    const env = createEnv({ userKeys, accountDataKv, db });
    const unusual = { passphrase: { iterations: 1 } };
    const type = 'm.secret_storage.key.NOALGO';
    const res = await request(env, globalPath(USER_ENC, type), jsonInit('PUT', unusual));
    expect(res.status).toBe(200);
    expect(userKeys.accountData[type]).toEqual(unusual);
    expect(accountDataKv.data[`global:${USER}:${type}`]).toBe(JSON.stringify(unusual));
    expect(db.rows[0].event_type).toBe(type);
  });

  it('still stores m.secret_storage.key.* when content is null', async () => {
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createEnv({ userKeys, db });
    const type = 'm.secret_storage.key.NULLISH';
    const res = await request(env, globalPath(USER_ENC, type), jsonInit('PUT', null));
    expect(res.status).toBe(200);
    expect(userKeys.accountData[type]).toBeNull();
    expect(db.rows[0].content).toBe('null');
  });

  it('updates existing global row via ON CONFLICT', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ old: true }),
        },
      ],
      streamPositions: { account_data: 20 },
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.direct'),
      jsonInit('PUT', { [BOB]: [ROOM] })
    );
    expect(res.status).toBe(200);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].content).toBe(JSON.stringify({ [BOB]: [ROOM] }));
    expect(db.changes[0].stream_position).toBe(21);
    expect(db.inserts.some((c) => c.sql.includes('ON CONFLICT'))).toBe(true);
  });

  it('stores valid m.secret_storage.key.* with algorithm in DO+KV+D1', async () => {
    const userKeys = createUserKeysStub();
    const accountDataKv = mockKv();
    const db = createAccountDataDb();
    const env = createEnv({ userKeys, accountDataKv, db });
    const type = 'm.secret_storage.key.VALID';
    const content = {
      algorithm: 'm.secret_storage.v1.aes-hmac-sha2',
      iv: 'iv',
      mac: 'mac',
    };
    const res = await request(env, globalPath(USER_ENC, type), jsonInit('PUT', content));
    expect(res.status).toBe(200);
    expect(userKeys.accountData[type]).toEqual(content);
    expect(accountDataKv.puts[0].key).toBe(`global:${USER}:${type}`);
    expect(db.rows[0].content).toBe(JSON.stringify(content));
  });

  it('stores m.cross_signing.self_signing via E2EE path', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const content = { usage: ['self_signing'], keys: { 'ed25519:x': 'pub' } };
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.cross_signing.self_signing'),
      jsonInit('PUT', content)
    );
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.cross_signing.self_signing']).toEqual(content);
    expect(env._accountData.puts).toHaveLength(1);
    expect(env._db.changes).toHaveLength(1);
  });

  it('records stream UPDATE then SELECT then account_data_changes INSERT order', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 100 } });
    const env = createEnv({ db });
    await request(env, globalPath(USER_ENC, 'm.push_rules'), jsonInit('PUT', { global: {} }));
    const sqls = db.runs.map((r) => r.sql);
    const updateIdx = sqls.findIndex((s) =>
      s.includes('UPDATE stream_positions SET position = position + 1')
    );
    const changeIdx = sqls.findIndex((s) => s.includes('INSERT INTO account_data_changes'));
    const insertIdx = sqls.findIndex((s) => s.includes('INSERT INTO account_data'));
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(insertIdx);
    expect(changeIdx).toBeGreaterThan(updateIdx);
    expect(db.firsts.some((f) => f.sql.includes('SELECT position FROM stream_positions'))).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// GET room account_data
// ---------------------------------------------------------------------------

describe('account-data GET room /user/:userId/rooms/:roomId/account_data/:type', () => {
  it('forbids reading another user room account data', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(env, roomPath(BOB_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot access other users account data',
    });
  });

  it('forbids when user has no membership row', async () => {
    const env = createEnv({ db: createAccountDataDb({ memberships: [] }) });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'User not in room',
    });
  });

  it('forbids when membership is invite', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.fully_read'));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN', error: 'User not in room' });
  });

  it('forbids when membership is leave', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbids when membership is ban', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(403);
  });

  it('returns room account data when joined', async () => {
    const db = joinedDb({
      rows: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: JSON.stringify({ tags: { favourite: { order: 0.5 } } }),
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { favourite: { order: 0.5 } } });
  });

  it('returns 404 when joined but type missing', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.fully_read'));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('returns {} when room account data JSON is corrupt', async () => {
    const db = joinedDb({
      rows: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: '{corrupt',
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('does not return global account data for room GET', async () => {
    const db = joinedDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.tag',
          content: JSON.stringify({ tags: { global: true } }),
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT room account_data
// ---------------------------------------------------------------------------

describe('account-data PUT room /user/:userId/rooms/:roomId/account_data/:type', () => {
  it('forbids writing another user room account data', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(
      env,
      roomPath(BOB_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: {} })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot modify other users account data',
    });
  });

  it('forbids when not a room member', async () => {
    const env = createEnv({ db: createAccountDataDb() });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: { lowpriority: {} } })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN', error: 'User not in room' });
  });

  it('forbids put when membership is invite', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.fully_read'),
      jsonInit('PUT', { event_id: '$e' })
    );
    expect(res.status).toBe(403);
  });

  it('forbids put when membership is leave', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: {} })
    );
    expect(res.status).toBe(403);
  });

  it('rejects bad JSON body', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('stores room account data and records stream change', async () => {
    const db = joinedDb({ streamPositions: { account_data: 7 } });
    const env = createEnv({ db });
    const payload = { tags: { favourite: { order: 0.1 } } };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', payload)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.rows).toEqual([
      {
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify(payload),
      },
    ]);
    expect(db.streamPositions.account_data).toBe(8);
    expect(db.changes).toEqual([
      {
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        stream_position: 8,
      },
    ]);
    expect(env._userKeys.fetches).toHaveLength(0);
    expect(env._accountData.puts).toHaveLength(0);
  });

  it('updates existing room account data via ON CONFLICT', async () => {
    const db = joinedDb({
      rows: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.fully_read',
          content: JSON.stringify({ event_id: '$old' }),
        },
      ],
      streamPositions: { account_data: 50 },
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.fully_read'),
      jsonInit('PUT', { event_id: '$new' })
    );
    expect(res.status).toBe(200);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].content).toBe(JSON.stringify({ event_id: '$new' }));
    expect(db.changes[0]).toMatchObject({
      room_id: ROOM,
      event_type: 'm.fully_read',
      stream_position: 51,
    });
  });

  it('uses room_id in INSERT binds (not empty string)', async () => {
    const db = joinedDb();
    const env = createEnv({ db });
    await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'com.example.custom'),
      jsonInit('PUT', { v: 1 })
    );
    const insert = db.inserts.find((c) => c.sql.includes('INSERT INTO account_data'));
    expect(insert?.args).toEqual([
      USER,
      ROOM,
      'com.example.custom',
      JSON.stringify({ v: 1 }),
    ]);
  });

  it('checks membership before parsing body (invite never writes)', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: { should_not_store: {} } })
    );
    expect(res.status).toBe(403);
    expect(db.rows).toHaveLength(0);
    expect(db.changes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting / edge
// ---------------------------------------------------------------------------

describe('account-data route edges', () => {
  it('GET E2EE prefers DO over KV even when both present', async () => {
    const userKeys = createUserKeysStub({
      accountData: { 'm.secret_storage.default_key': { key: 'from-do' } },
    });
    const accountDataKv = mockKv({
      [`global:${USER}:m.secret_storage.default_key`]: JSON.stringify({ key: 'from-kv' }),
    });
    const env = createEnv({ userKeys, accountDataKv });
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: 'from-do' });
  });

  it('GET E2EE prefers KV over D1 when DO misses', async () => {
    const userKeys = createUserKeysStub({ accountData: {} });
    const accountDataKv = mockKv({
      [`global:${USER}:m.megolm_backup.v1`]: JSON.stringify({ from: 'kv' }),
    });
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.megolm_backup.v1',
          content: JSON.stringify({ from: 'd1' }),
        },
      ],
    });
    const env = createEnv({ userKeys, accountDataKv, db });
    const res = await request(env, globalPath(USER_ENC, 'm.megolm_backup.v1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ from: 'kv' });
  });

  it('GET E2EE treats DO undefined-equivalent null as miss', async () => {
    const userKeys = createUserKeysStub({
      accountData: { 'm.secret_storage.default_key': null },
    });
    const accountDataKv = mockKv({
      [`global:${USER}:m.secret_storage.default_key`]: JSON.stringify({ key: 'kv-after-null' }),
    });
    const env = createEnv({ userKeys, accountDataKv });
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: 'kv-after-null' });
  });

  it('global PUT does not require room membership', async () => {
    const env = createEnv({ db: createAccountDataDb({ memberships: [] }) });
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.direct'),
      jsonInit('PUT', { [BOB]: [ROOM] })
    );
    expect(res.status).toBe(200);
    expect(env._db.rows).toHaveLength(1);
  });

  it('room GET does not hit USER_KEYS DO', async () => {
    const db = joinedDb({
      rows: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.secret_storage.default_key',
          content: JSON.stringify({ key: 'room-level-odd' }),
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.secret_storage.default_key')
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: 'room-level-odd' });
    expect(env._userKeys.fetches).toHaveLength(0);
  });

  it('empty object body is valid JSON for global PUT', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', {}));
    expect(res.status).toBe(200);
    expect(env._db.rows[0].content).toBe('{}');
  });

  it('array body is stored for non-E2EE global PUT', async () => {
    const env = createEnv();
    const res = await request(
      env,
      globalPath(USER_ENC, 'org.example.list'),
      jsonInit('PUT', [1, 2, 3])
    );
    expect(res.status).toBe(200);
    expect(env._db.rows[0].content).toBe('[1,2,3]');
  });
});

// ---------------------------------------------------------------------------
// TOKENMAXX HEAVY leftovers after #124 (devices) — account-data route edges
// ---------------------------------------------------------------------------

describe('account-data isKVAccountData classification matrix after #124', () => {
  const e2eeHits = [
    'm.secret_storage.default_key',
    'm.secret_storage.key.ABC',
    'm.secret_storage',
    'm.secret_storage.anything.else',
    'm.cross_signing.master',
    'm.cross_signing.self_signing',
    'm.cross_signing.user_signing',
    'm.cross_signing',
    'm.cross_signing.custom',
    'm.megolm_backup.v1',
  ];

  const e2eeMisses = [
    'm.direct',
    'm.ignored_user_list',
    'm.fully_read',
    'm.tag',
    'm.push_rules',
    'm.megolm_backup',
    'm.megolm_backup.v1.extra',
    'm.megolm_backup.v2',
    'm.secret_storag',
    'm.cross_signin',
    'im.vector.setting.breadcrumbs',
    'org.example.custom',
    'secret_storage.default_key',
    'cross_signing.master',
  ];

  for (const type of e2eeHits) {
    it(`GET consults DO for E2EE type ${type}`, async () => {
      const userKeys = createUserKeysStub({
        accountData: { [type]: { via: 'do', type } },
      });
      const env = createEnv({ userKeys });
      const res = await request(env, globalPath(USER_ENC, type));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ via: 'do', type });
      expect(userKeys.fetches).toHaveLength(1);
      expect(userKeys.fetches[0].url).toContain('/account-data/get');
    });

    it(`PUT writes DO+KV for E2EE type ${type}`, async () => {
      const userKeys = createUserKeysStub();
      const accountDataKv = mockKv();
      const db = createAccountDataDb();
      const env = createEnv({ userKeys, accountDataKv, db });
      const content = { written: type };
      const res = await request(env, globalPath(USER_ENC, type), jsonInit('PUT', content));
      expect(res.status).toBe(200);
      expect(userKeys.accountData[type]).toEqual(content);
      expect(accountDataKv.data[`global:${USER}:${type}`]).toBe(JSON.stringify(content));
      expect(db.rows[0]).toMatchObject({
        user_id: USER,
        room_id: '',
        event_type: type,
        content: JSON.stringify(content),
      });
    });
  }

  for (const type of e2eeMisses) {
    it(`GET skips DO for non-E2EE type ${type}`, async () => {
      const db = createAccountDataDb({
        rows: [
          {
            user_id: USER,
            room_id: '',
            event_type: type,
            content: JSON.stringify({ via: 'd1', type }),
          },
        ],
      });
      const env = createEnv({ db });
      const res = await request(env, globalPath(USER_ENC, type));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ via: 'd1', type });
      expect(env._userKeys.fetches).toHaveLength(0);
    });

    it(`PUT skips DO+KV for non-E2EE type ${type}`, async () => {
      const userKeys = createUserKeysStub();
      const accountDataKv = mockKv();
      const db = createAccountDataDb();
      const env = createEnv({ userKeys, accountDataKv, db });
      const content = { written: type };
      const res = await request(env, globalPath(USER_ENC, type), jsonInit('PUT', content));
      expect(res.status).toBe(200);
      expect(userKeys.fetches).toHaveLength(0);
      expect(accountDataKv.puts).toHaveLength(0);
      expect(db.rows[0].content).toBe(JSON.stringify(content));
    });
  }
});

describe('account-data GET fallback ordering leftovers after #124', () => {
  it('falls back to D1 when KV get throws after DO miss', async () => {
    const userKeys = createUserKeysStub({ accountData: {} });
    const accountDataKv = mockKv({}, { throwOnGet: true });
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.secret_storage.default_key',
          content: JSON.stringify({ key: 'from-d1-after-kv-throw' }),
        },
      ],
    });
    const env = createEnv({ userKeys, accountDataKv, db });
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: 'from-d1-after-kv-throw' });
  });

  it('falls back to D1 when KV get throws after DO fetch throws', async () => {
    const userKeys = createUserKeysStub({ throwOnFetch: true });
    const accountDataKv = mockKv({}, { throwOnGet: true });
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.cross_signing.master',
          content: JSON.stringify({ keys: { recovered: true } }),
        },
      ],
    });
    const env = createEnv({ userKeys, accountDataKv, db });
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.master'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ keys: { recovered: true } });
  });

  it('returns 404 when DO miss, KV throws, and D1 miss', async () => {
    const env = createEnv({
      userKeys: createUserKeysStub({ accountData: {} }),
      accountDataKv: mockKv({}, { throwOnGet: true }),
      db: createAccountDataDb(),
    });
    const res = await request(env, globalPath(USER_ENC, 'm.megolm_backup.v1'));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      errcode: 'M_NOT_FOUND',
      error: 'Account data not found',
    });
  });

  it('GET E2EE binds D1 with empty room_id literal path', async () => {
    const userKeys = createUserKeysStub({ accountData: {} });
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.secret_storage.default_key',
          content: JSON.stringify({ key: 'k' }),
        },
      ],
    });
    const env = createEnv({ userKeys, db, accountDataKv: mockKv() });
    await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'));
    const select = db.firsts.find(
      (f) => f.sql.includes('SELECT content FROM account_data') && f.sql.includes("room_id = ''")
    );
    expect(select?.args).toEqual([USER, 'm.secret_storage.default_key']);
  });

  it('GET non-E2EE binds only userId + eventType (empty room_id in SQL)', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({}),
        },
      ],
    });
    const env = createEnv({ db });
    await request(env, globalPath(USER_ENC, 'm.direct'));
    const select = db.firsts.find((f) => f.sql.includes('SELECT content FROM account_data'));
    expect(select?.args).toEqual([USER, 'm.direct']);
    expect(select?.sql).toContain("room_id = ''");
  });

  it('prefers DO empty object over KV (empty object is not null/undefined)', async () => {
    const userKeys = createUserKeysStub({
      accountData: { 'm.secret_storage.default_key': {} },
    });
    const accountDataKv = mockKv({
      [`global:${USER}:m.secret_storage.default_key`]: JSON.stringify({ key: 'kv' }),
    });
    const env = createEnv({ userKeys, accountDataKv });
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('prefers DO false boolean over KV (false is not null/undefined)', async () => {
    const userKeys = createUserKeysStub({
      accountData: { 'm.cross_signing.master': false },
    });
    const accountDataKv = mockKv({
      [`global:${USER}:m.cross_signing.master`]: JSON.stringify({ keys: {} }),
    });
    const env = createEnv({ userKeys, accountDataKv });
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.master'));
    expect(res.status).toBe(200);
    expect(res.body).toBe(false);
  });

  it('prefers DO zero number over KV', async () => {
    const userKeys = createUserKeysStub({
      accountData: { 'm.megolm_backup.v1': 0 },
    });
    const accountDataKv = mockKv({
      [`global:${USER}:m.megolm_backup.v1`]: JSON.stringify({ algorithm: 'x' }),
    });
    const env = createEnv({ userKeys, accountDataKv });
    const res = await request(env, globalPath(USER_ENC, 'm.megolm_backup.v1'));
    expect(res.status).toBe(200);
    expect(res.body).toBe(0);
  });

  it('prefers DO empty string over KV', async () => {
    const userKeys = createUserKeysStub({
      accountData: { 'm.secret_storage.key.X': '' },
    });
    const accountDataKv = mockKv({
      [`global:${USER}:m.secret_storage.key.X`]: JSON.stringify({ algorithm: 'a' }),
    });
    const env = createEnv({ userKeys, accountDataKv });
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.key.X'));
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
  });

  it('treats empty KV string as miss and falls through to D1', async () => {
    // ACCOUNT_DATA.get returns '' which is falsy → skip JSON.parse path
    const userKeys = createUserKeysStub({ accountData: {} });
    const accountDataKv = mockKv({
      [`global:${USER}:m.secret_storage.default_key`]: '',
    });
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.secret_storage.default_key',
          content: JSON.stringify({ key: 'd1' }),
        },
      ],
    });
    const env = createEnv({ userKeys, accountDataKv, db });
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: 'd1' });
  });

  it('encodes event_type query param on DO get including reserved chars', async () => {
    const type = 'm.secret_storage.key.A+B/C';
    const userKeys = createUserKeysStub({
      accountData: { [type]: { algorithm: 'm.secret_storage.v1.aes-hmac-sha2' } },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, globalPath(USER_ENC, type));
    expect(res.status).toBe(200);
    expect(userKeys.fetches[0].url).toContain(`event_type=${encodeURIComponent(type)}`);
  });
});

describe('account-data PUT stream position || 1 leftovers after #124', () => {
  it('uses stream position 1 when stream_positions row is missing', async () => {
    const db = createAccountDataDb({
      streamPositions: {},
      missingStreamRow: true,
    });
    // UPDATE still bumps an in-memory counter, but SELECT returns null → || 1
    const env = createEnv({ db });
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.direct'),
      jsonInit('PUT', { [BOB]: [ROOM] })
    );
    expect(res.status).toBe(200);
    expect(db.changes[0].stream_position).toBe(1);
  });

  it('uses stream position 1 when SELECT returns position 0 (falsy || 1)', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: -1 } });
    // After UPDATE: -1+1=0; SELECT returns 0; recordAccountDataChange uses 0||1 → 1
    const env = createEnv({ db });
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.ignored_user_list'),
      jsonInit('PUT', { ignored_users: {} })
    );
    expect(res.status).toBe(200);
    expect(db.streamPositions.account_data).toBe(0);
    expect(db.changes[0].stream_position).toBe(1);
  });

  it('room PUT also uses || 1 when stream row missing', async () => {
    const db = joinedDb({ streamPositions: {}, missingStreamRow: true });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: { favourite: {} } })
    );
    expect(res.status).toBe(200);
    expect(db.changes[0]).toMatchObject({
      room_id: ROOM,
      event_type: 'm.tag',
      stream_position: 1,
    });
  });

  it('two sequential global PUTs increment stream by 1 each', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 40 } });
    const env = createEnv({ db });
    await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { a: 1 }));
    await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { a: 2 }));
    expect(db.streamPositions.account_data).toBe(42);
    expect(db.changes.map((c) => c.stream_position)).toEqual([41, 42]);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].content).toBe(JSON.stringify({ a: 2 }));
  });

  it('global and room PUTs share the same account_data stream', async () => {
    const db = joinedDb({ streamPositions: { account_data: 0 } });
    // start 0 → after first UPDATE becomes 1; SELECT 1 (truthy)
    const env = createEnv({ db });
    await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', {}));
    await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.fully_read'),
      jsonInit('PUT', { event_id: '$e' })
    );
    expect(db.streamPositions.account_data).toBe(2);
    expect(db.changes[0].room_id).toBe('');
    expect(db.changes[1].room_id).toBe(ROOM);
    expect(db.changes.map((c) => c.stream_position)).toEqual([1, 2]);
  });

  it('binds stream_name account_data on UPDATE and SELECT', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 3 } });
    const env = createEnv({ db });
    await request(env, globalPath(USER_ENC, 'm.push_rules'), jsonInit('PUT', { global: {} }));
    const update = db.updates.find((u) =>
      u.sql.includes('UPDATE stream_positions SET position = position + 1')
    );
    expect(update?.args).toEqual(['account_data']);
    const select = db.firsts.find((f) => f.sql.includes('SELECT position FROM stream_positions'));
    expect(select?.args).toEqual(['account_data']);
  });
});

describe('account-data PUT body type leftovers after #124', () => {
  const bodies: Array<{ label: string; body: unknown; encoded: string }> = [
    { label: 'boolean true', body: true, encoded: 'true' },
    { label: 'boolean false', body: false, encoded: 'false' },
    { label: 'number zero', body: 0, encoded: '0' },
    { label: 'number negative', body: -1, encoded: '-1' },
    { label: 'number float', body: 1.5, encoded: '1.5' },
    { label: 'string empty', body: '', encoded: '""' },
    { label: 'string unicode', body: '日本語🎉', encoded: JSON.stringify('日本語🎉') },
    { label: 'null', body: null, encoded: 'null' },
    { label: 'nested object', body: { a: { b: [1, null, false] } }, encoded: JSON.stringify({ a: { b: [1, null, false] } }) },
    { label: 'empty array', body: [], encoded: '[]' },
    { label: 'mixed array', body: [1, 'x', null, {}], encoded: JSON.stringify([1, 'x', null, {}]) },
  ];

  for (const { label, body, encoded } of bodies) {
    it(`global non-E2EE PUT stores ${label}`, async () => {
      const db = createAccountDataDb();
      const env = createEnv({ db });
      const res = await request(
        env,
        globalPath(USER_ENC, 'org.example.payload'),
        jsonInit('PUT', body)
      );
      expect(res.status).toBe(200);
      expect(db.rows[0].content).toBe(encoded);
    });

    it(`room PUT stores ${label}`, async () => {
      const db = joinedDb();
      const env = createEnv({ db });
      const res = await request(
        env,
        roomPath(USER_ENC, ROOM_ENC, 'org.example.payload'),
        jsonInit('PUT', body)
      );
      expect(res.status).toBe(200);
      expect(db.rows[0].content).toBe(encoded);
      expect(db.rows[0].room_id).toBe(ROOM);
    });

    it(`E2EE PUT stores ${label} in DO+KV+D1`, async () => {
      const userKeys = createUserKeysStub();
      const accountDataKv = mockKv();
      const db = createAccountDataDb();
      const env = createEnv({ userKeys, accountDataKv, db });
      const type = 'm.cross_signing.master';
      const res = await request(env, globalPath(USER_ENC, type), jsonInit('PUT', body));
      expect(res.status).toBe(200);
      expect(userKeys.accountData[type]).toEqual(body);
      expect(accountDataKv.data[`global:${USER}:${type}`]).toBe(encoded);
      expect(db.rows[0].content).toBe(encoded);
    });
  }

  it('rejects empty body as M_BAD_JSON on global PUT', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects empty body as M_BAD_JSON on room PUT', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects whitespace-only body as M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '   ',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
});

describe('account-data secret_storage validation soft-warn leftovers after #124', () => {
  it('stores valid default_key with string key property', async () => {
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createEnv({ userKeys, db });
    const content = { key: 'ssk_valid' };
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.secret_storage.default_key'),
      jsonInit('PUT', content)
    );
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.secret_storage.default_key']).toEqual(content);
  });

  it('stores default_key when key is non-string (still no reject)', async () => {
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createEnv({ userKeys, db });
    const content = { key: 12345 };
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.secret_storage.default_key'),
      jsonInit('PUT', content)
    );
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.secret_storage.default_key']).toEqual(content);
  });

  it('stores default_key when key is empty string (truthy check fails → warn path)', async () => {
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createEnv({ userKeys, db });
    const content = { key: '' };
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.secret_storage.default_key'),
      jsonInit('PUT', content)
    );
    expect(res.status).toBe(200);
    expect(db.rows[0].content).toBe(JSON.stringify(content));
  });

  it('stores secret_storage.key.* when algorithm is non-string', async () => {
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createEnv({ userKeys, db });
    const type = 'm.secret_storage.key.BADALGO';
    const content = { algorithm: 99, iv: 'x' };
    const res = await request(env, globalPath(USER_ENC, type), jsonInit('PUT', content));
    expect(res.status).toBe(200);
    expect(userKeys.accountData[type]).toEqual(content);
  });

  it('stores secret_storage.key.* when algorithm is empty string', async () => {
    const userKeys = createUserKeysStub();
    const db = createAccountDataDb();
    const env = createEnv({ userKeys, db });
    const type = 'm.secret_storage.key.EMPTYALGO';
    const content = { algorithm: '' };
    const res = await request(env, globalPath(USER_ENC, type), jsonInit('PUT', content));
    expect(res.status).toBe(200);
    expect(userKeys.accountData[type]).toEqual(content);
  });

  it('logs m.megolm* content path without treating non-exact as E2EE storage', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const userKeys = createUserKeysStub();
    const accountDataKv = mockKv();
    const db = createAccountDataDb();
    const env = createEnv({ userKeys, accountDataKv, db });
    // near-miss: starts with m.megolm for logging, but isKVAccountData requires exact m.megolm_backup.v1
    const type = 'm.megolm_backup.v1.extra';
    const res = await request(env, globalPath(USER_ENC, type), jsonInit('PUT', { x: 1 }));
    expect(res.status).toBe(200);
    expect(userKeys.fetches).toHaveLength(0);
    expect(accountDataKv.puts).toHaveLength(0);
    expect(db.rows[0].event_type).toBe(type);
    spy.mockRestore();
  });
});

describe('account-data room membership exactness leftovers after #124', () => {
  const nonJoin = ['invite', 'leave', 'ban', 'knock', 'JOIN', 'Join', 'joined', ''];

  for (const membership of nonJoin) {
    it(`GET forbids membership=${JSON.stringify(membership)}`, async () => {
      const db = createAccountDataDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership }],
        rows: [
          {
            user_id: USER,
            room_id: ROOM,
            event_type: 'm.tag',
            content: JSON.stringify({ tags: {} }),
          },
        ],
      });
      const env = createEnv({ db });
      const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'User not in room',
      });
    });

    it(`PUT forbids membership=${JSON.stringify(membership)}`, async () => {
      const db = createAccountDataDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership }],
      });
      const env = createEnv({ db });
      const res = await request(
        env,
        roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
        jsonInit('PUT', { tags: { favourite: {} } })
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'User not in room',
      });
      expect(db.rows).toHaveLength(0);
      expect(db.changes).toHaveLength(0);
    });
  }

  it('GET membership check binds roomId then userId', async () => {
    const db = joinedDb();
    const env = createEnv({ db });
    await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    const membershipSelect = db.firsts.find((f) =>
      f.sql.includes('SELECT membership FROM room_memberships')
    );
    expect(membershipSelect?.args).toEqual([ROOM, USER]);
  });

  it('PUT membership check binds roomId then userId before insert', async () => {
    const db = joinedDb();
    const env = createEnv({ db });
    await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: {} })
    );
    const membershipSelect = db.firsts.find((f) =>
      f.sql.includes('SELECT membership FROM room_memberships')
    );
    expect(membershipSelect?.args).toEqual([ROOM, USER]);
    const insert = db.inserts.find((c) => c.sql.includes('INSERT INTO account_data'));
    expect(insert?.args[0]).toBe(USER);
    expect(insert?.args[1]).toBe(ROOM);
  });

  it('does not use membership from a different room', async () => {
    const other = '!other:example.com';
    const db = createAccountDataDb({
      memberships: [{ room_id: other, user_id: USER, membership: 'join' }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(403);
  });

  it('does not use another user join for requester membership', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: BOB, membership: 'join' }],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: {} })
    );
    expect(res.status).toBe(403);
  });
});

describe('account-data URL decode leftovers after #124', () => {
  it('decodes percent-encoded room id on GET', async () => {
    const roomId = '!weird room:example.com';
    const db = createAccountDataDb({
      memberships: [{ room_id: roomId, user_id: USER, membership: 'join' }],
      rows: [
        {
          user_id: USER,
          room_id: roomId,
          event_type: 'm.tag',
          content: JSON.stringify({ tags: { favourite: {} } }),
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, encodeURIComponent(roomId), 'm.tag')
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { favourite: {} } });
    const membershipSelect = db.firsts.find((f) =>
      f.sql.includes('SELECT membership FROM room_memberships')
    );
    expect(membershipSelect?.args[0]).toBe(roomId);
  });

  it('decodes percent-encoded room id on PUT', async () => {
    const roomId = '!r/with/slashes:example.com';
    const db = createAccountDataDb({
      memberships: [{ room_id: roomId, user_id: USER, membership: 'join' }],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, encodeURIComponent(roomId), 'm.fully_read'),
      jsonInit('PUT', { event_id: '$x' })
    );
    expect(res.status).toBe(200);
    expect(db.rows[0].room_id).toBe(roomId);
  });

  it('decodes percent-encoded event type with dots and unicode', async () => {
    const type = 'org.example.설정.データ';
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ ok: true }),
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, type));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('decodes userId that was percent-encoded (already USER_ENC)', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ ok: 1 }),
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    const select = db.firsts.find((f) => f.sql.includes('SELECT content FROM account_data'));
    expect(select?.args[0]).toBe(USER);
  });

  it('forbids when decoded userId differs from auth even if path looks similar', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(encodeURIComponent('@alicex:example.com'), 'm.direct'));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot access other users account data',
    });
  });

  it('PUT forbidden message is modify-specific', async () => {
    const env = createEnv();
    const res = await request(
      env,
      globalPath(BOB_ENC, 'm.direct'),
      jsonInit('PUT', {})
    );
    expect(res.body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot modify other users account data',
    });
  });

  it('room GET forbidden for other user uses access wording', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(env, roomPath(BOB_ENC, ROOM_ENC, 'm.tag'));
    expect(res.body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot access other users account data',
    });
  });

  it('room PUT forbidden for other user uses modify wording', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(
      env,
      roomPath(BOB_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: {} })
    );
    expect(res.body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot modify other users account data',
    });
  });
});

describe('account-data put→get lifecycle leftovers after #124', () => {
  it('global non-E2EE put then get round-trips content', async () => {
    const db = createAccountDataDb();
    const env = createEnv({ db });
    const payload = { ignored_users: { [BOB]: {} } };
    const put = await request(
      env,
      globalPath(USER_ENC, 'm.ignored_user_list'),
      jsonInit('PUT', payload)
    );
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, 'm.ignored_user_list'));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(payload);
  });

  it('E2EE put then get prefers DO over D1/KV', async () => {
    const userKeys = createUserKeysStub();
    const accountDataKv = mockKv();
    const db = createAccountDataDb();
    const env = createEnv({ userKeys, accountDataKv, db });
    const content = { key: 'lifecycle' };
    await request(
      env,
      globalPath(USER_ENC, 'm.secret_storage.default_key'),
      jsonInit('PUT', content)
    );
    const get = await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(content);
    expect(userKeys.fetches.filter((f) => f.method === 'POST')).toHaveLength(1);
    expect(userKeys.fetches.filter((f) => f.method === 'GET')).toHaveLength(1);
  });

  it('room put then get round-trips tags', async () => {
    const db = joinedDb();
    const env = createEnv({ db });
    const payload = { tags: { favourite: { order: 0.25 }, lowpriority: {} } };
    await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'), jsonInit('PUT', payload));
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(payload);
  });

  it('overwriting global type replaces content and appends change rows', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 1 } });
    const env = createEnv({ db });
    await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { v: 1 }));
    await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { v: 2 }));
    expect(db.rows).toHaveLength(1);
    expect(JSON.parse(db.rows[0].content)).toEqual({ v: 2 });
    expect(db.changes).toHaveLength(2);
  });

  it('global and room rows with same event_type stay isolated', async () => {
    const db = joinedDb();
    const env = createEnv({ db });
    await request(
      env,
      globalPath(USER_ENC, 'm.tag'),
      jsonInit('PUT', { tags: { global: true } })
    );
    await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: { room: true } })
    );
    expect(db.rows).toHaveLength(2);
    const globalGet = await request(env, globalPath(USER_ENC, 'm.tag'));
    const roomGet = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(globalGet.body).toEqual({ tags: { global: true } });
    expect(roomGet.body).toEqual({ tags: { room: true } });
  });

  it('two rooms keep independent account data', async () => {
    const room2 = '!room2:example.com';
    const db = createAccountDataDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: room2, user_id: USER, membership: 'join' },
      ],
    });
    const env = createEnv({ db });
    await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.fully_read'),
      jsonInit('PUT', { event_id: '$a' })
    );
    await request(
      env,
      roomPath(USER_ENC, encodeURIComponent(room2), 'm.fully_read'),
      jsonInit('PUT', { event_id: '$b' })
    );
    const a = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.fully_read'));
    const b = await request(
      env,
      roomPath(USER_ENC, encodeURIComponent(room2), 'm.fully_read')
    );
    expect(a.body).toEqual({ event_id: '$a' });
    expect(b.body).toEqual({ event_id: '$b' });
  });
});

describe('account-data SQL bind + errcode vocabulary leftovers after #124', () => {
  it('global PUT INSERT binds [userId, eventType, content] with empty room literal', async () => {
    const db = createAccountDataDb();
    const env = createEnv({ db });
    await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { x: 1 }));
    const insert = db.inserts.find((c) => c.sql.includes('INSERT INTO account_data'));
    expect(insert?.sql).toMatch(/VALUES \(\?, '', \?, \?\)/);
    expect(insert?.args).toEqual([USER, 'm.direct', JSON.stringify({ x: 1 })]);
  });

  it('account_data_changes INSERT binds empty room_id for global', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 9 } });
    const env = createEnv({ db });
    await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', {}));
    const change = db.inserts.find((c) => c.sql.includes('INSERT INTO account_data_changes'));
    expect(change?.args).toEqual([USER, '', 'm.direct', 10]);
  });

  it('room PUT account_data_changes INSERT binds real room_id', async () => {
    const db = joinedDb({ streamPositions: { account_data: 2 } });
    const env = createEnv({ db });
    await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: {} })
    );
    const change = db.inserts.find((c) => c.sql.includes('INSERT INTO account_data_changes'));
    expect(change?.args).toEqual([USER, ROOM, 'm.tag', 3]);
  });

  it('errcode vocabulary for route failures', async () => {
    const env = createEnv({ db: joinedDb() });

    const forbidden = await request(env, globalPath(BOB_ENC, 'm.direct'));
    expect((forbidden.body as { errcode: string }).errcode).toBe('M_FORBIDDEN');

    const notFound = await request(env, globalPath(USER_ENC, 'missing.type'));
    expect((notFound.body as { errcode: string }).errcode).toBe('M_NOT_FOUND');

    const badJson = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '{',
    });
    expect((badJson.body as { errcode: string }).errcode).toBe('M_BAD_JSON');

    const notInRoom = await request(
      env,
      roomPath(USER_ENC, encodeURIComponent('!nope:example.com'), 'm.tag')
    );
    expect((notInRoom.body as { errcode: string }).errcode).toBe('M_FORBIDDEN');

    const doFail = await request(
      createEnv({ userKeys: createUserKeysStub({ failPut: true }) }),
      globalPath(USER_ENC, 'm.secret_storage.default_key'),
      jsonInit('PUT', { key: 'x' })
    );
    expect((doFail.body as { errcode: string }).errcode).toBe('M_UNKNOWN');
    expect(doFail.status).toBe(503);
  });

  it('503 body is exact Failed to store E2EE data', async () => {
    const env = createEnv({ userKeys: createUserKeysStub({ failPut: true }) });
    const res = await request(
      env,
      globalPath(USER_ENC, 'm.megolm_backup.v1'),
      jsonInit('PUT', { algorithm: 'x' })
    );
    expect(res.body).toEqual({
      errcode: 'M_UNKNOWN',
      error: 'Failed to store E2EE data',
    });
  });

  it('room PUT does not write E2EE types to DO even for secret_storage type name', async () => {
    const userKeys = createUserKeysStub();
    const db = joinedDb();
    const env = createEnv({ userKeys, db });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.secret_storage.default_key'),
      jsonInit('PUT', { key: 'room-level' })
    );
    expect(res.status).toBe(200);
    expect(userKeys.fetches).toHaveLength(0);
    expect(db.rows[0]).toMatchObject({
      room_id: ROOM,
      event_type: 'm.secret_storage.default_key',
    });
  });
});

describe('account-data dense E2EE put/get matrix leftovers after #124', () => {
  const e2eeTypes = [
    'm.secret_storage.default_key',
    'm.secret_storage.key.ONE',
    'm.secret_storage.key.TWO',
    'm.cross_signing.master',
    'm.cross_signing.self_signing',
    'm.cross_signing.user_signing',
    'm.megolm_backup.v1',
  ];

  for (const type of e2eeTypes) {
    it(`lifecycle put→get for ${type}`, async () => {
      const userKeys = createUserKeysStub();
      const accountDataKv = mockKv();
      const db = createAccountDataDb({ streamPositions: { account_data: 0 } });
      const env = createEnv({ userKeys, accountDataKv, db });
      const content = { type, n: Math.random() };
      const put = await request(env, globalPath(USER_ENC, type), jsonInit('PUT', content));
      expect(put.status).toBe(200);
      expect(put.body).toEqual({});

      const get = await request(env, globalPath(USER_ENC, type));
      expect(get.status).toBe(200);
      expect(get.body).toEqual(content);

      // Simulate DO wipe → KV hit
      delete userKeys.accountData[type];
      const getKv = await request(env, globalPath(USER_ENC, type));
      expect(getKv.status).toBe(200);
      expect(getKv.body).toEqual(content);

      // Wipe KV too → D1 hit
      delete accountDataKv.data[`global:${USER}:${type}`];
      const getD1 = await request(env, globalPath(USER_ENC, type));
      expect(getD1.status).toBe(200);
      expect(getD1.body).toEqual(content);
    });
  }

  it('DO put failure for each E2EE type returns 503 without D1 row', async () => {
    for (const type of e2eeTypes) {
      const db = createAccountDataDb();
      const accountDataKv = mockKv();
      const env = createEnv({
        userKeys: createUserKeysStub({ failPut: true }),
        db,
        accountDataKv,
      });
      const res = await request(env, globalPath(USER_ENC, type), jsonInit('PUT', { t: type }));
      expect(res.status).toBe(503);
      expect(db.rows).toHaveLength(0);
      expect(accountDataKv.puts).toHaveLength(0);
    }
  });
});

describe('account-data soft-cap flood combinations after #124', () => {
  it('stores many distinct global types without cross-talk', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 100 } });
    const env = createEnv({ db });
    const types = Array.from({ length: 20 }, (_, i) => `org.example.bulk.${i}`);
    for (const type of types) {
      const res = await request(
        env,
        globalPath(USER_ENC, type),
        jsonInit('PUT', { type })
      );
      expect(res.status).toBe(200);
    }
    expect(db.rows).toHaveLength(20);
    expect(db.changes).toHaveLength(20);
    expect(db.streamPositions.account_data).toBe(120);

    for (const type of types) {
      const get = await request(env, globalPath(USER_ENC, type));
      expect(get.body).toEqual({ type });
    }
  });

  it('stores many room types while joined', async () => {
    const db = joinedDb({ streamPositions: { account_data: 0 } });
    const env = createEnv({ db });
    for (let i = 0; i < 15; i++) {
      const type = `org.example.room.${i}`;
      await request(
        env,
        roomPath(USER_ENC, ROOM_ENC, type),
        jsonInit('PUT', { i })
      );
    }
    expect(db.rows.every((r) => r.room_id === ROOM)).toBe(true);
    expect(db.rows).toHaveLength(15);
    for (let i = 0; i < 15; i++) {
      const get = await request(
        env,
        roomPath(USER_ENC, ROOM_ENC, `org.example.room.${i}`)
      );
      expect(get.body).toEqual({ i });
    }
  });

  it('large nested JSON content round-trips via D1', async () => {
    const big = {
      rooms: Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [
          `!r${i}:example.com`,
          Array.from({ length: 10 }, (_, j) => `@u${j}:example.com`),
        ])
      ),
    };
    const db = createAccountDataDb();
    const env = createEnv({ db });
    await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', big));
    const get = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(get.body).toEqual(big);
  });

  it('global GET never queries room_memberships', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.direct',
          content: '{}',
        },
      ],
    });
    const env = createEnv({ db });
    await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(db.firsts.every((f) => !f.sql.includes('room_memberships'))).toBe(true);
  });

  it('room GET queries membership before account_data', async () => {
    const db = joinedDb({
      rows: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: JSON.stringify({ tags: {} }),
        },
      ],
    });
    const env = createEnv({ db });
    await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    const memIdx = db.firsts.findIndex((f) => f.sql.includes('room_memberships'));
    const dataIdx = db.firsts.findIndex((f) => f.sql.includes('SELECT content FROM account_data'));
    expect(memIdx).toBeGreaterThanOrEqual(0);
    expect(dataIdx).toBeGreaterThan(memIdx);
  });

  it('forbidden other-user GET does not touch D1 account_data', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: BOB,
          room_id: '',
          event_type: 'm.direct',
          content: JSON.stringify({ secret: true }),
        },
      ],
    });
    const env = createEnv({ db });
    const before = db.firsts.length;
    await request(env, globalPath(BOB_ENC, 'm.direct'));
    expect(db.firsts.length).toBe(before);
  });

  it('forbidden other-user PUT does not insert', async () => {
    const db = createAccountDataDb();
    const env = createEnv({ db });
    await request(env, globalPath(BOB_ENC, 'm.direct'), jsonInit('PUT', { x: 1 }));
    expect(db.inserts).toHaveLength(0);
    expect(db.runs).toHaveLength(0);
  });
});
