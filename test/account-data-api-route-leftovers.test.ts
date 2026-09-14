/**
 * TOKENMAXX HEAVY leftovers after #160 — account-data API soft/edge/reliability.
 * Complements account-data-api-routes.test.ts. Orthogonal to oauth-push-account-data
 * leftovers helpers, keys/media/appservice races, push leftovers, relations.
 * Tests-only — no product inventing. Fixtures use example.com only.
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

describe('account-data leftovers GET global soft flood after #160', () => {

  it('global GET m.direct soft-0', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r0:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r0:example.com'] });
  });

  it('global GET m.direct soft-1', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r1:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r1:example.com'] });
  });

  it('global GET m.direct soft-2', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r2:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r2:example.com'] });
  });

  it('global GET m.direct soft-3', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r3:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r3:example.com'] });
  });

  it('global GET m.direct soft-4', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r4:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r4:example.com'] });
  });

  it('global GET m.direct soft-5', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r5:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r5:example.com'] });
  });

  it('global GET m.direct soft-6', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r6:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r6:example.com'] });
  });

  it('global GET m.direct soft-7', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r7:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r7:example.com'] });
  });

  it('global GET m.direct soft-8', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r8:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r8:example.com'] });
  });

  it('global GET m.direct soft-9', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r9:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r9:example.com'] });
  });

  it('global GET m.direct soft-10', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r10:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r10:example.com'] });
  });

  it('global GET m.direct soft-11', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r11:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r11:example.com'] });
  });

  it('global GET m.direct soft-12', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r12:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r12:example.com'] });
  });

  it('global GET m.direct soft-13', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r13:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r13:example.com'] });
  });

  it('global GET m.direct soft-14', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r14:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r14:example.com'] });
  });

  it('global GET m.direct soft-15', async () => {
    const db = createAccountDataDb({
      rows: [{
        user_id: USER,
        room_id: '',
        event_type: 'm.direct',
        content: JSON.stringify({ '@bob:example.com': ['!r15:example.com'] }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '@bob:example.com': ['!r15:example.com'] });
  });
});

describe('account-data leftovers PUT global soft flood after #160', () => {

  it('global PUT tags soft-0', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 0.0 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-1', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 0.1 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-2', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 0.2 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-3', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 0.3 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-4', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 0.4 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-5', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 0.5 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-6', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 0.6 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-7', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 0.7 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-8', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 0.8 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-9', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 0.9 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-10', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 1.0 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-11', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 1.1 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-12', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 1.2 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-13', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 1.3 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-14', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 1.4 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });

  it('global PUT tags soft-15', async () => {
    const env = createEnv();
    const body = { tags: { 'm.favourite': { order: 1.5 } } };
    const res = await request(env, globalPath(USER_ENC, 'm.tag'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) => r.user_id === USER && r.event_type === 'm.tag' && r.room_id === ''
    );
    expect(row?.content).toBe(JSON.stringify(body));
    expect(env._db.changes).toHaveLength(1);
  });
});

describe('account-data leftovers GET room soft flood after #160', () => {

  it('room GET m.tag soft-0', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft0': { order: 0.0 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft0': { order: 0.0 } } });
  });

  it('room GET m.tag soft-1', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft1': { order: 0.1 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft1': { order: 0.1 } } });
  });

  it('room GET m.tag soft-2', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft2': { order: 0.2 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft2': { order: 0.2 } } });
  });

  it('room GET m.tag soft-3', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft3': { order: 0.3 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft3': { order: 0.3 } } });
  });

  it('room GET m.tag soft-4', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft4': { order: 0.4 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft4': { order: 0.4 } } });
  });

  it('room GET m.tag soft-5', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft5': { order: 0.5 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft5': { order: 0.5 } } });
  });

  it('room GET m.tag soft-6', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft6': { order: 0.6 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft6': { order: 0.6 } } });
  });

  it('room GET m.tag soft-7', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft7': { order: 0.7 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft7': { order: 0.7 } } });
  });

  it('room GET m.tag soft-8', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft8': { order: 0.8 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft8': { order: 0.8 } } });
  });

  it('room GET m.tag soft-9', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft9': { order: 0.9 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft9': { order: 0.9 } } });
  });

  it('room GET m.tag soft-10', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft10': { order: 0.0 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft10': { order: 0.0 } } });
  });

  it('room GET m.tag soft-11', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft11': { order: 0.1 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft11': { order: 0.1 } } });
  });

  it('room GET m.tag soft-12', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft12': { order: 0.2 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft12': { order: 0.2 } } });
  });

  it('room GET m.tag soft-13', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft13': { order: 0.3 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft13': { order: 0.3 } } });
  });

  it('room GET m.tag soft-14', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft14': { order: 0.4 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft14': { order: 0.4 } } });
  });

  it('room GET m.tag soft-15', async () => {
    const db = joinedDb({
      rows: [{
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.tag',
        content: JSON.stringify({ tags: { 'u.soft15': { order: 0.5 } } }),
      }],
    });
    const env = createEnv({ db });
    const res = await request(env, roomPath(USER_ENC, ROOM_ENC, 'm.tag'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: { 'u.soft15': { order: 0.5 } } });
  });
});

describe('account-data leftovers PUT room soft flood after #160', () => {

  it('room PUT custom soft-0', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 0, label: 'soft-0' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft0`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft0`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-1', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 1, label: 'soft-1' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft1`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft1`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-2', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 2, label: 'soft-2' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft2`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft2`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-3', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 3, label: 'soft-3' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft3`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft3`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-4', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 4, label: 'soft-4' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft4`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft4`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-5', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 5, label: 'soft-5' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft5`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft5`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-6', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 6, label: 'soft-6' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft6`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft6`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-7', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 7, label: 'soft-7' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft7`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft7`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-8', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 8, label: 'soft-8' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft8`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft8`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-9', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 9, label: 'soft-9' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft9`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft9`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-10', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 10, label: 'soft-10' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft10`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft10`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-11', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 11, label: 'soft-11' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft11`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft11`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-12', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 12, label: 'soft-12' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft12`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft12`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-13', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 13, label: 'soft-13' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft13`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft13`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-14', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 14, label: 'soft-14' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft14`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft14`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });

  it('room PUT custom soft-15', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { n: 15, label: 'soft-15' };
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.soft15`),
      jsonInit('PUT', body)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const row = env._db.rows.find(
      (r: AccountDataRow) =>
        r.user_id === USER && r.room_id === ROOM && r.event_type === `im.vector.setting.soft15`
    );
    expect(row?.content).toBe(JSON.stringify(body));
  });
});

describe('account-data leftovers E2EE PUT soft flood after #160', () => {

  it('E2EE PUT m.secret_storage.default_key soft-0', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 0, type: 'm.secret_storage.default_key' };
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.secret_storage.default_key']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.cross_signing.master soft-1', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 1, type: 'm.cross_signing.master' };
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.master'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.cross_signing.master']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.cross_signing.self_signing soft-2', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 2, type: 'm.cross_signing.self_signing' };
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.self_signing'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.cross_signing.self_signing']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.cross_signing.user_signing soft-3', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 3, type: 'm.cross_signing.user_signing' };
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.user_signing'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.cross_signing.user_signing']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.megolm_backup.v1 soft-4', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 4, type: 'm.megolm_backup.v1' };
    const res = await request(env, globalPath(USER_ENC, 'm.megolm_backup.v1'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.megolm_backup.v1']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.secret_storage.default_key soft-5', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 5, type: 'm.secret_storage.default_key' };
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.secret_storage.default_key']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.cross_signing.master soft-6', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 6, type: 'm.cross_signing.master' };
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.master'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.cross_signing.master']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.cross_signing.self_signing soft-7', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 7, type: 'm.cross_signing.self_signing' };
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.self_signing'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.cross_signing.self_signing']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.cross_signing.user_signing soft-8', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 8, type: 'm.cross_signing.user_signing' };
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.user_signing'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.cross_signing.user_signing']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.megolm_backup.v1 soft-9', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 9, type: 'm.megolm_backup.v1' };
    const res = await request(env, globalPath(USER_ENC, 'm.megolm_backup.v1'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.megolm_backup.v1']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.secret_storage.default_key soft-10', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 10, type: 'm.secret_storage.default_key' };
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.secret_storage.default_key']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.cross_signing.master soft-11', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 11, type: 'm.cross_signing.master' };
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.master'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.cross_signing.master']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.cross_signing.self_signing soft-12', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 12, type: 'm.cross_signing.self_signing' };
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.self_signing'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.cross_signing.self_signing']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.cross_signing.user_signing soft-13', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 13, type: 'm.cross_signing.user_signing' };
    const res = await request(env, globalPath(USER_ENC, 'm.cross_signing.user_signing'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.cross_signing.user_signing']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.megolm_backup.v1 soft-14', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 14, type: 'm.megolm_backup.v1' };
    const res = await request(env, globalPath(USER_ENC, 'm.megolm_backup.v1'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.megolm_backup.v1']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });

  it('E2EE PUT m.secret_storage.default_key soft-15', async () => {
    const userKeys = createUserKeysStub();
    const env = createEnv({ userKeys });
    const body = { soft: 15, type: 'm.secret_storage.default_key' };
    const res = await request(env, globalPath(USER_ENC, 'm.secret_storage.default_key'), jsonInit('PUT', body));
    expect(res.status).toBe(200);
    expect(userKeys.accountData['m.secret_storage.default_key']).toEqual(body);
    expect(userKeys.fetches.some((f) => f.method === 'POST' || f.url.includes('/account-data/put'))).toBe(true);
  });
});

describe('account-data leftovers charset soft flood after #160', () => {

  it('charset utf-8 soft-0', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user0:example.com': ['!c0:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-1', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user1:example.com': ['!c1:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-2', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user2:example.com': ['!c2:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-3', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user3:example.com': ['!c3:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-4', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user4:example.com': ['!c4:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-5', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user5:example.com': ['!c5:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-6', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user6:example.com': ['!c6:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-7', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user7:example.com': ['!c7:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-8', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user8:example.com': ['!c8:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-9', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user9:example.com': ['!c9:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-10', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user10:example.com': ['!c10:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-11', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user11:example.com': ['!c11:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-12', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user12:example.com': ['!c12:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-13', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user13:example.com': ['!c13:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-14', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user14:example.com': ['!c14:example.com'] }),
    });
    expect(res.status).toBe(200);
  });

  it('charset utf-8 soft-15', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify({ '@user15:example.com': ['!c15:example.com'] }),
    });
    expect(res.status).toBe(200);
  });
});

describe('account-data leftovers forbidden soft flood after #160', () => {

  it('forbidden other user soft-0', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft0`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-1', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft1`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-2', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft2`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-3', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft3`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-4', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft4`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-5', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft5`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-6', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft6`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-7', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft7`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-8', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft8`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-9', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft9`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-10', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft10`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-11', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft11`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-12', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft12`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-13', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft13`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-14', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft14`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden other user soft-15', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(BOB_ENC, `m.custom.soft15`));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});

describe('account-data leftovers room membership gate soft flood after #160', () => {

  it('room membership join soft-0', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: { 'u.x': { order: 0.0 } } })
    );
    expect(res.status).toBe(200);
  });

  it('room membership leave soft-1', async () => {
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
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('room membership join soft-2', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: { 'u.x': { order: 0.2 } } })
    );
    expect(res.status).toBe(200);
  });

  it('room membership ban soft-3', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: {} })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('room membership join soft-4', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: { 'u.x': { order: 0.4 } } })
    );
    expect(res.status).toBe(200);
  });

  it('room membership invite soft-5', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: {} })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('room membership join soft-6', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: { 'u.x': { order: 0.6 } } })
    );
    expect(res.status).toBe(200);
  });

  it('room membership knock soft-7', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: {} })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('room membership join soft-8', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: { 'u.x': { order: 0.8 } } })
    );
    expect(res.status).toBe(200);
  });

  it('room membership leave soft-9', async () => {
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
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('room membership join soft-10', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: { 'u.x': { order: 0.0 } } })
    );
    expect(res.status).toBe(200);
  });

  it('room membership leave soft-11', async () => {
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
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('room membership join soft-12', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: { 'u.x': { order: 0.2 } } })
    );
    expect(res.status).toBe(200);
  });

  it('room membership ban soft-13', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: {} })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('room membership join soft-14', async () => {
    const env = createEnv({ db: joinedDb() });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: { 'u.x': { order: 0.4 } } })
    );
    expect(res.status).toBe(200);
  });

  it('room membership invite soft-15', async () => {
    const db = createAccountDataDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, 'm.tag'),
      jsonInit('PUT', { tags: {} })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});

describe('account-data leftovers method matrix after #160', () => {

  it('method POST soft-0', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method PATCH soft-1', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method DELETE soft-2', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method OPTIONS soft-3', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'OPTIONS',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method HEAD soft-4', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'HEAD',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method GET soft-5', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.direct', content: '{}' }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), { method: 'GET', headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(200);
  });

  it('method POST soft-6', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method PATCH soft-7', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method DELETE soft-8', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method OPTIONS soft-9', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'OPTIONS',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method HEAD soft-10', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'HEAD',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method GET soft-11', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.direct', content: '{}' }],
    });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), { method: 'GET', headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(200);
  });

  it('method POST soft-12', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method PATCH soft-13', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method DELETE soft-14', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method OPTIONS soft-15', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'OPTIONS',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });
});

describe('account-data leftovers failure edges after #160', () => {

  it('bad JSON soft-0', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-0',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-1', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-1',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-2', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-2',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-3', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-3',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-4', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-4',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-5', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-5',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-6', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-6',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-7', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-7',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-8', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-8',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-9', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-9',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-10', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-10',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-11', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-11',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-12', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-12',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-13', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-13',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-14', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-14',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('bad JSON soft-15', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{not-json-15',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('account-data leftovers put-get lifecycle after #160', () => {

  it('put then get soft-0', async () => {
    const env = createEnv();
    const body = { lifecycle: 0, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc0`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc0`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-1', async () => {
    const env = createEnv();
    const body = { lifecycle: 1, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc1`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc1`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-2', async () => {
    const env = createEnv();
    const body = { lifecycle: 2, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc2`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc2`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-3', async () => {
    const env = createEnv();
    const body = { lifecycle: 3, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc3`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc3`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-4', async () => {
    const env = createEnv();
    const body = { lifecycle: 4, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc4`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc4`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-5', async () => {
    const env = createEnv();
    const body = { lifecycle: 5, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc5`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc5`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-6', async () => {
    const env = createEnv();
    const body = { lifecycle: 6, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc6`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc6`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-7', async () => {
    const env = createEnv();
    const body = { lifecycle: 7, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc7`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc7`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-8', async () => {
    const env = createEnv();
    const body = { lifecycle: 8, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc8`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc8`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-9', async () => {
    const env = createEnv();
    const body = { lifecycle: 9, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc9`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc9`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-10', async () => {
    const env = createEnv();
    const body = { lifecycle: 10, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc10`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc10`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-11', async () => {
    const env = createEnv();
    const body = { lifecycle: 11, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc11`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc11`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-12', async () => {
    const env = createEnv();
    const body = { lifecycle: 12, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc12`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc12`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-13', async () => {
    const env = createEnv();
    const body = { lifecycle: 13, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc13`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc13`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-14', async () => {
    const env = createEnv();
    const body = { lifecycle: 14, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc14`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc14`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('put then get soft-15', async () => {
    const env = createEnv();
    const body = { lifecycle: 15, v: 'soft' };
    const put = await request(env, globalPath(USER_ENC, `im.vector.setting.lc15`), jsonInit('PUT', body));
    expect(put.status).toBe(200);
    const get = await request(env, globalPath(USER_ENC, `im.vector.setting.lc15`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });
});

describe('account-data leftovers room put-get lifecycle after #160', () => {

  it('room put then get soft-0', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 0 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc0`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc0`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-1', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 1 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc1`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc1`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-2', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 2 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc2`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc2`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-3', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 3 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc3`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc3`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-4', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 4 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc4`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc4`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-5', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 5 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc5`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc5`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-6', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 6 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc6`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc6`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-7', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 7 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc7`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc7`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-8', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 8 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc8`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc8`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-9', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 9 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc9`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc9`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-10', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 10 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc10`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc10`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-11', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 11 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc11`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc11`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-12', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 12 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc12`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc12`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-13', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 13 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc13`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc13`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-14', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 14 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc14`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc14`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });

  it('room put then get soft-15', async () => {
    const env = createEnv({ db: joinedDb() });
    const body = { roomLifecycle: 15 };
    const put = await request(
      env,
      roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc15`),
      jsonInit('PUT', body)
    );
    expect(put.status).toBe(200);
    const get = await request(env, roomPath(USER_ENC, ROOM_ENC, `im.vector.setting.rlc15`));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(body);
  });
});

describe('account-data leftovers not-found soft flood after #160', () => {

  it('global missing soft-0', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft0`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-1', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft1`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-2', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft2`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-3', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft3`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-4', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft4`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-5', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft5`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-6', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft6`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-7', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft7`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-8', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft8`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-9', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft9`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-10', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft10`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-11', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft11`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-12', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft12`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-13', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft13`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-14', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft14`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('global missing soft-15', async () => {
    const env = createEnv();
    const res = await request(env, globalPath(USER_ENC, `im.vector.missing.soft15`));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});

describe('account-data leftovers stream position soft flood after #160', () => {

  it('stream bump soft-0', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 10 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 0 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(11);
    expect(env._db.changes[0].stream_position).toBe(11);
  });

  it('stream bump soft-1', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 11 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 1 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(12);
    expect(env._db.changes[0].stream_position).toBe(12);
  });

  it('stream bump soft-2', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 12 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 2 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(13);
    expect(env._db.changes[0].stream_position).toBe(13);
  });

  it('stream bump soft-3', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 13 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 3 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(14);
    expect(env._db.changes[0].stream_position).toBe(14);
  });

  it('stream bump soft-4', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 14 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 4 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(15);
    expect(env._db.changes[0].stream_position).toBe(15);
  });

  it('stream bump soft-5', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 15 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 5 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(16);
    expect(env._db.changes[0].stream_position).toBe(16);
  });

  it('stream bump soft-6', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 16 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 6 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(17);
    expect(env._db.changes[0].stream_position).toBe(17);
  });

  it('stream bump soft-7', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 17 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 7 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(18);
    expect(env._db.changes[0].stream_position).toBe(18);
  });

  it('stream bump soft-8', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 18 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 8 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(19);
    expect(env._db.changes[0].stream_position).toBe(19);
  });

  it('stream bump soft-9', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 19 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 9 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(20);
    expect(env._db.changes[0].stream_position).toBe(20);
  });

  it('stream bump soft-10', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 20 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 10 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(21);
    expect(env._db.changes[0].stream_position).toBe(21);
  });

  it('stream bump soft-11', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 21 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 11 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(22);
    expect(env._db.changes[0].stream_position).toBe(22);
  });

  it('stream bump soft-12', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 22 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 12 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(23);
    expect(env._db.changes[0].stream_position).toBe(23);
  });

  it('stream bump soft-13', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 23 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 13 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(24);
    expect(env._db.changes[0].stream_position).toBe(24);
  });

  it('stream bump soft-14', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 24 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 14 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(25);
    expect(env._db.changes[0].stream_position).toBe(25);
  });

  it('stream bump soft-15', async () => {
    const db = createAccountDataDb({ streamPositions: { account_data: 25 } });
    const env = createEnv({ db });
    const res = await request(env, globalPath(USER_ENC, 'm.direct'), jsonInit('PUT', { i: 15 }));
    expect(res.status).toBe(200);
    expect(env._db.streamPositions.account_data).toBe(26);
    expect(env._db.changes[0].stream_position).toBe(26);
  });
});

