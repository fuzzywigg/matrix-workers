/**
 * TOKENMAXX HEAVY leftovers after #300 septenary / tip past #299 — oauth
 * *octonary* concurrent-race niches: UIA soft strings septenary never
 * mixed with success siblings under Promise.all:
 *   `Could not parse request.` (quaternary dual-parse only; never ∥
 *     Missing/Expired body ∥ Request Approved),
 *   `Please enter your credentials to approve this request.` exact
 *     description (routes/helpers only; senary/septenary assert error
 *     banners without this description pin under race),
 *   sensitive-operation warning exact under GET approval race,
 *   `Request Cancelled` ∥ Missing body ∥ Expired body ∥ Approved *quad*
 *     (senary only cancel∥approve pair),
 *   cross-signing action description exact ∥ soft Missing/Expired.
 *
 * Gap table (why leftover after #300):
 *   Could not parse ∥ Missing/Expired bodies ∥ Approved
 *     | quaternary dual-parse only
 *   Please enter your credentials… description ∥ approve/cancel
 *     | never claimed under race
 *   sensitive-operation warning ∥ Missing/Expired ∥ approval GET
 *     | helpers unit only
 *   Cancelled ∥ Missing body ∥ Expired body ∥ Approved quad
 *     | senary cancel∥approve pair only
 *
 * Distinct from #300 oauth septenary, #294 senary, #283 quinary,
 * #277 quaternary. New file. Tests-only. example.com fixtures only.
 * Reversible by delete. No invent-product / secrets / DNS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HonoRequest } from 'hono/request';
import type { Env } from '../src/types';

const SERVER = 'example.com';
const USER_ID = `@alice:${SERVER}`;
const BOB_ID = `@bob:${SERVER}`;
const NOW = 1_730_000_000_000;

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    verifyPassword: vi.fn(async (password: string, storedHash: string) => {
      return storedHash === `mockok:${password}`;
    }),
  };
});

import oauth from '../src/api/oauth';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type KvBarrier = { match: (key: string) => boolean; count: number };

async function withBarrier(
  barrier: KvBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  key: string
) {
  if (!barrier || !barrier.match(key)) return;
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

function mockKv(
  initial: Record<string, string> = {},
  opts: {
    putBarrier?: KvBarrier;
    getBarrier?: KvBarrier;
    deleteBarrier?: KvBarrier;
    mutateAfterGets?: { after: number; next: Record<string, string> };
    failGetAfter?: number;
    failPutAfter?: number;
    failDeleteAfter?: number;
  } = {}
) {
  const data: Record<string, string> = { ...initial };
  const puts: KvPut[] = [];
  const gets: string[] = [];
  const deletes: string[] = [];
  const events: string[] = [];
  let putBarrier = opts.putBarrier;
  let getBarrier = opts.getBarrier;
  let deleteBarrier = opts.deleteBarrier;
  const putWaiters = { list: [] as Array<() => void> };
  const getWaiters = { list: [] as Array<() => void> };
  const deleteWaiters = { list: [] as Array<() => void> };
  let putCount = 0;
  let getCount = 0;
  let deleteCount = 0;

  return {
    data,
    puts,
    gets,
    deletes,
    events,
    get putCount() {
      return putCount;
    },
    get getCount() {
      return getCount;
    },
    get deleteCount() {
      return deleteCount;
    },
    get: async (key: string, type?: string) => {
      await withBarrier(getBarrier, getWaiters, () => {
        getBarrier = undefined;
      }, key);
      getCount += 1;
      gets.push(key);
      events.push(`get:${key}`);
      if (opts.failGetAfter !== undefined && getCount > opts.failGetAfter) {
        throw new Error('kv-get-fail');
      }
      const raw = data[key];
      if (opts.mutateAfterGets && getCount === opts.mutateAfterGets.after) {
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, opts.mutateAfterGets.next);
        events.push('mutate:after-get');
      }
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
      await withBarrier(putBarrier, putWaiters, () => {
        putBarrier = undefined;
      }, key);
      putCount += 1;
      if (opts.failPutAfter !== undefined && putCount > opts.failPutAfter) {
        throw new Error('kv-put-fail');
      }
      data[key] = value;
      puts.push({ key, value, options });
      events.push(`put:${key}`);
    },
    delete: async (key: string) => {
      await withBarrier(deleteBarrier, deleteWaiters, () => {
        deleteBarrier = undefined;
      }, key);
      deleteCount += 1;
      if (opts.failDeleteAfter !== undefined && deleteCount > opts.failDeleteAfter) {
        throw new Error('kv-delete-fail');
      }
      deletes.push(key);
      delete data[key];
      events.push(`delete:${key}`);
      return undefined;
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
}

type RaceKv = ReturnType<typeof mockKv>;

type UserRow = {
  user_id: string;
  localpart: string;
  display_name: string | null;
  avatar_url: string | null;
  password_hash: string | null;
  is_guest: number;
  is_deactivated: number;
  admin: number;
  created_at: number;
};

type TokenRow = { user_id: string; device_id: string | null; created_at: number };

function userRow(partial: Partial<UserRow> & Pick<UserRow, 'user_id' | 'localpart'>): UserRow {
  return {
    display_name: partial.display_name !== undefined ? partial.display_name : partial.localpart,
    avatar_url: partial.avatar_url !== undefined ? partial.avatar_url : null,
    password_hash: partial.password_hash ?? null,
    is_guest: partial.is_guest ?? 0,
    is_deactivated: partial.is_deactivated ?? 0,
    admin: partial.admin ?? 0,
    created_at: partial.created_at ?? NOW,
    user_id: partial.user_id,
    localpart: partial.localpart,
  };
}

function createOAuthDb(opts: {
  users?: Map<string, UserRow>;
  tokensByHash?: Map<string, TokenRow>;
  idpLinkUserIds?: string[];
} = {}) {
  const users = opts.users ?? new Map<string, UserRow>();
  const tokensByHash = opts.tokensByHash ?? new Map<string, TokenRow>();
  const idpLinkUserIds = opts.idpLinkUserIds ?? [];
  const inserts: Array<{ sql: string; args: unknown[] }> = [];
  const deletes: Array<{ sql: string; args: unknown[] }> = [];
  const devices: Array<{ user_id: string; device_id: string; display_name: string | null }> = [];

  return {
    users,
    tokensByHash,
    inserts,
    deletes,
    devices,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM users') && sql.includes('password_hash') && sql.includes('is_deactivated')) {
                const userId = args[0] as string;
                const u = users.get(userId);
                if (!u || u.is_deactivated) return null;
                return { user_id: u.user_id, password_hash: u.password_hash } as T;
              }
              if (sql.includes('SELECT password_hash FROM users')) {
                const userId = args[0] as string;
                const u = users.get(userId);
                return (u ? { password_hash: u.password_hash } : null) as T;
              }
              if (
                sql.includes('FROM users WHERE user_id') &&
                sql.includes('display_name') &&
                !sql.includes('password_hash')
              ) {
                const userId = args[0] as string;
                const u = users.get(userId);
                if (!u) return null;
                return {
                  user_id: u.user_id,
                  localpart: u.localpart,
                  display_name: u.display_name,
                  avatar_url: u.avatar_url,
                  is_guest: u.is_guest,
                  is_deactivated: u.is_deactivated,
                  admin: u.admin,
                  created_at: u.created_at,
                } as T;
              }
              if (sql.includes('FROM access_tokens') && sql.includes('token_hash') && sql.includes('SELECT')) {
                const hash = args[0] as string;
                const row = tokensByHash.get(hash);
                if (!row) return null;
                if (sql.includes('created_at')) {
                  return {
                    user_id: row.user_id,
                    device_id: row.device_id,
                    created_at: row.created_at,
                  } as T;
                }
                return { user_id: row.user_id, device_id: row.device_id } as T;
              }
              if (sql.includes('FROM idp_user_links') && sql.includes('COUNT')) {
                const userId = args[0] as string;
                const count = idpLinkUserIds.filter((id) => id === userId).length;
                return { count } as T;
              }
              if (sql.includes('FROM appservice_registrations')) {
                return null;
              }
              return null;
            },
            async run() {
              if (sql.trimStart().toUpperCase().startsWith('INSERT')) {
                inserts.push({ sql, args });
                if (sql.includes('INTO access_tokens')) {
                  const [, tokenHash, userId, deviceId] = args as [
                    string,
                    string,
                    string,
                    string | null,
                  ];
                  tokensByHash.set(tokenHash, {
                    user_id: userId,
                    device_id: deviceId,
                    created_at: Date.now(),
                  });
                }
                if (sql.includes('INTO devices')) {
                  devices.push({
                    user_id: args[0] as string,
                    device_id: args[1] as string,
                    display_name: (args[2] as string | null) ?? null,
                  });
                }
              }
              if (sql.trimStart().toUpperCase().startsWith('DELETE')) {
                deletes.push({ sql, args });
                if (sql.includes('FROM access_tokens') && sql.includes('token_hash')) {
                  tokensByHash.delete(args[0] as string);
                }
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & {
    users: Map<string, UserRow>;
    tokensByHash: Map<string, TokenRow>;
    inserts: Array<{ sql: string; args: unknown[] }>;
    deletes: Array<{ sql: string; args: unknown[] }>;
    devices: Array<{ user_id: string; device_id: string; display_name: string | null }>;
  };
}

function aliceDb(extra?: Map<string, UserRow>) {
  const users = new Map([
    [
      USER_ID,
      userRow({
        user_id: USER_ID,
        localpart: 'alice',
        password_hash: 'mockok:secret',
        display_name: 'Alice',
        avatar_url: 'mxc://example.com/alice',
      }),
    ],
    [
      BOB_ID,
      userRow({
        user_id: BOB_ID,
        localpart: 'bob',
        password_hash: 'mockok:bobpass',
        display_name: 'Bob',
      }),
    ],
  ]);
  if (extra) for (const [k, v] of extra) users.set(k, v);
  return createOAuthDb({ users });
}

function makeEnv(opts: {
  cache?: RaceKv;
  sessions?: RaceKv;
  db?: ReturnType<typeof createOAuthDb>;
} = {}): Env & { _cache: RaceKv; _sessions: RaceKv; _db: ReturnType<typeof createOAuthDb> } {
  const cache = opts.cache ?? mockKv();
  const sessions = opts.sessions ?? mockKv();
  const db = opts.db ?? aliceDb();
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    CACHE: cache,
    SESSIONS: sessions,
    DB: db,
    _cache: cache,
    _sessions: sessions,
    _db: db,
  } as unknown as Env & {
    _cache: RaceKv;
    _sessions: RaceKv;
    _db: ReturnType<typeof createOAuthDb>;
  };
}

async function request(path: string, init: RequestInit = {}, env: Env = makeEnv()): Promise<{
  status: number;
  body: any;
  headers: Headers;
  text: string;
}> {
  const res = await oauth.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers, text };
}

function formInit(fields: Record<string, string>): RequestInit {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return { method: 'POST', body: fd };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function seedUiaSession(cache: RaceKv, id: string, patch: Record<string, unknown> = {}) {
  const session = { user_id: USER_ID, completed_stages: [] as string[], ...patch };
  cache.data[`uia_session:${id}`] = JSON.stringify(session);
  return session;
}

const UIA_MISSING_BODY = 'No UIA session specified.';
const UIA_EXPIRED_BODY = 'This session has expired. Please try again.';
const UIA_PARSE_BODY = 'Could not parse request.';
const UIA_CREDENTIALS_DESC = 'Please enter your credentials to approve this request.';
const UIA_SENSITIVE =
  'This is a sensitive operation. Please verify this is what you intended.';
const UIA_CROSS_SIGNING_DESC =
  'An application is requesting to reset your encryption identity. This will allow you to set up encryption again, but you may lose access to old encrypted messages.';
const UIA_USERNAME_REQUIRED = 'Username and password are required.';

function htmlOf(results: Array<{ body: unknown }>): string[] {
  return results.map((r) => String(r.body));
}

// ---------------------------------------------------------------------------
// Could not parse ∥ Missing/Expired bodies ∥ Request Approved
// ---------------------------------------------------------------------------

describe('octonary oauth UIA Could not parse ∥ soft bodies ∥ Approved after #300', () => {
  it('parse fail ∥ Missing body ∥ Expired body ∥ Request Approved under race', async () => {
    const spy = vi
      .spyOn(HonoRequest.prototype, 'parseBody')
      .mockRejectedValueOnce(new Error('parse boom'));
    const cache = mockKv();
    seedUiaSession(cache, 'uia-ok');
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-ok', username: 'alice', password: 'secret' }),
        env
      ),
      request('/oauth/authorize/uia', formInit({ username: 'alice', password: 'secret' }), env),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'gone', username: 'alice', password: 'secret' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-ok', username: 'alice', password: 'secret' }),
        env
      ),
    ]);
    spy.mockRestore();
    expect(results.every((r) => r.status === 200)).toBe(true);
    const htmls = htmlOf(results);
    expect(htmls.some((h) => h.includes(UIA_PARSE_BODY))).toBe(true);
    expect(htmls.some((h) => h.includes('Invalid Request'))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_MISSING_BODY))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_EXPIRED_BODY))).toBe(true);
    expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
    expect(JSON.parse(cache.data['uia_session:uia-ok']).completed_stages).toEqual(
      expect.arrayContaining(['m.oauth', 'm.login.oauth'])
    );
  });

  for (let i = 0; i < 10; i++) {
    it(`parse fail ∥ Approved flood-${i}`, async () => {
      const spy = vi
        .spyOn(HonoRequest.prototype, 'parseBody')
        .mockRejectedValueOnce(new Error(`boom-${i}`));
      const cache = mockKv();
      seedUiaSession(cache, `uia-ok-${i}`);
      const env = makeEnv({ cache, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/authorize/uia',
          formInit({ session: `uia-ok-${i}`, username: 'alice', password: 'secret' }),
          env
        ),
        request(
          '/oauth/authorize/uia',
          formInit({ session: `uia-ok-${i}`, username: 'alice', password: 'secret' }),
          env
        ),
      ]);
      spy.mockRestore();
      expect(results.every((r) => r.status === 200)).toBe(true);
      const htmls = htmlOf(results);
      expect(htmls.some((h) => h.includes(UIA_PARSE_BODY))).toBe(true);
      expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Please enter your credentials… description ∥ approve / cancel / missing
// ---------------------------------------------------------------------------

describe('octonary oauth UIA credentials description under race after #300', () => {
  it('missing username description ∥ Request Approved under race', async () => {
    const cache = mockKv();
    seedUiaSession(cache, 'uia-cred');
    seedUiaSession(cache, 'uia-ok');
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-cred', password: 'secret' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-ok', username: 'alice', password: 'secret' }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const htmls = htmlOf(results);
    expect(htmls.some((h) => h.includes(UIA_CREDENTIALS_DESC))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_USERNAME_REQUIRED))).toBe(true);
    expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
    expect(cache.data['uia_session:uia-cred']).toBeTruthy();
  });

  it('bad password keeps credentials description ∥ Request Approved under race', async () => {
    const cache = mockKv();
    seedUiaSession(cache, 'uia-bad');
    seedUiaSession(cache, 'uia-ok2');
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-bad', username: 'alice', password: 'nope' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-ok2', username: 'alice', password: 'secret' }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const htmls = htmlOf(results);
    expect(htmls.some((h) => h.includes(UIA_CREDENTIALS_DESC))).toBe(true);
    expect(htmls.some((h) => h.includes('Invalid username or password.'))).toBe(true);
    expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
  });

  it('credentials description ∥ cancel ∥ approve triple race', async () => {
    const cache = mockKv();
    seedUiaSession(cache, 'uia-cred2');
    seedUiaSession(cache, 'uia-cancel');
    seedUiaSession(cache, 'uia-ok3');
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-cred2', password: 'x' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({
          session: 'uia-cancel',
          username: 'alice',
          password: 'secret',
          action: 'cancel',
        }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-ok3', username: 'alice', password: 'secret' }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const htmls = htmlOf(results);
    expect(htmls.some((h) => h.includes(UIA_CREDENTIALS_DESC))).toBe(true);
    expect(htmls.some((h) => h.includes('Request Cancelled'))).toBe(true);
    expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
    expect(cache.data['uia_session:uia-cancel']).toBeUndefined();
  });

  for (let i = 0; i < 8; i++) {
    it(`credentials description ∥ approve flood-${i}`, async () => {
      const cache = mockKv();
      seedUiaSession(cache, `uia-cred-${i}`);
      seedUiaSession(cache, `uia-ok-${i}`);
      const env = makeEnv({ cache, db: aliceDb() });
      const soft =
        i % 2 === 0
          ? formInit({ session: `uia-cred-${i}`, password: 'secret' })
          : formInit({ session: `uia-cred-${i}`, username: 'alice', password: 'wrong' });
      const results = await Promise.all([
        request('/oauth/authorize/uia', soft, env),
        request(
          '/oauth/authorize/uia',
          formInit({
            session: `uia-ok-${i}`,
            username: 'alice',
            password: 'secret',
          }),
          env
        ),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      const htmls = htmlOf(results);
      expect(htmls.some((h) => h.includes(UIA_CREDENTIALS_DESC))).toBe(true);
      expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Sensitive-operation warning ∥ Missing/Expired ∥ approval GET
// ---------------------------------------------------------------------------

describe('octonary oauth UIA sensitive-operation warning under race after #300', () => {
  it('sensitive warning ∥ Missing body ∥ Expired body under GET race', async () => {
    const cache = mockKv();
    seedUiaSession(cache, 'uia-ok');
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize/uia?session=uia-ok&action=org.matrix.cross_signing_reset',
        {},
        env
      ),
      request('/oauth/authorize/uia', {}, env),
      request('/oauth/authorize/uia?session=gone', {}, env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const htmls = htmlOf(results);
    expect(htmls.some((h) => h.includes(UIA_SENSITIVE))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_CROSS_SIGNING_DESC))).toBe(true);
    expect(htmls.some((h) => h.includes('Reset Encryption Keys'))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_MISSING_BODY))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_EXPIRED_BODY))).toBe(true);
  });

  it('cross-signing description ∥ default approval description under race', async () => {
    const cache = mockKv();
    seedUiaSession(cache, 'uia-xr');
    seedUiaSession(cache, 'uia-def');
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize/uia?session=uia-xr&action=org.matrix.cross_signing_reset',
        {},
        env
      ),
      request('/oauth/authorize/uia?session=uia-def', {}, env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const htmls = htmlOf(results);
    expect(htmls.some((h) => h.includes(UIA_CROSS_SIGNING_DESC))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_SENSITIVE))).toBe(true);
    expect(htmls.some((h) => h.includes('An application is requesting your approval.'))).toBe(
      true
    );
    expect(htmls.some((h) => h.includes('Approve Request'))).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`sensitive warning ∥ soft Missing/Expired flood-${i}`, async () => {
      const cache = mockKv();
      seedUiaSession(cache, `uia-ok-${i}`);
      const env = makeEnv({ cache, db: aliceDb() });
      const soft =
        i % 2 === 0
          ? request('/oauth/authorize/uia', {}, env)
          : request(`/oauth/authorize/uia?session=miss-${i}`, {}, env);
      const results = await Promise.all([
        request(
          `/oauth/authorize/uia?session=uia-ok-${i}&action=org.matrix.cross_signing_reset`,
          {},
          env
        ),
        soft,
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      const htmls = htmlOf(results);
      expect(htmls.some((h) => h.includes(UIA_SENSITIVE))).toBe(true);
      expect(
        htmls.some((h) => h.includes(UIA_MISSING_BODY) || h.includes(UIA_EXPIRED_BODY))
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Request Cancelled ∥ Missing body ∥ Expired body ∥ Request Approved quad
// ---------------------------------------------------------------------------

describe('octonary oauth UIA cancel∥Missing∥Expired∥Approved quad after #300', () => {
  it('cancel ∥ Missing body ∥ Expired body ∥ Request Approved under race', async () => {
    const cache = mockKv();
    seedUiaSession(cache, 'uia-cancel');
    seedUiaSession(cache, 'uia-ok');
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize/uia',
        formInit({
          session: 'uia-cancel',
          username: 'alice',
          password: 'secret',
          action: 'cancel',
        }),
        env
      ),
      request('/oauth/authorize/uia', formInit({ username: 'alice', password: 'secret' }), env),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'gone', username: 'alice', password: 'secret' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-ok', username: 'alice', password: 'secret' }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const htmls = htmlOf(results);
    expect(htmls.some((h) => h.includes('Request Cancelled'))).toBe(true);
    expect(htmls.some((h) => h.includes(`Cancelled - ${SERVER}`))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_MISSING_BODY))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_EXPIRED_BODY))).toBe(true);
    expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
    expect(cache.data['uia_session:uia-cancel']).toBeUndefined();
    expect(cache.deletes).toContain('uia_session:uia-cancel');
    expect(JSON.parse(cache.data['uia_session:uia-ok']).completed_stages).toEqual(
      expect.arrayContaining(['m.oauth'])
    );
  });

  for (let i = 0; i < 10; i++) {
    it(`cancel ∥ Missing/Expired ∥ Approved flood-${i}`, async () => {
      const cache = mockKv();
      seedUiaSession(cache, `uia-cancel-${i}`);
      seedUiaSession(cache, `uia-ok-${i}`);
      const env = makeEnv({ cache, db: aliceDb() });
      const soft =
        i % 2 === 0
          ? request('/oauth/authorize/uia', formInit({ username: 'a', password: 'b' }), env)
          : request(
              '/oauth/authorize/uia',
              formInit({ session: `gone-${i}`, username: 'a', password: 'b' }),
              env
            );
      const results = await Promise.all([
        request(
          '/oauth/authorize/uia',
          formInit({
            session: `uia-cancel-${i}`,
            username: 'alice',
            password: 'secret',
            action: 'cancel',
          }),
          env
        ),
        soft,
        request(
          '/oauth/authorize/uia',
          formInit({
            session: `uia-ok-${i}`,
            username: 'alice',
            password: 'secret',
          }),
          env
        ),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      const htmls = htmlOf(results);
      expect(htmls.some((h) => h.includes('Request Cancelled'))).toBe(true);
      expect(
        htmls.some((h) => h.includes(UIA_MISSING_BODY) || h.includes(UIA_EXPIRED_BODY))
      ).toBe(true);
      expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
    });
  }

  it('parse∥credentials-desc∥cancel∥approve mega race', async () => {
    const spy = vi
      .spyOn(HonoRequest.prototype, 'parseBody')
      .mockRejectedValueOnce(new Error('mega-parse'));
    const cache = mockKv();
    seedUiaSession(cache, 'uia-cred');
    seedUiaSession(cache, 'uia-cancel');
    seedUiaSession(cache, 'uia-ok');
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-ok', username: 'alice', password: 'secret' }),
        env
      ),
      request('/oauth/authorize/uia', formInit({ session: 'uia-cred', password: 'x' }), env),
      request(
        '/oauth/authorize/uia',
        formInit({
          session: 'uia-cancel',
          username: 'alice',
          password: 'secret',
          action: 'cancel',
        }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-ok', username: 'alice', password: 'secret' }),
        env
      ),
    ]);
    spy.mockRestore();
    expect(results.every((r) => r.status === 200)).toBe(true);
    const htmls = htmlOf(results);
    expect(htmls.some((h) => h.includes(UIA_PARSE_BODY))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_CREDENTIALS_DESC))).toBe(true);
    expect(htmls.some((h) => h.includes('Request Cancelled'))).toBe(true);
    expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
  });
});
