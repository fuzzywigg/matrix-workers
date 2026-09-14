/**
 * TOKENMAXX HEAVY deepen — account-data HTTP routes (not account management #103).
 * Different slice than login (#101), admin (#102), devices/profile (#100).
 * Avoids helpers already covered in account-data-helpers.test.ts.
 * Tests-only — no product inventing.
 * Exercises global/room GET+PUT via Hono app.request() with D1/KV/USER_KEYS stubs.
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

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  const kv = {
    data,
    puts,
    deletes,
    get: async (key: string, type?: string) => {
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
                const name = args[0] as string;
                return { position: streamPositions[name] ?? 1 } as T;
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
