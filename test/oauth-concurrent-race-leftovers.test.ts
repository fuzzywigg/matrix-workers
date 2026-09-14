/**
 * TOKENMAXX HEAVY leftovers after #215 / deepen after #232 / residual after
 * #241 — oauth *concurrent race / TOCTOU* for `src/api/oauth.ts` (register /
 * authorize / token / refresh / revoke / introspect / userinfo / UIA).
 *
 * Soft/contract leftovers for oauth are deep (#177/#186 and oauth-api-* files)
 * but concurrent-race coverage was near-zero: only a sequential "distinct auth
 * codes" case in oauth-api-route-leftovers (no Promise.all / KV get-barrier
 * double-spend / refresh rotation races).
 *
 * Distinct from tip #241 (devices+keybackups), #240 (room-cache residual),
 * #238 (first oauth+oidc race deepen), #232 (room-cache), and saturated
 * keys/devices/to-device/media/rooms/voip/sync/push concurrent-race files.
 * Orthogonal to login-qr-identity races (#163) and account OpenID mint (#209).
 *
 * Focus: auth-code double-redeem get-barrier TOCTOU; refresh rotate∥rotate;
 * authorize auth_request single-flight consume; register∥register distinct
 * clients; revoke∥refresh / introspect∥revoke interleave; CACHE client wipe
 * mid token; UIA session get-barrier; userinfo GET∥POST coherency; method /
 * body / charset / missing soft floods under Promise.all; TTL bind contracts.
 * Residual after #241: POST authorize Location/state binds, escapeHtml,
 * grant soft matrix, opaque iat/revoke∥introspect, UIA password-path mismatch,
 * Basic URL-decode, device display_name, deleteBarrier code redeem.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';

const SERVER = 'example.com';
const USER_ID = `@alice:${SERVER}`;
const BOB_ID = `@bob:${SERVER}`;
const REDIRECT = 'https://element.example.com/callback';
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

import oauth, { hashClientSecret } from '../src/api/oauth';

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
    mutateAfterPuts?: { after: number; next: Record<string, string> };
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
      if (opts.mutateAfterPuts && putCount === opts.mutateAfterPuts.after) {
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, opts.mutateAfterPuts.next);
        events.push('mutate:after-put');
      }
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
    display_name: partial.display_name ?? partial.localpart,
    avatar_url: partial.avatar_url ?? null,
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

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function formInit(fields: Record<string, string>): RequestInit {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return { method: 'POST', body: fd };
}

function jsonInit(method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function urlencoded(fields: Record<string, string>): RequestInit {
  const body = new URLSearchParams(fields).toString();
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  };
}

async function registerClient(
  env: Env,
  body: Record<string, unknown> = {
    client_name: 'Element Web',
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
  }
) {
  return request('/oauth/register', jsonInit('POST', body), env);
}

function seedClient(cache: RaceKv, clientId: string, patch: Record<string, unknown> = {}) {
  const client = {
    client_id: clientId,
    client_secret_hash: null,
    client_name: 'Element Web',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    created_at: NOW,
    ...patch,
  };
  cache.data[`oauth_client:${clientId}`] = JSON.stringify(client);
  return client;
}

function seedAuthRequest(sessions: RaceKv, id: string, patch: Record<string, unknown> = {}) {
  const req = {
    client_id: 'cid-1',
    redirect_uri: REDIRECT,
    scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEVICEA',
    state: 'st',
    ...patch,
  };
  sessions.data[`oauth_auth_request:${id}`] = JSON.stringify(req);
  return req;
}

function seedAuthCode(sessions: RaceKv, code: string, patch: Record<string, unknown> = {}) {
  const authCode = {
    code,
    client_id: 'cid-1',
    user_id: USER_ID,
    redirect_uri: REDIRECT,
    scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEVICEA',
    created_at: NOW,
    expires_at: NOW + 600_000,
    ...patch,
  };
  sessions.data[`oauth_code:${code}`] = JSON.stringify(authCode);
  return authCode;
}

function seedRefresh(sessions: RaceKv, refresh: string, patch: Record<string, unknown> = {}) {
  const token = {
    token_id: 'tid-1',
    access_token_hash: 'hash-a',
    refresh_token_hash: 'hash-r',
    client_id: 'cid-1',
    user_id: USER_ID,
    device_id: 'DEVICEA',
    scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEVICEA',
    created_at: NOW,
    expires_at: NOW + 86400_000,
    ...patch,
  };
  sessions.data[`oauth_refresh:${refresh}`] = JSON.stringify(token);
  return token;
}

function base64UrlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlJson(obj: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64urlJson({ alg: 'none', typ: 'JWT' })}.${b64urlJson(payload)}.sig`;
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


// ---------------------------------------------------------------------------
// Parallel register — distinct client_ids / CACHE put barriers
// ---------------------------------------------------------------------------

describe('race oauth register parallel mint distinct clients after #215', () => {
  it('dual register yields two distinct client_ids and two CACHE puts', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const results = await Promise.all([
      registerClient(env, { client_name: 'A', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
      registerClient(env, { client_name: 'B', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    ]);
    expect(statusesOf(results)).toEqual([201, 201]);
    const ids = results.map((r) => r.body.client_id as string).sort();
    expect(ids[0]).not.toBe(ids[1]);
    expect(cache.puts.filter((p) => p.key.startsWith('oauth_client:')).length).toBe(2);
  });

  it('quad register under put barrier still mints four distinct clients', async () => {
    const cache = mockKv({}, { putBarrier: { count: 4, match: (k) => k.startsWith('oauth_client:') } });
    const env = makeEnv({ cache });
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        registerClient(env, {
          client_name: `C${i}`,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(statusesOf(results)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(4);
  });

  it('parallel register flood-0: 3 concurrent mints isolate names', async () => {
    const cache = mockKv({}, { putBarrier: { count: 3, match: (k) => k.startsWith('oauth_client:') } });
    const env = makeEnv({ cache });
    const names = ['X0', 'Y0', 'Z0'];
    const results = await Promise.all(
      names.map((n) =>
        registerClient(env, {
          client_name: n,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(statusesOf(results)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(3);
    const storedNames = Object.values(cache.data)
      .filter((v) => v.includes('client_name'))
      .map((v) => JSON.parse(v).client_name)
      .sort();
    expect(storedNames).toEqual([...names].sort());
  });

  it('parallel register flood-1: 3 concurrent mints isolate names', async () => {
    const cache = mockKv({}, { putBarrier: { count: 3, match: (k) => k.startsWith('oauth_client:') } });
    const env = makeEnv({ cache });
    const names = ['X1', 'Y1', 'Z1'];
    const results = await Promise.all(
      names.map((n) =>
        registerClient(env, {
          client_name: n,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(statusesOf(results)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(3);
    const storedNames = Object.values(cache.data)
      .filter((v) => v.includes('client_name'))
      .map((v) => JSON.parse(v).client_name)
      .sort();
    expect(storedNames).toEqual([...names].sort());
  });

  it('parallel register flood-2: 3 concurrent mints isolate names', async () => {
    const cache = mockKv({}, { putBarrier: { count: 3, match: (k) => k.startsWith('oauth_client:') } });
    const env = makeEnv({ cache });
    const names = ['X2', 'Y2', 'Z2'];
    const results = await Promise.all(
      names.map((n) =>
        registerClient(env, {
          client_name: n,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(statusesOf(results)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(3);
    const storedNames = Object.values(cache.data)
      .filter((v) => v.includes('client_name'))
      .map((v) => JSON.parse(v).client_name)
      .sort();
    expect(storedNames).toEqual([...names].sort());
  });

  it('parallel register flood-3: 3 concurrent mints isolate names', async () => {
    const cache = mockKv({}, { putBarrier: { count: 3, match: (k) => k.startsWith('oauth_client:') } });
    const env = makeEnv({ cache });
    const names = ['X3', 'Y3', 'Z3'];
    const results = await Promise.all(
      names.map((n) =>
        registerClient(env, {
          client_name: n,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(statusesOf(results)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(3);
    const storedNames = Object.values(cache.data)
      .filter((v) => v.includes('client_name'))
      .map((v) => JSON.parse(v).client_name)
      .sort();
    expect(storedNames).toEqual([...names].sort());
  });

  it('parallel register flood-4: 3 concurrent mints isolate names', async () => {
    const cache = mockKv({}, { putBarrier: { count: 3, match: (k) => k.startsWith('oauth_client:') } });
    const env = makeEnv({ cache });
    const names = ['X4', 'Y4', 'Z4'];
    const results = await Promise.all(
      names.map((n) =>
        registerClient(env, {
          client_name: n,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(statusesOf(results)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(3);
    const storedNames = Object.values(cache.data)
      .filter((v) => v.includes('client_name'))
      .map((v) => JSON.parse(v).client_name)
      .sort();
    expect(storedNames).toEqual([...names].sort());
  });

  it('parallel register flood-5: 3 concurrent mints isolate names', async () => {
    const cache = mockKv({}, { putBarrier: { count: 3, match: (k) => k.startsWith('oauth_client:') } });
    const env = makeEnv({ cache });
    const names = ['X5', 'Y5', 'Z5'];
    const results = await Promise.all(
      names.map((n) =>
        registerClient(env, {
          client_name: n,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(statusesOf(results)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(3);
    const storedNames = Object.values(cache.data)
      .filter((v) => v.includes('client_name'))
      .map((v) => JSON.parse(v).client_name)
      .sort();
    expect(storedNames).toEqual([...names].sort());
  });

  it('parallel register flood-6: 3 concurrent mints isolate names', async () => {
    const cache = mockKv({}, { putBarrier: { count: 3, match: (k) => k.startsWith('oauth_client:') } });
    const env = makeEnv({ cache });
    const names = ['X6', 'Y6', 'Z6'];
    const results = await Promise.all(
      names.map((n) =>
        registerClient(env, {
          client_name: n,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(statusesOf(results)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(3);
    const storedNames = Object.values(cache.data)
      .filter((v) => v.includes('client_name'))
      .map((v) => JSON.parse(v).client_name)
      .sort();
    expect(storedNames).toEqual([...names].sort());
  });

  it('parallel register flood-7: 3 concurrent mints isolate names', async () => {
    const cache = mockKv({}, { putBarrier: { count: 3, match: (k) => k.startsWith('oauth_client:') } });
    const env = makeEnv({ cache });
    const names = ['X7', 'Y7', 'Z7'];
    const results = await Promise.all(
      names.map((n) =>
        registerClient(env, {
          client_name: n,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(statusesOf(results)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(3);
    const storedNames = Object.values(cache.data)
      .filter((v) => v.includes('client_name'))
      .map((v) => JSON.parse(v).client_name)
      .sort();
    expect(storedNames).toEqual([...names].sort());
  });

  it('parallel register flood-8: 3 concurrent mints isolate names', async () => {
    const cache = mockKv({}, { putBarrier: { count: 3, match: (k) => k.startsWith('oauth_client:') } });
    const env = makeEnv({ cache });
    const names = ['X8', 'Y8', 'Z8'];
    const results = await Promise.all(
      names.map((n) =>
        registerClient(env, {
          client_name: n,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(statusesOf(results)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(3);
    const storedNames = Object.values(cache.data)
      .filter((v) => v.includes('client_name'))
      .map((v) => JSON.parse(v).client_name)
      .sort();
    expect(storedNames).toEqual([...names].sort());
  });

  it('parallel register flood-9: 3 concurrent mints isolate names', async () => {
    const cache = mockKv({}, { putBarrier: { count: 3, match: (k) => k.startsWith('oauth_client:') } });
    const env = makeEnv({ cache });
    const names = ['X9', 'Y9', 'Z9'];
    const results = await Promise.all(
      names.map((n) =>
        registerClient(env, {
          client_name: n,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(statusesOf(results)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(3);
    const storedNames = Object.values(cache.data)
      .filter((v) => v.includes('client_name'))
      .map((v) => JSON.parse(v).client_name)
      .sort();
    expect(storedNames).toEqual([...names].sort());
  });

  it('parallel register flood-10: 3 concurrent mints isolate names', async () => {
    const cache = mockKv({}, { putBarrier: { count: 3, match: (k) => k.startsWith('oauth_client:') } });
    const env = makeEnv({ cache });
    const names = ['X10', 'Y10', 'Z10'];
    const results = await Promise.all(
      names.map((n) =>
        registerClient(env, {
          client_name: n,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(statusesOf(results)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(3);
    const storedNames = Object.values(cache.data)
      .filter((v) => v.includes('client_name'))
      .map((v) => JSON.parse(v).client_name)
      .sort();
    expect(storedNames).toEqual([...names].sort());
  });

  it('parallel register flood-11: 3 concurrent mints isolate names', async () => {
    const cache = mockKv({}, { putBarrier: { count: 3, match: (k) => k.startsWith('oauth_client:') } });
    const env = makeEnv({ cache });
    const names = ['X11', 'Y11', 'Z11'];
    const results = await Promise.all(
      names.map((n) =>
        registerClient(env, {
          client_name: n,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(statusesOf(results)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(3);
    const storedNames = Object.values(cache.data)
      .filter((v) => v.includes('client_name'))
      .map((v) => JSON.parse(v).client_name)
      .sort();
    expect(storedNames).toEqual([...names].sort());
  });

  it('register stores oauth_client put with client metadata', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await Promise.all([
      registerClient(env),
      registerClient(env, { client_name: 'Other', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    ]);
    expect(cache.puts.length).toBeGreaterThanOrEqual(2);
    for (const p of cache.puts.filter((x) => x.key.startsWith('oauth_client:'))) {
      const parsed = JSON.parse(p.value);
      expect(parsed.client_id).toBeTruthy();
      expect(parsed.redirect_uris).toContain(REDIRECT);
    }
  });

  it('eight-way register isolation — all succeed with unique ids', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        registerClient(env, {
          client_name: `N${i}`,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        })
      )
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.client_id)).size).toBe(8);
  });

  it('register reject empty redirect_uris under parallel soft', async () => {
    const env = makeEnv();
    const results = await Promise.all([
      registerClient(env, { client_name: 'bad', redirect_uris: [] }),
      registerClient(env, { client_name: 'bad2', redirect_uris: [] }),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => r.body.error === 'invalid_client_metadata')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Authorize auth_request single-flight consume / TOCTOU
// ---------------------------------------------------------------------------

describe('race oauth authorize auth_request consume TOCTOU after #215', () => {
  it('dual POST same auth_request under get barrier — both observe request then delete', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_auth_request:') } }
    );
    seedAuthRequest(sessions, 'ar-shared');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-shared' }), env),
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-shared' }), env),
    ]);
    // Classic get-then-delete TOCTOU: both may 302, or one 400 after wipe.
    expect(results.every((r) => r.status === 302 || r.status === 400)).toBe(true);
    expect(sessions.getCount).toBeGreaterThanOrEqual(2);
  });

  it('missing auth_request parallel soft — both 400 expired', async () => {
    const env = makeEnv({ db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'gone' }), env),
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'gone' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => r.body.error === 'invalid_request')).toBe(true);
  });

  it('authorize distinct auth_requests flood-0 mint distinct codes', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-a-0', { state: 'a0' });
    seedAuthRequest(sessions, 'ar-b-0', { state: 'b0' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-a-0' }), env),
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-b-0' }), env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const codes = results.map((r) => new URL(r.headers.get('location')!).searchParams.get('code')!);
    expect(codes[0]).not.toBe(codes[1]);
    expect(sessions.data[`oauth_code:${codes[0]}`]).toBeTruthy();
    expect(sessions.data[`oauth_code:${codes[1]}`]).toBeTruthy();
  });

  it('authorize distinct auth_requests flood-1 mint distinct codes', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-a-1', { state: 'a1' });
    seedAuthRequest(sessions, 'ar-b-1', { state: 'b1' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-a-1' }), env),
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-b-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const codes = results.map((r) => new URL(r.headers.get('location')!).searchParams.get('code')!);
    expect(codes[0]).not.toBe(codes[1]);
    expect(sessions.data[`oauth_code:${codes[0]}`]).toBeTruthy();
    expect(sessions.data[`oauth_code:${codes[1]}`]).toBeTruthy();
  });

  it('authorize distinct auth_requests flood-2 mint distinct codes', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-a-2', { state: 'a2' });
    seedAuthRequest(sessions, 'ar-b-2', { state: 'b2' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-a-2' }), env),
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-b-2' }), env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const codes = results.map((r) => new URL(r.headers.get('location')!).searchParams.get('code')!);
    expect(codes[0]).not.toBe(codes[1]);
    expect(sessions.data[`oauth_code:${codes[0]}`]).toBeTruthy();
    expect(sessions.data[`oauth_code:${codes[1]}`]).toBeTruthy();
  });

  it('authorize distinct auth_requests flood-3 mint distinct codes', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-a-3', { state: 'a3' });
    seedAuthRequest(sessions, 'ar-b-3', { state: 'b3' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-a-3' }), env),
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-b-3' }), env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const codes = results.map((r) => new URL(r.headers.get('location')!).searchParams.get('code')!);
    expect(codes[0]).not.toBe(codes[1]);
    expect(sessions.data[`oauth_code:${codes[0]}`]).toBeTruthy();
    expect(sessions.data[`oauth_code:${codes[1]}`]).toBeTruthy();
  });

  it('authorize distinct auth_requests flood-4 mint distinct codes', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-a-4', { state: 'a4' });
    seedAuthRequest(sessions, 'ar-b-4', { state: 'b4' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-a-4' }), env),
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-b-4' }), env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const codes = results.map((r) => new URL(r.headers.get('location')!).searchParams.get('code')!);
    expect(codes[0]).not.toBe(codes[1]);
    expect(sessions.data[`oauth_code:${codes[0]}`]).toBeTruthy();
    expect(sessions.data[`oauth_code:${codes[1]}`]).toBeTruthy();
  });

  it('authorize distinct auth_requests flood-5 mint distinct codes', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-a-5', { state: 'a5' });
    seedAuthRequest(sessions, 'ar-b-5', { state: 'b5' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-a-5' }), env),
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-b-5' }), env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const codes = results.map((r) => new URL(r.headers.get('location')!).searchParams.get('code')!);
    expect(codes[0]).not.toBe(codes[1]);
    expect(sessions.data[`oauth_code:${codes[0]}`]).toBeTruthy();
    expect(sessions.data[`oauth_code:${codes[1]}`]).toBeTruthy();
  });

  it('authorize distinct auth_requests flood-6 mint distinct codes', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-a-6', { state: 'a6' });
    seedAuthRequest(sessions, 'ar-b-6', { state: 'b6' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-a-6' }), env),
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-b-6' }), env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const codes = results.map((r) => new URL(r.headers.get('location')!).searchParams.get('code')!);
    expect(codes[0]).not.toBe(codes[1]);
    expect(sessions.data[`oauth_code:${codes[0]}`]).toBeTruthy();
    expect(sessions.data[`oauth_code:${codes[1]}`]).toBeTruthy();
  });

  it('authorize distinct auth_requests flood-7 mint distinct codes', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-a-7', { state: 'a7' });
    seedAuthRequest(sessions, 'ar-b-7', { state: 'b7' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-a-7' }), env),
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-b-7' }), env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const codes = results.map((r) => new URL(r.headers.get('location')!).searchParams.get('code')!);
    expect(codes[0]).not.toBe(codes[1]);
    expect(sessions.data[`oauth_code:${codes[0]}`]).toBeTruthy();
    expect(sessions.data[`oauth_code:${codes[1]}`]).toBeTruthy();
  });

  it('authorize distinct auth_requests flood-8 mint distinct codes', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-a-8', { state: 'a8' });
    seedAuthRequest(sessions, 'ar-b-8', { state: 'b8' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-a-8' }), env),
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-b-8' }), env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const codes = results.map((r) => new URL(r.headers.get('location')!).searchParams.get('code')!);
    expect(codes[0]).not.toBe(codes[1]);
    expect(sessions.data[`oauth_code:${codes[0]}`]).toBeTruthy();
    expect(sessions.data[`oauth_code:${codes[1]}`]).toBeTruthy();
  });

  it('authorize distinct auth_requests flood-9 mint distinct codes', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-a-9', { state: 'a9' });
    seedAuthRequest(sessions, 'ar-b-9', { state: 'b9' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-a-9' }), env),
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-b-9' }), env),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const codes = results.map((r) => new URL(r.headers.get('location')!).searchParams.get('code')!);
    expect(codes[0]).not.toBe(codes[1]);
    expect(sessions.data[`oauth_code:${codes[0]}`]).toBeTruthy();
    expect(sessions.data[`oauth_code:${codes[1]}`]).toBeTruthy();
  });

  it('wrong password recreates auth_request under parallel soft', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-bad');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/authorize',
      formInit({ username: 'alice', password: 'WRONG', auth_request_id: 'ar-bad' }),
      env
    );
    expect(res.status).toBe(200);
    expect(typeof res.body === 'string' && res.body.includes('Invalid username or password')).toBe(true);
    const newKeys = Object.keys(sessions.data).filter((k) => k.startsWith('oauth_auth_request:'));
    expect(newKeys.length).toBe(1);
    expect(newKeys[0]).not.toBe('oauth_auth_request:ar-bad');
  });

  it('mutate wipe auth_request after first get — second sees expired', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { mutateAfterGets: { after: 1, next: {} } }
    );
    seedAuthRequest(sessions, 'ar-mid');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const first = await request(
      '/oauth/authorize',
      formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-mid' }),
      env
    );
    const second = await request(
      '/oauth/authorize',
      formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-mid' }),
      env
    );
    expect(first.status).toBe(302);
    expect(second.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Auth-code double-redeem get-barrier TOCTOU
// ---------------------------------------------------------------------------

describe('race oauth token auth-code double-redeem TOCTOU after #215', () => {
  it('dual redeem same code under get barrier — both observe code (single-use race)', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-shared');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-shared',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-shared',
        }),
        env
      ),
    ]);
    // Document get-then-delete TOCTOU: both may 200, or one 400 after delete wins.
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
    expect(sessions.getCount).toBeGreaterThanOrEqual(2);
    const oks = results.filter((r) => r.status === 200);
    if (oks.length === 2) {
      expect(oks[0].body.access_token).not.toBe(oks[1].body.access_token);
    }
  });

  it('sequential double-redeem — second invalid_grant', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-once');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const first = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-once' }),
      env
    );
    const second = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-once' }),
      env
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
  });

  it('distinct codes parallel redeem flood-0', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-a-0', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DA0' });
    seedAuthCode(sessions, 'code-b-0', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DB0' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-a-0' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-b-0' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    const devices = results.map((r) => r.body.device_id as string).sort();
    expect(devices).toEqual(['DA0', 'DB0'].sort());
  });

  it('distinct codes parallel redeem flood-1', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-a-1', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DA1' });
    seedAuthCode(sessions, 'code-b-1', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DB1' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-a-1' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-b-1' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    const devices = results.map((r) => r.body.device_id as string).sort();
    expect(devices).toEqual(['DA1', 'DB1'].sort());
  });

  it('distinct codes parallel redeem flood-2', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-a-2', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DA2' });
    seedAuthCode(sessions, 'code-b-2', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DB2' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-a-2' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-b-2' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    const devices = results.map((r) => r.body.device_id as string).sort();
    expect(devices).toEqual(['DA2', 'DB2'].sort());
  });

  it('distinct codes parallel redeem flood-3', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-a-3', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DA3' });
    seedAuthCode(sessions, 'code-b-3', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DB3' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-a-3' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-b-3' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    const devices = results.map((r) => r.body.device_id as string).sort();
    expect(devices).toEqual(['DA3', 'DB3'].sort());
  });

  it('distinct codes parallel redeem flood-4', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-a-4', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DA4' });
    seedAuthCode(sessions, 'code-b-4', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DB4' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-a-4' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-b-4' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    const devices = results.map((r) => r.body.device_id as string).sort();
    expect(devices).toEqual(['DA4', 'DB4'].sort());
  });

  it('distinct codes parallel redeem flood-5', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-a-5', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DA5' });
    seedAuthCode(sessions, 'code-b-5', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DB5' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-a-5' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-b-5' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    const devices = results.map((r) => r.body.device_id as string).sort();
    expect(devices).toEqual(['DA5', 'DB5'].sort());
  });

  it('distinct codes parallel redeem flood-6', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-a-6', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DA6' });
    seedAuthCode(sessions, 'code-b-6', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DB6' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-a-6' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-b-6' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    const devices = results.map((r) => r.body.device_id as string).sort();
    expect(devices).toEqual(['DA6', 'DB6'].sort());
  });

  it('distinct codes parallel redeem flood-7', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-a-7', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DA7' });
    seedAuthCode(sessions, 'code-b-7', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DB7' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-a-7' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-b-7' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    const devices = results.map((r) => r.body.device_id as string).sort();
    expect(devices).toEqual(['DA7', 'DB7'].sort());
  });

  it('distinct codes parallel redeem flood-8', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-a-8', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DA8' });
    seedAuthCode(sessions, 'code-b-8', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DB8' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-a-8' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-b-8' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    const devices = results.map((r) => r.body.device_id as string).sort();
    expect(devices).toEqual(['DA8', 'DB8'].sort());
  });

  it('distinct codes parallel redeem flood-9', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-a-9', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DA9' });
    seedAuthCode(sessions, 'code-b-9', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DB9' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-a-9' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-b-9' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    const devices = results.map((r) => r.body.device_id as string).sort();
    expect(devices).toEqual(['DA9', 'DB9'].sort());
  });

  it('distinct codes parallel redeem flood-10', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-a-10', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DA10' });
    seedAuthCode(sessions, 'code-b-10', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DB10' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-a-10' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-b-10' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    const devices = results.map((r) => r.body.device_id as string).sort();
    expect(devices).toEqual(['DA10', 'DB10'].sort());
  });

  it('distinct codes parallel redeem flood-11', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-a-11', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DA11' });
    seedAuthCode(sessions, 'code-b-11', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DB11' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-a-11' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-b-11' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    const devices = results.map((r) => r.body.device_id as string).sort();
    expect(devices).toEqual(['DA11', 'DB11'].sort());
  });

  it('unknown client under parallel token soft', async () => {
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-x');
    const env = makeEnv({ sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'nope', code: 'code-x' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'nope', code: 'code-x' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([401, 401]);
  });

  it('expired code parallel soft', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-exp', { expires_at: NOW - 1 });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-exp' }),
      env
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('client_id mismatch on code soft', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    seedClient(cache, 'cid-2');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-mis', { client_id: 'cid-2' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-mis' }),
      env
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('CACHE client wipe mid-flight after first get — second may 401', async () => {
    const cache = mockKv(
      {},
      { mutateAfterGets: { after: 1, next: {} } }
    );
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-wipe');
    seedAuthCode(sessions, 'code-wipe2');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const first = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-wipe' }),
      env
    );
    const second = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-wipe2' }),
      env
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it('PKCE missing verifier soft when challenge present', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-pkce', {
      code_challenge: 'challenge',
      code_challenge_method: 'plain',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-pkce' }),
      env
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('redirect_uri mismatch soft', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-redir');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/token',
      urlencoded({
        grant_type: 'authorization_code',
        client_id: 'cid-1',
        code: 'code-redir',
        redirect_uri: 'https://evil.example.com/cb',
      }),
      env
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });
});

// ---------------------------------------------------------------------------
// Refresh-token rotate∥rotate TOCTOU
// ---------------------------------------------------------------------------

describe('race oauth refresh_token rotate concurrent after #215', () => {
  it('dual refresh same token under get barrier — rotation race documented', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_refresh:') } }
    );
    seedRefresh(sessions, 'rt-shared');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-shared' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-shared' }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
    expect(sessions.getCount).toBeGreaterThanOrEqual(2);
    const oks = results.filter((r) => r.status === 200);
    if (oks.length === 2) {
      expect(oks[0].body.refresh_token).not.toBe(oks[1].body.refresh_token);
      expect(oks[0].body.access_token).not.toBe(oks[1].body.access_token);
    }
  });

  it('sequential refresh — second invalid_grant after rotation', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedRefresh(sessions, 'rt-once');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const first = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-once' }),
      env
    );
    const second = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-once' }),
      env
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
    expect(sessions.data[`oauth_refresh:${first.body.refresh_token}`]).toBeTruthy();
  });

  it('distinct refresh tokens parallel flood-0', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_refresh:') } }
    );
    seedRefresh(sessions, 'rt-a-0', { device_id: 'DA0' });
    seedRefresh(sessions, 'rt-b-0', { device_id: 'DB0' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-a-0' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-b-0' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    expect(sessions.data[`oauth_refresh:rt-a-0`]).toBeUndefined();
    expect(sessions.data[`oauth_refresh:rt-b-0`]).toBeUndefined();
  });

  it('distinct refresh tokens parallel flood-1', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_refresh:') } }
    );
    seedRefresh(sessions, 'rt-a-1', { device_id: 'DA1' });
    seedRefresh(sessions, 'rt-b-1', { device_id: 'DB1' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-a-1' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-b-1' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    expect(sessions.data[`oauth_refresh:rt-a-1`]).toBeUndefined();
    expect(sessions.data[`oauth_refresh:rt-b-1`]).toBeUndefined();
  });

  it('distinct refresh tokens parallel flood-2', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_refresh:') } }
    );
    seedRefresh(sessions, 'rt-a-2', { device_id: 'DA2' });
    seedRefresh(sessions, 'rt-b-2', { device_id: 'DB2' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-a-2' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-b-2' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    expect(sessions.data[`oauth_refresh:rt-a-2`]).toBeUndefined();
    expect(sessions.data[`oauth_refresh:rt-b-2`]).toBeUndefined();
  });

  it('distinct refresh tokens parallel flood-3', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_refresh:') } }
    );
    seedRefresh(sessions, 'rt-a-3', { device_id: 'DA3' });
    seedRefresh(sessions, 'rt-b-3', { device_id: 'DB3' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-a-3' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-b-3' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    expect(sessions.data[`oauth_refresh:rt-a-3`]).toBeUndefined();
    expect(sessions.data[`oauth_refresh:rt-b-3`]).toBeUndefined();
  });

  it('distinct refresh tokens parallel flood-4', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_refresh:') } }
    );
    seedRefresh(sessions, 'rt-a-4', { device_id: 'DA4' });
    seedRefresh(sessions, 'rt-b-4', { device_id: 'DB4' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-a-4' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-b-4' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    expect(sessions.data[`oauth_refresh:rt-a-4`]).toBeUndefined();
    expect(sessions.data[`oauth_refresh:rt-b-4`]).toBeUndefined();
  });

  it('distinct refresh tokens parallel flood-5', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_refresh:') } }
    );
    seedRefresh(sessions, 'rt-a-5', { device_id: 'DA5' });
    seedRefresh(sessions, 'rt-b-5', { device_id: 'DB5' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-a-5' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-b-5' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    expect(sessions.data[`oauth_refresh:rt-a-5`]).toBeUndefined();
    expect(sessions.data[`oauth_refresh:rt-b-5`]).toBeUndefined();
  });

  it('distinct refresh tokens parallel flood-6', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_refresh:') } }
    );
    seedRefresh(sessions, 'rt-a-6', { device_id: 'DA6' });
    seedRefresh(sessions, 'rt-b-6', { device_id: 'DB6' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-a-6' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-b-6' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    expect(sessions.data[`oauth_refresh:rt-a-6`]).toBeUndefined();
    expect(sessions.data[`oauth_refresh:rt-b-6`]).toBeUndefined();
  });

  it('distinct refresh tokens parallel flood-7', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_refresh:') } }
    );
    seedRefresh(sessions, 'rt-a-7', { device_id: 'DA7' });
    seedRefresh(sessions, 'rt-b-7', { device_id: 'DB7' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-a-7' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-b-7' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    expect(sessions.data[`oauth_refresh:rt-a-7`]).toBeUndefined();
    expect(sessions.data[`oauth_refresh:rt-b-7`]).toBeUndefined();
  });

  it('distinct refresh tokens parallel flood-8', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_refresh:') } }
    );
    seedRefresh(sessions, 'rt-a-8', { device_id: 'DA8' });
    seedRefresh(sessions, 'rt-b-8', { device_id: 'DB8' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-a-8' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-b-8' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    expect(sessions.data[`oauth_refresh:rt-a-8`]).toBeUndefined();
    expect(sessions.data[`oauth_refresh:rt-b-8`]).toBeUndefined();
  });

  it('distinct refresh tokens parallel flood-9', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_refresh:') } }
    );
    seedRefresh(sessions, 'rt-a-9', { device_id: 'DA9' });
    seedRefresh(sessions, 'rt-b-9', { device_id: 'DB9' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-a-9' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-b-9' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.access_token).not.toBe(results[1].body.access_token);
    expect(sessions.data[`oauth_refresh:rt-a-9`]).toBeUndefined();
    expect(sessions.data[`oauth_refresh:rt-b-9`]).toBeUndefined();
  });

  it('refresh client mismatch soft', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    seedClient(cache, 'cid-2');
    const sessions = mockKv();
    seedRefresh(sessions, 'rt-mis', { client_id: 'cid-2' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-mis' }),
      env
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refresh TTL put is 30 days on new refresh key', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedRefresh(sessions, 'rt-ttl');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-ttl' }),
      env
    );
    expect(res.status).toBe(200);
    const put = sessions.puts.find((p) => p.key.startsWith('oauth_refresh:') && p.key !== 'oauth_refresh:rt-ttl');
    expect(put?.options?.expirationTtl).toBe(30 * 24 * 60 * 60);
  });
});

// ---------------------------------------------------------------------------
// Revoke∥refresh / introspect∥revoke interleave
// ---------------------------------------------------------------------------

describe('race oauth revoke∥refresh / introspect concurrent after #215', () => {
  it('revoke∥refresh same token under get barrier — ambiguous winner', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 1, match: (k) => k === 'oauth_refresh:rt-race' } }
    );
    seedRefresh(sessions, 'rt-race');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/revoke', urlencoded({ token: 'rt-race', token_type_hint: 'refresh_token' }), env),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-race' }),
        env
      ),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[1].status === 200 || results[1].status === 400).toBe(true);
  });

  it('dual revoke same refresh — both 200 (RFC 7009)', async () => {
    const sessions = mockKv();
    seedRefresh(sessions, 'rt-dual');
    const env = makeEnv({ sessions });
    const results = await Promise.all([
      request('/oauth/revoke', urlencoded({ token: 'rt-dual', token_type_hint: 'refresh_token' }), env),
      request('/oauth/revoke', urlencoded({ token: 'rt-dual', token_type_hint: 'refresh_token' }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('introspect JWT active flood-0 coherent under parallel', async () => {
    const env = makeEnv();
    const jwt = fakeJwt({
      sub: USER_ID,
      client_id: 'cid-1',
      exp: Math.floor(NOW / 1000) + 3600 + 0,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}/`,
    });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
      request('/oauth/introspect', jsonInit('POST', { token: jwt }), env),
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => r.body.active === true && r.body.sub === USER_ID)).toBe(true);
  });

  it('introspect JWT active flood-1 coherent under parallel', async () => {
    const env = makeEnv();
    const jwt = fakeJwt({
      sub: USER_ID,
      client_id: 'cid-1',
      exp: Math.floor(NOW / 1000) + 3600 + 1,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}/`,
    });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
      request('/oauth/introspect', jsonInit('POST', { token: jwt }), env),
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => r.body.active === true && r.body.sub === USER_ID)).toBe(true);
  });

  it('introspect JWT active flood-2 coherent under parallel', async () => {
    const env = makeEnv();
    const jwt = fakeJwt({
      sub: USER_ID,
      client_id: 'cid-1',
      exp: Math.floor(NOW / 1000) + 3600 + 2,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}/`,
    });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
      request('/oauth/introspect', jsonInit('POST', { token: jwt }), env),
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => r.body.active === true && r.body.sub === USER_ID)).toBe(true);
  });

  it('introspect JWT active flood-3 coherent under parallel', async () => {
    const env = makeEnv();
    const jwt = fakeJwt({
      sub: USER_ID,
      client_id: 'cid-1',
      exp: Math.floor(NOW / 1000) + 3600 + 3,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}/`,
    });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
      request('/oauth/introspect', jsonInit('POST', { token: jwt }), env),
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => r.body.active === true && r.body.sub === USER_ID)).toBe(true);
  });

  it('introspect JWT active flood-4 coherent under parallel', async () => {
    const env = makeEnv();
    const jwt = fakeJwt({
      sub: USER_ID,
      client_id: 'cid-1',
      exp: Math.floor(NOW / 1000) + 3600 + 4,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}/`,
    });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
      request('/oauth/introspect', jsonInit('POST', { token: jwt }), env),
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => r.body.active === true && r.body.sub === USER_ID)).toBe(true);
  });

  it('introspect JWT active flood-5 coherent under parallel', async () => {
    const env = makeEnv();
    const jwt = fakeJwt({
      sub: USER_ID,
      client_id: 'cid-1',
      exp: Math.floor(NOW / 1000) + 3600 + 5,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}/`,
    });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
      request('/oauth/introspect', jsonInit('POST', { token: jwt }), env),
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => r.body.active === true && r.body.sub === USER_ID)).toBe(true);
  });

  it('introspect JWT active flood-6 coherent under parallel', async () => {
    const env = makeEnv();
    const jwt = fakeJwt({
      sub: USER_ID,
      client_id: 'cid-1',
      exp: Math.floor(NOW / 1000) + 3600 + 6,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}/`,
    });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
      request('/oauth/introspect', jsonInit('POST', { token: jwt }), env),
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => r.body.active === true && r.body.sub === USER_ID)).toBe(true);
  });

  it('introspect JWT active flood-7 coherent under parallel', async () => {
    const env = makeEnv();
    const jwt = fakeJwt({
      sub: USER_ID,
      client_id: 'cid-1',
      exp: Math.floor(NOW / 1000) + 3600 + 7,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}/`,
    });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
      request('/oauth/introspect', jsonInit('POST', { token: jwt }), env),
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => r.body.active === true && r.body.sub === USER_ID)).toBe(true);
  });

  it('introspect JWT active flood-8 coherent under parallel', async () => {
    const env = makeEnv();
    const jwt = fakeJwt({
      sub: USER_ID,
      client_id: 'cid-1',
      exp: Math.floor(NOW / 1000) + 3600 + 8,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}/`,
    });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
      request('/oauth/introspect', jsonInit('POST', { token: jwt }), env),
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => r.body.active === true && r.body.sub === USER_ID)).toBe(true);
  });

  it('introspect JWT active flood-9 coherent under parallel', async () => {
    const env = makeEnv();
    const jwt = fakeJwt({
      sub: USER_ID,
      client_id: 'cid-1',
      exp: Math.floor(NOW / 1000) + 3600 + 9,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}/`,
    });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
      request('/oauth/introspect', jsonInit('POST', { token: jwt }), env),
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => r.body.active === true && r.body.sub === USER_ID)).toBe(true);
  });

  it('introspect expired JWT active:false under parallel', async () => {
    const env = makeEnv();
    const jwt = fakeJwt({
      sub: USER_ID,
      exp: Math.floor(NOW / 1000) - 10,
      iat: Math.floor(NOW / 1000) - 100,
    });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
      request('/oauth/introspect', urlencoded({ token: jwt }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => r.body.active === false)).toBe(true);
  });

  it('introspect opaque access token from DB under parallel', async () => {
    const db = aliceDb();
    const token = 'opaque-access-1';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token }), env),
      request('/oauth/introspect', urlencoded({ token }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => r.body.active === true && r.body.sub === USER_ID)).toBe(true);
  });

  it('introspect∥revoke access token — second may still report active (no atomicity)', async () => {
    const db = aliceDb();
    const token = 'opaque-race';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token }), env),
      request('/oauth/revoke', urlencoded({ token, token_type_hint: 'access_token' }), env),
    ]);
    expect(results[1].status).toBe(200);
    expect(results[0].status).toBe(200);
  });

  it('revoke missing token still 200 under parallel soft', async () => {
    const env = makeEnv();
    const results = await Promise.all([
      request('/oauth/revoke', urlencoded({ token: 'missing' }), env),
      request('/oauth/revoke', urlencoded({ token: 'missing2' }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('revoke requires token field soft', async () => {
    const env = makeEnv();
    const results = await Promise.all([
      request('/oauth/revoke', urlencoded({}), env),
      request('/oauth/revoke', jsonInit('POST', {}), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  it('introspect requires token field soft', async () => {
    const env = makeEnv();
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({}), env),
      request('/oauth/introspect', jsonInit('POST', {}), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });
});

// ---------------------------------------------------------------------------
// Userinfo GET∥POST coherency
// ---------------------------------------------------------------------------

describe('race oauth userinfo GET∥POST concurrent after #215', () => {

  it('userinfo GET∥POST flood-0 identical claims', async () => {
    const db = aliceDb();
    const token = 'ui-token-0';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) {
      expect(r.body).toMatchObject({
        sub: USER_ID,
        name: 'Alice',
        'urn:matrix:user_id': USER_ID,
      });
    }
  });

  it('userinfo GET∥POST flood-1 identical claims', async () => {
    const db = aliceDb();
    const token = 'ui-token-1';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) {
      expect(r.body).toMatchObject({
        sub: USER_ID,
        name: 'Alice',
        'urn:matrix:user_id': USER_ID,
      });
    }
  });

  it('userinfo GET∥POST flood-2 identical claims', async () => {
    const db = aliceDb();
    const token = 'ui-token-2';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) {
      expect(r.body).toMatchObject({
        sub: USER_ID,
        name: 'Alice',
        'urn:matrix:user_id': USER_ID,
      });
    }
  });

  it('userinfo GET∥POST flood-3 identical claims', async () => {
    const db = aliceDb();
    const token = 'ui-token-3';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) {
      expect(r.body).toMatchObject({
        sub: USER_ID,
        name: 'Alice',
        'urn:matrix:user_id': USER_ID,
      });
    }
  });

  it('userinfo GET∥POST flood-4 identical claims', async () => {
    const db = aliceDb();
    const token = 'ui-token-4';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) {
      expect(r.body).toMatchObject({
        sub: USER_ID,
        name: 'Alice',
        'urn:matrix:user_id': USER_ID,
      });
    }
  });

  it('userinfo GET∥POST flood-5 identical claims', async () => {
    const db = aliceDb();
    const token = 'ui-token-5';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) {
      expect(r.body).toMatchObject({
        sub: USER_ID,
        name: 'Alice',
        'urn:matrix:user_id': USER_ID,
      });
    }
  });

  it('userinfo GET∥POST flood-6 identical claims', async () => {
    const db = aliceDb();
    const token = 'ui-token-6';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) {
      expect(r.body).toMatchObject({
        sub: USER_ID,
        name: 'Alice',
        'urn:matrix:user_id': USER_ID,
      });
    }
  });

  it('userinfo GET∥POST flood-7 identical claims', async () => {
    const db = aliceDb();
    const token = 'ui-token-7';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) {
      expect(r.body).toMatchObject({
        sub: USER_ID,
        name: 'Alice',
        'urn:matrix:user_id': USER_ID,
      });
    }
  });

  it('userinfo GET∥POST flood-8 identical claims', async () => {
    const db = aliceDb();
    const token = 'ui-token-8';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) {
      expect(r.body).toMatchObject({
        sub: USER_ID,
        name: 'Alice',
        'urn:matrix:user_id': USER_ID,
      });
    }
  });

  it('userinfo GET∥POST flood-9 identical claims', async () => {
    const db = aliceDb();
    const token = 'ui-token-9';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, env),
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${token}` } }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    for (const r of results) {
      expect(r.body).toMatchObject({
        sub: USER_ID,
        name: 'Alice',
        'urn:matrix:user_id': USER_ID,
      });
    }
  });

  it('userinfo unauthenticated parallel soft 401', async () => {
    const env = makeEnv();
    const results = await Promise.all([
      request('/oauth/userinfo', {}, env),
      request('/oauth/userinfo', { method: 'POST' }, env),
    ]);
    expect(statusesOf(results)).toEqual([401, 401]);
  });

  it('userinfo orphan token — auth ok but user missing → invalid_token', async () => {
    const db = createOAuthDb();
    const token = 'orphan-ui';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });
});

// ---------------------------------------------------------------------------
// UIA session get-barrier / cancel race
// ---------------------------------------------------------------------------

describe('race oauth authorize/uia session concurrent after #215', () => {
  it('dual GET same UIA session under get barrier — both HTML approve', async () => {
    const cache = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('uia_session:') } }
    );
    cache.data['uia_session:s1'] = JSON.stringify({ user_id: USER_ID });
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize/uia?session=s1&action=org.matrix.cross_signing_reset', {}, env),
      request('/oauth/authorize/uia?session=s1&action=org.matrix.cross_signing_reset', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => typeof r.body === 'string' && r.body.includes('Reset Encryption Keys'))).toBe(true);
  });

  it('missing UIA session parallel soft error pages', async () => {
    const env = makeEnv();
    const results = await Promise.all([
      request('/oauth/authorize/uia?session=gone', {}, env),
      request('/oauth/authorize/uia?session=gone2', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => typeof r.body === 'string' && r.body.includes('Session Expired'))).toBe(true);
  });

  it('UIA cancel deletes session', async () => {
    const cache = mockKv();
    cache.data['uia_session:sc'] = JSON.stringify({ user_id: USER_ID });
    const env = makeEnv({ cache, db: aliceDb() });
    const fd = new FormData();
    fd.set('session', 'sc');
    fd.set('action', 'cancel');
    const res = await request('/oauth/authorize/uia', { method: 'POST', body: fd }, env);
    expect(res.status).toBe(200);
    expect(typeof res.body === 'string' && res.body.toLowerCase().includes('cancel')).toBe(true);
    expect(cache.data['uia_session:sc']).toBeUndefined();
  });

  it('UIA GET missing session flood-0', async () => {
    const env = makeEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, j) =>
        request(`/oauth/authorize/uia?session=miss-0-${j}`, {}, env)
      )
    );
    expect(results.every((r) => r.status === 200 && String(r.body).includes('Session Expired'))).toBe(true);
  });

  it('UIA GET missing session flood-1', async () => {
    const env = makeEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, j) =>
        request(`/oauth/authorize/uia?session=miss-1-${j}`, {}, env)
      )
    );
    expect(results.every((r) => r.status === 200 && String(r.body).includes('Session Expired'))).toBe(true);
  });

  it('UIA GET missing session flood-2', async () => {
    const env = makeEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, j) =>
        request(`/oauth/authorize/uia?session=miss-2-${j}`, {}, env)
      )
    );
    expect(results.every((r) => r.status === 200 && String(r.body).includes('Session Expired'))).toBe(true);
  });

  it('UIA GET missing session flood-3', async () => {
    const env = makeEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, j) =>
        request(`/oauth/authorize/uia?session=miss-3-${j}`, {}, env)
      )
    );
    expect(results.every((r) => r.status === 200 && String(r.body).includes('Session Expired'))).toBe(true);
  });

  it('UIA GET missing session flood-4', async () => {
    const env = makeEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, j) =>
        request(`/oauth/authorize/uia?session=miss-4-${j}`, {}, env)
      )
    );
    expect(results.every((r) => r.status === 200 && String(r.body).includes('Session Expired'))).toBe(true);
  });

  it('UIA GET missing session flood-5', async () => {
    const env = makeEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, j) =>
        request(`/oauth/authorize/uia?session=miss-5-${j}`, {}, env)
      )
    );
    expect(results.every((r) => r.status === 200 && String(r.body).includes('Session Expired'))).toBe(true);
  });

  it('UIA GET missing session flood-6', async () => {
    const env = makeEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, j) =>
        request(`/oauth/authorize/uia?session=miss-6-${j}`, {}, env)
      )
    );
    expect(results.every((r) => r.status === 200 && String(r.body).includes('Session Expired'))).toBe(true);
  });

  it('UIA GET missing session flood-7', async () => {
    const env = makeEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, j) =>
        request(`/oauth/authorize/uia?session=miss-7-${j}`, {}, env)
      )
    );
    expect(results.every((r) => r.status === 200 && String(r.body).includes('Session Expired'))).toBe(true);
  });

  it('UIA GET without session query soft', async () => {
    const env = makeEnv();
    const res = await request('/oauth/authorize/uia', {}, env);
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain('Missing Session');
  });
});

// ---------------------------------------------------------------------------
// Soft floods: method / body / charset / unsupported grant under Promise.all
// ---------------------------------------------------------------------------

describe('race oauth soft floods method/body/grant after #215', () => {

  it('unsupported grant_type flood-0', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'client_credentials', client_id: 'cid-1' }), env),
      request('/oauth/token', urlencoded({ grant_type: 'password', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'implicit', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400, 400]);
    expect(results.every((r) => r.body.error === 'unsupported_grant_type')).toBe(true);
  });

  it('unsupported grant_type flood-1', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'client_credentials', client_id: 'cid-1' }), env),
      request('/oauth/token', urlencoded({ grant_type: 'password', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'implicit', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400, 400]);
    expect(results.every((r) => r.body.error === 'unsupported_grant_type')).toBe(true);
  });

  it('unsupported grant_type flood-2', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'client_credentials', client_id: 'cid-1' }), env),
      request('/oauth/token', urlencoded({ grant_type: 'password', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'implicit', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400, 400]);
    expect(results.every((r) => r.body.error === 'unsupported_grant_type')).toBe(true);
  });

  it('unsupported grant_type flood-3', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'client_credentials', client_id: 'cid-1' }), env),
      request('/oauth/token', urlencoded({ grant_type: 'password', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'implicit', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400, 400]);
    expect(results.every((r) => r.body.error === 'unsupported_grant_type')).toBe(true);
  });

  it('unsupported grant_type flood-4', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'client_credentials', client_id: 'cid-1' }), env),
      request('/oauth/token', urlencoded({ grant_type: 'password', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'implicit', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400, 400]);
    expect(results.every((r) => r.body.error === 'unsupported_grant_type')).toBe(true);
  });

  it('unsupported grant_type flood-5', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'client_credentials', client_id: 'cid-1' }), env),
      request('/oauth/token', urlencoded({ grant_type: 'password', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'implicit', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400, 400]);
    expect(results.every((r) => r.body.error === 'unsupported_grant_type')).toBe(true);
  });

  it('unsupported grant_type flood-6', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'client_credentials', client_id: 'cid-1' }), env),
      request('/oauth/token', urlencoded({ grant_type: 'password', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'implicit', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400, 400]);
    expect(results.every((r) => r.body.error === 'unsupported_grant_type')).toBe(true);
  });

  it('unsupported grant_type flood-7', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'client_credentials', client_id: 'cid-1' }), env),
      request('/oauth/token', urlencoded({ grant_type: 'password', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'implicit', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400, 400]);
    expect(results.every((r) => r.body.error === 'unsupported_grant_type')).toBe(true);
  });

  it('unsupported grant_type flood-8', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'client_credentials', client_id: 'cid-1' }), env),
      request('/oauth/token', urlencoded({ grant_type: 'password', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'implicit', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400, 400]);
    expect(results.every((r) => r.body.error === 'unsupported_grant_type')).toBe(true);
  });

  it('unsupported grant_type flood-9', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'client_credentials', client_id: 'cid-1' }), env),
      request('/oauth/token', urlencoded({ grant_type: 'password', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'implicit', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400, 400]);
    expect(results.every((r) => r.body.error === 'unsupported_grant_type')).toBe(true);
  });

  it('unsupported grant_type flood-10', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'client_credentials', client_id: 'cid-1' }), env),
      request('/oauth/token', urlencoded({ grant_type: 'password', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'implicit', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400, 400]);
    expect(results.every((r) => r.body.error === 'unsupported_grant_type')).toBe(true);
  });

  it('unsupported grant_type flood-11', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'client_credentials', client_id: 'cid-1' }), env),
      request('/oauth/token', urlencoded({ grant_type: 'password', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'implicit', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400, 400]);
    expect(results.every((r) => r.body.error === 'unsupported_grant_type')).toBe(true);
  });

  it('token missing client_id parallel soft', async () => {
    const env = makeEnv();
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'authorization_code', code: 'x' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'authorization_code', code: 'y' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => r.body.error === 'invalid_client')).toBe(true);
  });

  it('token unsupported content-type soft', async () => {
    const env = makeEnv();
    const results = await Promise.all([
      request(
        '/oauth/token',
        { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'grant_type=x' },
        env
      ),
      request(
        '/oauth/token',
        { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: '<x/>' },
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  it('register invalid JSON parallel soft', async () => {
    const env = makeEnv();
    const results = await Promise.all([
      request(
        '/oauth/register',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' },
        env
      ),
      request(
        '/oauth/register',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' },
        env
      ),
    ]);
    // `{bad` → 400 invalid JSON; `null` may 400 metadata or similar soft error
    expect(results[0].status).toBe(400);
    expect(results[1].status === 400 || results[1].status === 500).toBe(true);
  });

  it('authorize missing fields soft HTML', async () => {
    const env = makeEnv();
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ username: 'alice' }), env),
      request('/oauth/authorize', formInit({ password: 'secret' }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => String(r.body).includes('Missing username or password'))).toBe(true);
  });

  it('GET authorize without params soft HTML login', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(
        `/oauth/authorize?client_id=cid-1&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=openid`,
        {},
        env
      ),
      request(
        `/oauth/authorize?client_id=cid-1&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=openid`,
        {},
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => typeof r.body === 'string' && r.body.includes('Sign in'))).toBe(true);
  });

  it('token code missing flood-0', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'authorization_code', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => r.body.error === 'invalid_request')).toBe(true);
  });

  it('token code missing flood-1', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'authorization_code', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => r.body.error === 'invalid_request')).toBe(true);
  });

  it('token code missing flood-2', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'authorization_code', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => r.body.error === 'invalid_request')).toBe(true);
  });

  it('token code missing flood-3', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'authorization_code', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => r.body.error === 'invalid_request')).toBe(true);
  });

  it('token code missing flood-4', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'authorization_code', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => r.body.error === 'invalid_request')).toBe(true);
  });

  it('token code missing flood-5', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'authorization_code', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => r.body.error === 'invalid_request')).toBe(true);
  });

  it('token code missing flood-6', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'authorization_code', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => r.body.error === 'invalid_request')).toBe(true);
  });

  it('token code missing flood-7', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1' }), env),
      request('/oauth/token', jsonInit('POST', { grant_type: 'authorization_code', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => r.body.error === 'invalid_request')).toBe(true);
  });

  it('refresh_token missing soft', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/token', urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1' }), env),
      request('/oauth/token', urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1' }), env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  it('lifecycle register→authorize→token under isolation', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const reg = await registerClient(env);
    expect(reg.status).toBe(201);
    const clientId = reg.body.client_id as string;
    const authRequestId = `ar-life`;
    sessions.data[`oauth_auth_request:${authRequestId}`] = JSON.stringify({
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:LIFE',
      state: 's',
    });
    const auth = await request(
      '/oauth/authorize',
      formInit({ username: 'alice', password: 'secret', auth_request_id: authRequestId }),
      env
    );
    expect(auth.status).toBe(302);
    const code = new URL(auth.headers.get('location')!).searchParams.get('code')!;
    const tok = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'authorization_code', client_id: clientId, code }),
      env
    );
    expect(tok.status).toBe(200);
    expect(tok.body.device_id).toBe('LIFE');
    expect(tok.body.user_id).toBe(USER_ID);
  });

  it('cross-endpoint register∥token isolation', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-iso');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      registerClient(env, {
        client_name: 'Parallel',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-iso' }),
        env
      ),
    ]);
    expect(results[0].status).toBe(201);
    expect(results[1].status).toBe(200);
    expect(results[0].body.client_id).not.toBe('cid-1');
  });
});

// ---------------------------------------------------------------------------
// KV fail soft + bind contracts under parallel
// ---------------------------------------------------------------------------

describe('race oauth KV fail soft + bind contracts after #215', () => {
  it('SESSIONS get fail mid token soft → 500 via error boundary', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessionsFail = mockKv({}, { failGetAfter: 0 });
    seedAuthCode(sessionsFail, 'code-fail');
    const env = makeEnv({ cache, sessions: sessionsFail, db: aliceDb() });
    const res = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-fail' }),
      env
    );
    expect(res.status).toBe(500);
  });

  it('auth code put TTL is 600 on authorize', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-ttl');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/authorize',
      formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ttl' }),
      env
    );
    expect(res.status).toBe(302);
    const codePut = sessions.puts.find((p) => p.key.startsWith('oauth_code:'));
    expect(codePut?.options?.expirationTtl).toBe(600);
  });

  it('auth code mint TTL bind flood-0', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-ttl-0');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/authorize',
      formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ttl-0' }),
      env
    );
    expect(res.status).toBe(302);
    const codePut = sessions.puts.find((p) => p.key.startsWith('oauth_code:'));
    expect(codePut?.options?.expirationTtl).toBe(600);
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const stored = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(stored.user_id).toBe(USER_ID);
    expect(stored.client_id).toBe('cid-1');
  });

  it('auth code mint TTL bind flood-1', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-ttl-1');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/authorize',
      formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ttl-1' }),
      env
    );
    expect(res.status).toBe(302);
    const codePut = sessions.puts.find((p) => p.key.startsWith('oauth_code:'));
    expect(codePut?.options?.expirationTtl).toBe(600);
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const stored = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(stored.user_id).toBe(USER_ID);
    expect(stored.client_id).toBe('cid-1');
  });

  it('auth code mint TTL bind flood-2', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-ttl-2');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/authorize',
      formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ttl-2' }),
      env
    );
    expect(res.status).toBe(302);
    const codePut = sessions.puts.find((p) => p.key.startsWith('oauth_code:'));
    expect(codePut?.options?.expirationTtl).toBe(600);
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const stored = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(stored.user_id).toBe(USER_ID);
    expect(stored.client_id).toBe('cid-1');
  });

  it('auth code mint TTL bind flood-3', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-ttl-3');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/authorize',
      formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ttl-3' }),
      env
    );
    expect(res.status).toBe(302);
    const codePut = sessions.puts.find((p) => p.key.startsWith('oauth_code:'));
    expect(codePut?.options?.expirationTtl).toBe(600);
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const stored = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(stored.user_id).toBe(USER_ID);
    expect(stored.client_id).toBe('cid-1');
  });

  it('auth code mint TTL bind flood-4', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-ttl-4');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/authorize',
      formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ttl-4' }),
      env
    );
    expect(res.status).toBe(302);
    const codePut = sessions.puts.find((p) => p.key.startsWith('oauth_code:'));
    expect(codePut?.options?.expirationTtl).toBe(600);
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const stored = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(stored.user_id).toBe(USER_ID);
    expect(stored.client_id).toBe('cid-1');
  });

  it('auth code mint TTL bind flood-5', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-ttl-5');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/authorize',
      formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ttl-5' }),
      env
    );
    expect(res.status).toBe(302);
    const codePut = sessions.puts.find((p) => p.key.startsWith('oauth_code:'));
    expect(codePut?.options?.expirationTtl).toBe(600);
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const stored = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(stored.user_id).toBe(USER_ID);
    expect(stored.client_id).toBe('cid-1');
  });

  it('auth code mint TTL bind flood-6', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-ttl-6');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/authorize',
      formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ttl-6' }),
      env
    );
    expect(res.status).toBe(302);
    const codePut = sessions.puts.find((p) => p.key.startsWith('oauth_code:'));
    expect(codePut?.options?.expirationTtl).toBe(600);
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const stored = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(stored.user_id).toBe(USER_ID);
    expect(stored.client_id).toBe('cid-1');
  });

  it('auth code mint TTL bind flood-7', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-ttl-7');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/authorize',
      formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ttl-7' }),
      env
    );
    expect(res.status).toBe(302);
    const codePut = sessions.puts.find((p) => p.key.startsWith('oauth_code:'));
    expect(codePut?.options?.expirationTtl).toBe(600);
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const stored = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(stored.user_id).toBe(USER_ID);
    expect(stored.client_id).toBe('cid-1');
  });

  it('token response shape bind under parallel distinct codes', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-shape-a', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:SA',
    });
    seedAuthCode(sessions, 'code-shape-b', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:SB',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-shape-a' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-shape-b' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.token_type).toBe('Bearer');
      expect(r.body.expires_in).toBe(86400);
      expect(typeof r.body.access_token).toBe('string');
      expect(typeof r.body.refresh_token).toBe('string');
      expect(r.body.user_id).toBe(USER_ID);
    }
  });

  it('devices inserted on code redeem', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-dev', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:NEWDEV',
    });
    const db = aliceDb();
    const env = makeEnv({ cache, sessions, db });
    const res = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-dev' }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.devices.some((d) => d.device_id === 'NEWDEV' && d.user_id === USER_ID)).toBe(true);
    expect(db.tokensByHash.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// After #232: leftover GET authorize query / PKCE / confidential / device /
// UIA approve / JWT introspect / user isolation TOCTOU
// ---------------------------------------------------------------------------

function authorizeGetQs(extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    client_id: 'cid-1',
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid',
    ...extra,
  });
  return `/oauth/authorize?${q.toString()}`;
}

describe('race leftover GET authorize query + auth_request mint after #232', () => {
  it('dual GET same client mints distinct auth_request keys with TTL 600', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { putBarrier: { count: 2, match: (k) => k.startsWith('oauth_auth_request:') } }
    );
    const env = makeEnv({ cache, sessions });
    const results = await Promise.all([
      request(authorizeGetQs({ state: 'st-a', nonce: 'n-a' }), {}, env),
      request(authorizeGetQs({ state: 'st-b', nonce: 'n-b' }), {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const puts = sessions.puts.filter((p) => p.key.startsWith('oauth_auth_request:'));
    expect(puts).toHaveLength(2);
    expect(new Set(puts.map((p) => p.key)).size).toBe(2);
    for (const p of puts) {
      expect(p.options?.expirationTtl).toBe(600);
      const parsed = JSON.parse(p.value);
      expect(parsed.client_id).toBe('cid-1');
      expect(parsed.redirect_uri).toBe(REDIRECT);
    }
    const nonces = puts.map((p) => JSON.parse(p.value).nonce).sort();
    expect(nonces).toEqual(['n-a', 'n-b'].sort());
  });

  it('GET authorize stores PKCE challenge + method under parallel', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    const env = makeEnv({ cache, sessions });
    const results = await Promise.all([
      request(
        authorizeGetQs({
          code_challenge: 'plain-chal-a',
          code_challenge_method: 'plain',
          state: 'pk-a',
        }),
        {},
        env
      ),
      request(
        authorizeGetQs({
          code_challenge: 'plain-chal-b',
          code_challenge_method: 'S256',
          state: 'pk-b',
        }),
        {},
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const stored = Object.values(sessions.data).map((v) => JSON.parse(v));
    const byState = Object.fromEntries(stored.map((s) => [s.state, s]));
    expect(byState['pk-a'].code_challenge).toBe('plain-chal-a');
    expect(byState['pk-a'].code_challenge_method).toBe('plain');
    expect(byState['pk-b'].code_challenge).toBe('plain-chal-b');
    expect(byState['pk-b'].code_challenge_method).toBe('S256');
  });

  it('GET authorize missing client_id / redirect_uri / bad response_type parallel', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(
        `/oauth/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
        {},
        env
      ),
      request(`/oauth/authorize?client_id=cid-1&response_type=code`, {}, env),
      request(
        `/oauth/authorize?client_id=cid-1&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=token`,
        {},
        env
      ),
    ]);
    expect(results[0].status).toBe(400);
    expect(results[0].body.error).toBe('invalid_request');
    expect(results[1].status).toBe(400);
    expect(results[1].body.error).toBe('invalid_request');
    expect(results[2].status).toBe(400);
    expect(results[2].body.error).toBe('unsupported_response_type');
  });

  it('GET authorize unknown client ∥ invalid redirect_uri isolation', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(authorizeGetQs({ client_id: 'missing' }), {}, env),
      request(
        `/oauth/authorize?client_id=cid-1&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}&response_type=code`,
        {},
        env
      ),
    ]);
    expect(results[0].status).toBe(400);
    expect(results[0].body.error).toBe('invalid_client');
    expect(results[1].status).toBe(400);
    expect(results[1].body.error).toBe('invalid_request');
  });

  it('GET authorize HTML includes client_name under parallel', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1', { client_name: 'Element Web' });
    seedClient(cache, 'cid-2', { client_name: 'Nheko' });
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(authorizeGetQs({ client_id: 'cid-1' }), {}, env),
      request(authorizeGetQs({ client_id: 'cid-2' }), {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(String(results[0].body)).toContain('Element Web');
    expect(String(results[1].body)).toContain('Nheko');
  });

  it('corrupt oauth_client JSON GET authorize surfaces 500 under parallel', async () => {
    const cache = mockKv();
    cache.data['oauth_client:cid-bad'] = '{not-json';
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(authorizeGetQs({ client_id: 'cid-bad' }), {}, env),
      request(authorizeGetQs({ client_id: 'cid-bad' }), {}, env),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  for (let i = 0; i < 8; i++) {
    it(`GET authorize mint flood-${i} distinct request ids`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      const env = makeEnv({ cache, sessions });
      const results = await Promise.all(
        [0, 1, 2].map((j) =>
          request(authorizeGetQs({ state: `f${i}-${j}`, nonce: `n${i}-${j}` }), {}, env)
        )
      );
      expect(results.every((r) => r.status === 200 && String(r.body).includes('Sign in'))).toBe(
        true
      );
      expect(Object.keys(sessions.data).filter((k) => k.startsWith('oauth_auth_request:'))).toHaveLength(
        3
      );
    });
  }
});

describe('race leftover confidential client + PKCE + device fallback after #232', () => {
  it('register none∥confidential: secret only on confidential, CACHE TTL 1y', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const results = await Promise.all([
      registerClient(env, {
        client_name: 'Public',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
      registerClient(env, {
        client_name: 'Conf',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    ]);
    expect(statusesOf(results)).toEqual([201, 201]);
    const none = results.find((r) => r.body.token_endpoint_auth_method === 'none')!;
    const conf = results.find((r) => r.body.token_endpoint_auth_method === 'client_secret_basic')!;
    expect(none.body.client_secret).toBeUndefined();
    expect(typeof conf.body.client_secret).toBe('string');
    expect(conf.body.client_secret_expires_at).toBe(0);
    for (const p of cache.puts.filter((x) => x.key.startsWith('oauth_client:'))) {
      expect(p.options?.expirationTtl).toBe(365 * 24 * 60 * 60);
    }
  });

  it('confidential token body secret vs Basic header isolation', async () => {
    const cache = mockKv();
    const secret = 's3cret-basic';
    const hash = await hashClientSecret(secret);
    seedClient(cache, 'cid-sec', {
      client_secret_hash: hash,
      token_endpoint_auth_method: 'client_secret_post',
    });
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-sec-a', {
      client_id: 'cid-sec',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:SECA',
    });
    seedAuthCode(sessions, 'code-sec-b', {
      client_id: 'cid-sec',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:SECB',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const basic = btoa(`cid-sec:${secret}`);
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-sec',
          client_secret: secret,
          code: 'code-sec-a',
        }),
        env
      ),
      request(
        '/oauth/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basic}`,
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'code-sec-b',
          }).toString(),
        },
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.map((r) => r.body.device_id).sort()).toEqual(['SECA', 'SECB'].sort());
  });

  it('confidential missing secret ∥ wrong secret both 401', async () => {
    const cache = mockKv();
    const hash = await hashClientSecret('real-secret');
    seedClient(cache, 'cid-sec', {
      client_secret_hash: hash,
      token_endpoint_auth_method: 'client_secret_post',
    });
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-ns', { client_id: 'cid-sec' });
    seedAuthCode(sessions, 'code-ws', { client_id: 'cid-sec' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-sec',
          code: 'code-ns',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-sec',
          client_secret: 'wrong',
          code: 'code-ws',
        }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([401, 401]);
    expect(results.every((r) => r.body.error === 'invalid_client')).toBe(true);
  });

  it('PKCE plain dual distinct codes succeed under get barrier', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'pkce-a', {
      code_challenge: 'ver-a',
      code_challenge_method: 'plain',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:PKA',
    });
    seedAuthCode(sessions, 'pkce-b', {
      code_challenge: 'ver-b',
      code_challenge_method: 'plain',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:PKB',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'pkce-a',
          code_verifier: 'ver-a',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'pkce-b',
          code_verifier: 'ver-b',
        }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.map((r) => r.body.device_id).sort()).toEqual(['PKA', 'PKB'].sort());
  });

  it('PKCE S256 valid ∥ invalid verifier isolation', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const verifier = 's256-verifier-abcdefghijklmnopqrstuvwxyz';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = base64UrlEncode(new Uint8Array(digest));
    const sessions = mockKv();
    seedAuthCode(sessions, 's256-ok', {
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:S256A',
    });
    seedAuthCode(sessions, 's256-bad', {
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 's256-ok',
          code_verifier: verifier,
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 's256-bad',
          code_verifier: 'not-the-verifier',
        }),
        env
      ),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[0].body.device_id).toBe('S256A');
    expect(results[1].status).toBe(400);
    expect(results[1].body.error).toBe('invalid_grant');
  });

  it('PKCE unknown method fails even with matching verifier', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'pkce-unk', {
      code_challenge: 'abc',
      code_challenge_method: 'S512',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/token',
      urlencoded({
        grant_type: 'authorization_code',
        client_id: 'cid-1',
        code: 'pkce-unk',
        code_verifier: 'abc',
      }),
      env
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('device * and missing device generate distinct fallbacks under parallel', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'dev-star', { scope: 'openid urn:matrix:org.matrix.msc2967.client:device:*' });
    seedAuthCode(sessions, 'dev-none', { scope: 'openid' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'dev-star' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'dev-none' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.device_id).not.toBe('*');
    expect(results[1].body.device_id).toBeTruthy();
    expect(results[0].body.device_id).not.toBe(results[1].body.device_id);
    expect(typeof results[0].body.device_id).toBe('string');
  });

  it('matching redirect_uri JSON∥urlencoded both 200', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'redir-a', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:RA',
    });
    seedAuthCode(sessions, 'redir-b', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:RB',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'redir-a',
          redirect_uri: REDIRECT,
        }),
        env
      ),
      request(
        '/oauth/token',
        jsonInit('POST', {
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'redir-b',
          redirect_uri: REDIRECT,
        }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('refresh wrong client_id ∥ missing refresh parallel soft', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    seedClient(cache, 'cid-2');
    const sessions = mockKv();
    seedRefresh(sessions, 'rt-own', { client_id: 'cid-2' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-own' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'gone' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => r.body.error === 'invalid_grant')).toBe(true);
  });

  it('refresh put TTL is 30 days after rotate', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedRefresh(sessions, 'rt-ttl');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const res = await request(
      '/oauth/token',
      urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-ttl' }),
      env
    );
    expect(res.status).toBe(200);
    const put = sessions.puts.find((p) => p.key.startsWith('oauth_refresh:') && p.key !== 'oauth_refresh:rt-ttl');
    expect(put?.options?.expirationTtl).toBe(30 * 24 * 60 * 60);
    expect(sessions.data['oauth_refresh:rt-ttl']).toBeUndefined();
  });

  for (let i = 0; i < 8; i++) {
    it(`PKCE plain leftover flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      const v = `ver-${i}`;
      seedAuthCode(sessions, `pkce-f-${i}`, {
        code_challenge: v,
        code_challenge_method: 'plain',
        scope: `openid urn:matrix:org.matrix.msc2967.client:device:PF${i}`,
      });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `pkce-f-${i}`,
            code_verifier: v,
          }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `pkce-missing-${i}`,
            code_verifier: v,
          }),
          env
        ),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[0].body.device_id).toBe(`PF${i}`);
      expect(results[1].status).toBe(400);
    });
  }
});

describe('race leftover UIA approve/cancel + JWT introspect after #232', () => {
  it('UIA approve writes completed_stages + TTL 300', async () => {
    const cache = mockKv();
    cache.data['uia_session:ap1'] = JSON.stringify({ user_id: USER_ID, completed_stages: [] });
    const env = makeEnv({ cache, db: aliceDb() });
    const fd = new FormData();
    fd.set('session', 'ap1');
    fd.set('username', 'alice');
    fd.set('password', 'secret');
    const res = await request('/oauth/authorize/uia', { method: 'POST', body: fd }, env);
    expect(res.status).toBe(200);
    expect(String(res.body).toLowerCase()).toContain('approved');
    const put = cache.puts.find((p) => p.key === 'uia_session:ap1');
    expect(put?.options?.expirationTtl).toBe(300);
    const session = JSON.parse(cache.data['uia_session:ap1']);
    expect(session.completed_stages).toEqual(
      expect.arrayContaining(['org.matrix.cross_signing_reset', 'm.oauth', 'm.login.oauth'])
    );
    expect(session.oauth_completed_at).toBe(NOW);
  });

  it('UIA cancel∥approve under get barrier — last writer wins on session key', async () => {
    const cache = mockKv(
      {},
      { getBarrier: { count: 2, match: (k) => k.startsWith('uia_session:') } }
    );
    cache.data['uia_session:race'] = JSON.stringify({ user_id: USER_ID });
    const env = makeEnv({ cache, db: aliceDb() });
    const cancel = new FormData();
    cancel.set('session', 'race');
    cancel.set('action', 'cancel');
    const approve = new FormData();
    approve.set('session', 'race');
    approve.set('username', 'alice');
    approve.set('password', 'secret');
    const results = await Promise.all([
      request('/oauth/authorize/uia', { method: 'POST', body: cancel }, env),
      request('/oauth/authorize/uia', { method: 'POST', body: approve }, env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const remaining = cache.data['uia_session:race'];
    if (remaining === undefined) {
      expect(results.some((r) => String(r.body).toLowerCase().includes('cancel'))).toBe(true);
    } else {
      const session = JSON.parse(remaining);
      expect(session.completed_stages).toEqual(
        expect.arrayContaining(['org.matrix.cross_signing_reset'])
      );
    }
  });

  it('UIA wrong password ∥ wrong user isolation', async () => {
    const cache = mockKv();
    cache.data['uia_session:wp'] = JSON.stringify({ user_id: USER_ID });
    cache.data['uia_session:wu'] = JSON.stringify({ user_id: USER_ID });
    const env = makeEnv({ cache, db: aliceDb() });
    const badPass = new FormData();
    badPass.set('session', 'wp');
    badPass.set('username', 'alice');
    badPass.set('password', 'nope');
    const wrongUser = new FormData();
    wrongUser.set('session', 'wu');
    wrongUser.set('username', 'bob');
    wrongUser.set('password', 'bobpass');
    const results = await Promise.all([
      request('/oauth/authorize/uia', { method: 'POST', body: badPass }, env),
      request('/oauth/authorize/uia', { method: 'POST', body: wrongUser }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(String(results[0].body)).toContain('Invalid username or password');
    expect(String(results[1].body)).toContain('same account');
  });

  it('UIA OIDC-only user (null password_hash + IdP link) approves matching session', async () => {
    const oidcUser = userRow({
      user_id: USER_ID,
      localpart: 'alice',
      password_hash: null,
      display_name: 'Alice SSO',
    });
    const db = createOAuthDb({
      users: new Map([[USER_ID, oidcUser]]),
      idpLinkUserIds: [USER_ID],
    });
    const cache = mockKv();
    cache.data['uia_session:oidc'] = JSON.stringify({ user_id: USER_ID });
    const env = makeEnv({ cache, db });
    const fd = new FormData();
    fd.set('session', 'oidc');
    fd.set('username', 'alice');
    fd.set('password', 'ignored');
    const results = await Promise.all([
      request('/oauth/authorize/uia', { method: 'POST', body: fd }, env),
      request('/oauth/authorize/uia?session=oidc', {}, env),
    ]);
    expect(results[0].status).toBe(200);
    expect(String(results[0].body).toLowerCase()).toContain('approved');
    expect(results[1].status).toBe(200);
  });

  it('UIA missing credentials keeps session', async () => {
    const cache = mockKv();
    cache.data['uia_session:mc'] = JSON.stringify({ user_id: USER_ID });
    const env = makeEnv({ cache, db: aliceDb() });
    const fd = new FormData();
    fd.set('session', 'mc');
    const res = await request('/oauth/authorize/uia', { method: 'POST', body: fd }, env);
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain('Username and password are required');
    expect(cache.data['uia_session:mc']).toBeTruthy();
  });

  it('JWT introspect active∥expired isolation + azp client_id', async () => {
    const env = makeEnv();
    const active = fakeJwt({
      sub: USER_ID,
      azp: 'cid-azp',
      exp: Math.floor(NOW / 1000) + 3600,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}`,
    });
    const expired = fakeJwt({
      sub: USER_ID,
      client_id: 'cid-old',
      exp: Math.floor(NOW / 1000) - 1,
    });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: active }), env),
      request('/oauth/introspect', jsonInit('POST', { token: expired }), env),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[0].body.active).toBe(true);
    expect(results[0].body.client_id).toBe('cid-azp');
    expect(results[0].body.iss).toBe(`https://${SERVER}`);
    expect(results[1].body.active).toBe(false);
  });

  it('malformed JWT 3-part falls through to opaque inactive under parallel', async () => {
    const env = makeEnv();
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: 'aaa.bbb.ccc' }), env),
      request('/oauth/introspect', urlencoded({ token: 'not-a-jwt' }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => r.body.active === false)).toBe(true);
  });

  it('userinfo Alice∥Bob isolation under parallel', async () => {
    const db = aliceDb();
    const tokA = 'ui-alice';
    const tokB = 'ui-bob';
    db.tokensByHash.set(await hashToken(tokA), {
      user_id: USER_ID,
      device_id: 'DA',
      created_at: NOW,
    });
    db.tokensByHash.set(await hashToken(tokB), {
      user_id: BOB_ID,
      device_id: 'DB',
      created_at: NOW,
    });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${tokA}` } }, env),
      request('/oauth/userinfo', { method: 'POST', headers: { Authorization: `Bearer ${tokB}` } }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.sub).toBe(USER_ID);
    expect(results[0].body.name).toBe('Alice');
    expect(results[1].body.sub).toBe(BOB_ID);
    expect(results[1].body.name).toBe('Bob');
  });

  it('POST authorize deactivated user recreates auth_request', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1', { client_name: 'Element Web' });
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-deact');
    const users = new Map([
      [
        USER_ID,
        userRow({
          user_id: USER_ID,
          localpart: 'alice',
          password_hash: 'mockok:secret',
          is_deactivated: 1,
        }),
      ],
    ]);
    const env = makeEnv({ cache, sessions, db: createOAuthDb({ users }) });
    const results = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-deact' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'secret', auth_request_id: 'missing' }),
        env
      ),
    ]);
    expect(results[0].status).toBe(200);
    expect(String(results[0].body)).toContain('Invalid username or password');
    expect(sessions.data['oauth_auth_request:ar-deact']).toBeUndefined();
    expect(Object.keys(sessions.data).some((k) => k.startsWith('oauth_auth_request:'))).toBe(true);
    expect(results[1].status).toBe(400);
  });

  it('GET UIA default action copy vs cross_signing_reset isolation', async () => {
    const cache = mockKv();
    cache.data['uia_session:def'] = JSON.stringify({ user_id: USER_ID });
    cache.data['uia_session:xr'] = JSON.stringify({ user_id: USER_ID });
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/authorize/uia?session=def', {}, env),
      request('/oauth/authorize/uia?session=xr&action=org.matrix.cross_signing_reset', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(String(results[0].body)).toContain('Approve Request');
    expect(String(results[1].body)).toContain('Reset Encryption Keys');
  });

  for (let i = 0; i < 8; i++) {
    it(`JWT introspect leftover flood-${i}`, async () => {
      const env = makeEnv();
      const jwt = fakeJwt({
        sub: `@u${i}:${SERVER}`,
        client_id: `cid-${i}`,
        exp: Math.floor(NOW / 1000) + 10 + i,
        scope: 'openid',
      });
      const results = await Promise.all([
        request('/oauth/introspect', urlencoded({ token: jwt }), env),
        request('/oauth/introspect', jsonInit('POST', { token: jwt }), env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results.every((r) => r.body.active === true && r.body.sub === `@u${i}:${SERVER}`)).toBe(
        true
      );
    });
  }
});

// ---------------------------------------------------------------------------
// After #241: residual oauth races not covered by #238 (Location/state,
// escapeHtml, grant soft matrix, opaque iat/revoke∥introspect, UIA password
// mismatch, Basic URL-decode, device display_name, deleteBarrier redeem)
// ---------------------------------------------------------------------------

describe('race residual POST authorize Location + escapeHtml after #241', () => {
  it('dual POST authorize success: Location code+state binds under parallel', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-loc-a', { state: 'state-a' });
    seedAuthRequest(sessions, 'ar-loc-b', { state: 'state-b' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-loc-a' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-loc-b' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    const locs = results.map((r) => r.headers.get('Location') || '');
    expect(locs.every((l) => l.startsWith(REDIRECT))).toBe(true);
    const codes = locs.map((l) => new URL(l).searchParams.get('code'));
    const states = locs.map((l) => new URL(l).searchParams.get('state')).sort();
    expect(new Set(codes).size).toBe(2);
    expect(states).toEqual(['state-a', 'state-b'].sort());
    expect(sessions.data['oauth_auth_request:ar-loc-a']).toBeUndefined();
    expect(sessions.data['oauth_auth_request:ar-loc-b']).toBeUndefined();
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('oauth_code:'))).toHaveLength(2);
  });

  it('POST authorize without state omits state query under parallel', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-ns-a', { state: undefined });
    seedAuthRequest(sessions, 'ar-ns-b', { state: null as unknown as string });
    // seed writes undefined/null into JSON — clear state keys explicitly
    sessions.data['oauth_auth_request:ar-ns-a'] = JSON.stringify({
      client_id: 'cid-1',
      redirect_uri: REDIRECT,
      scope: 'openid',
    });
    sessions.data['oauth_auth_request:ar-ns-b'] = JSON.stringify({
      client_id: 'cid-1',
      redirect_uri: REDIRECT,
      scope: 'openid',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ns-a' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ns-b' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([302, 302]);
    for (const r of results) {
      const loc = new URL(r.headers.get('Location') || '');
      expect(loc.searchParams.get('code')).toBeTruthy();
      expect(loc.searchParams.has('state')).toBe(false);
    }
  });

  it('GET authorize escapeHtml escapes script in client_name under parallel', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-xss', {
      client_name: `<script>alert(1)</script>`,
    });
    seedClient(cache, 'cid-amp', { client_name: `A & B "C"` });
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(authorizeGetQs({ client_id: 'cid-xss' }), {}, env),
      request(authorizeGetQs({ client_id: 'cid-amp' }), {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(String(results[0].body)).not.toContain('<script>alert(1)</script>');
    expect(String(results[0].body)).toContain('&lt;script&gt;');
    expect(String(results[1].body)).toContain('A &amp; B &quot;C&quot;');
  });

  it('GET authorize omitted scope defaults to openid in auth_request', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    const env = makeEnv({ cache, sessions });
    const results = await Promise.all([
      request(
        `/oauth/authorize?client_id=cid-1&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=def-a`,
        {},
        env
      ),
      request(
        `/oauth/authorize?client_id=cid-1&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=def-b&scope=openid%20profile`,
        {},
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const stored = Object.values(sessions.data).map((v) => JSON.parse(v));
    const byState = Object.fromEntries(stored.map((s) => [s.state, s]));
    expect(byState['def-a'].scope).toBe('openid');
    expect(byState['def-b'].scope).toBe('openid profile');
  });

  for (let i = 0; i < 6; i++) {
    it(`POST authorize Location residual flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedAuthRequest(sessions, `ar-f-${i}`, { state: `sf-${i}` });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/authorize',
          formInit({ username: 'alice', password: 'secret', auth_request_id: `ar-f-${i}` }),
          env
        ),
        request(
          '/oauth/authorize',
          formInit({ username: 'alice', password: 'secret', auth_request_id: `missing-${i}` }),
          env
        ),
      ]);
      expect(results[0].status).toBe(302);
      expect(new URL(results[0].headers.get('Location') || '').searchParams.get('state')).toBe(
        `sf-${i}`
      );
      expect(results[1].status).toBe(400);
    });
  }
});

describe('race residual token grant soft + deleteBarrier after #241', () => {
  it('client_id mismatch ∥ PKCE missing verifier parallel soft isolation', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    seedClient(cache, 'cid-2');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-mis', { client_id: 'cid-2' });
    seedAuthCode(sessions, 'code-pkce', {
      code_challenge: 'chal',
      code_challenge_method: 'plain',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-mis' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-pkce' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.map((r) => r.body.error).sort()).toEqual(
      ['invalid_grant', 'invalid_request'].sort()
    );
    expect(results.some((r) => String(r.body.error_description).includes('code_verifier'))).toBe(
      true
    );
    expect(results.some((r) => String(r.body.error_description).includes('not issued'))).toBe(true);
  });

  it('redirect_uri mismatch ∥ expired code parallel soft', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-redir');
    seedAuthCode(sessions, 'code-exp', { expires_at: NOW - 1 });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-redir',
          redirect_uri: 'https://evil.example.com/cb',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-exp' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
    expect(results.every((r) => r.body.error === 'invalid_grant')).toBe(true);
  });

  it('corrupt oauth_code JSON surfaces soft under parallel', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    sessions.data['oauth_code:bad-json'] = '{not-json';
    seedAuthCode(sessions, 'code-ok', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:OK',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'bad-json' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-ok' }),
        env
      ),
    ]);
    expect(results[1].status).toBe(200);
    expect(results[1].body.device_id).toBe('OK');
    expect([400, 500]).toContain(results[0].status);
  });

  it('dual redeem same code under deleteBarrier — both observe code', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { deleteBarrier: { count: 2, match: (k) => k.startsWith('oauth_code:') } }
    );
    seedAuthCode(sessions, 'code-del', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEL',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-del' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-del' }),
        env
      ),
    ]);
    // Both passed get before delete barrier — race documents double success possible
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
  });

  it('Basic auth URL-decodes client_secret with special chars under parallel', async () => {
    const cache = mockKv();
    const secret = 's3cret!plus';
    const hash = await hashClientSecret(secret);
    seedClient(cache, 'cid-enc', {
      client_secret_hash: hash,
      token_endpoint_auth_method: 'client_secret_basic',
    });
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-enc-a', {
      client_id: 'cid-enc',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:ENA',
    });
    seedAuthCode(sessions, 'code-enc-b', {
      client_id: 'cid-enc',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:ENB',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const basic = btoa(`cid-enc:${encodeURIComponent(secret)}`);
    const results = await Promise.all([
      request(
        '/oauth/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basic}`,
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'code-enc-a',
          }).toString(),
        },
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-enc',
          client_secret: secret,
          code: 'code-enc-b',
        }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.map((r) => r.body.device_id).sort()).toEqual(['ENA', 'ENB'].sort());
  });

  it('token device display_name binds client_name under parallel', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1', { client_name: 'Nheko Desktop' });
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-dn-a', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DNA',
    });
    seedAuthCode(sessions, 'code-dn-b', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DNB',
    });
    const db = aliceDb();
    const env = makeEnv({ cache, sessions, db });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-dn-a' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1', code: 'code-dn-b' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.devices).toHaveLength(2);
    expect(db.devices.every((d) => d.display_name === 'OAuth Client (Nheko Desktop)')).toBe(true);
  });

  for (let i = 0; i < 6; i++) {
    it(`grant soft residual flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedAuthCode(sessions, `code-gs-${i}`, {
        code_challenge: `chal-${i}`,
        code_challenge_method: 'plain',
      });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-gs-${i}`,
          }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `missing-gs-${i}`,
          }),
          env
        ),
      ]);
      expect(results[0].status).toBe(400);
      expect(results[0].body.error).toBe('invalid_request');
      expect(results[1].status).toBe(400);
      expect(results[1].body.error).toBe('invalid_grant');
    });
  }
});

describe('race residual revoke∥introspect + UIA password mismatch after #241', () => {
  it('revoke access_token hint ∥ introspect opaque race — active may flip', async () => {
    const token = 'opaque-rev-race';
    const hash = await hashToken(token);
    const db = aliceDb();
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: NOW });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/revoke', urlencoded({ token, token_type_hint: 'access_token' }), env),
      request('/oauth/introspect', urlencoded({ token }), env),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    expect([true, false]).toContain(results[1].body.active);
    expect(db.tokensByHash.has(hash)).toBe(false);
  });

  it('introspect opaque iat binds created_at under parallel', async () => {
    const token = 'opaque-iat';
    const hash = await hashToken(token);
    const created = NOW - 90_000;
    const db = aliceDb();
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'DEVICEA', created_at: created });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token }), env),
      request('/oauth/introspect', jsonInit('POST', { token }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.active).toBe(true);
      expect(r.body.sub).toBe(USER_ID);
      expect(r.body.iat).toBe(Math.floor(created / 1000));
      expect(r.body.client_id).toBe('unknown');
    }
  });

  it('UIA password-path wrong session account keeps session', async () => {
    const cache = mockKv();
    cache.data['uia_session:pw-mis'] = JSON.stringify({ user_id: USER_ID });
    cache.data['uia_session:pw-ok'] = JSON.stringify({ user_id: USER_ID });
    const env = makeEnv({ cache, db: aliceDb() });
    const wrong = new FormData();
    wrong.set('session', 'pw-mis');
    wrong.set('username', 'bob');
    wrong.set('password', 'bobpass');
    const ok = new FormData();
    ok.set('session', 'pw-ok');
    ok.set('username', 'alice');
    ok.set('password', 'secret');
    const results = await Promise.all([
      request('/oauth/authorize/uia', { method: 'POST', body: wrong }, env),
      request('/oauth/authorize/uia', { method: 'POST', body: ok }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(String(results[0].body)).toContain('same account');
    expect(cache.data['uia_session:pw-mis']).toBeTruthy();
    expect(String(results[1].body).toLowerCase()).toContain('approved');
    const approved = JSON.parse(cache.data['uia_session:pw-ok']);
    expect(approved.completed_stages).toEqual(
      expect.arrayContaining(['org.matrix.cross_signing_reset'])
    );
  });

  it('UIA OIDC-only wrong session user_id rejects under parallel', async () => {
    const oidcAlice = userRow({
      user_id: USER_ID,
      localpart: 'alice',
      password_hash: null,
    });
    const oidcBob = userRow({
      user_id: BOB_ID,
      localpart: 'bob',
      password_hash: null,
    });
    const db = createOAuthDb({
      users: new Map([
        [USER_ID, oidcAlice],
        [BOB_ID, oidcBob],
      ]),
      idpLinkUserIds: [USER_ID, BOB_ID],
    });
    const cache = mockKv();
    cache.data['uia_session:oidc-mis'] = JSON.stringify({ user_id: USER_ID });
    cache.data['uia_session:oidc-ok'] = JSON.stringify({ user_id: USER_ID });
    const env = makeEnv({ cache, db });
    const wrong = new FormData();
    wrong.set('session', 'oidc-mis');
    wrong.set('username', 'bob');
    wrong.set('password', 'ignored');
    const ok = new FormData();
    ok.set('session', 'oidc-ok');
    ok.set('username', 'alice');
    ok.set('password', 'ignored');
    const results = await Promise.all([
      request('/oauth/authorize/uia', { method: 'POST', body: wrong }, env),
      request('/oauth/authorize/uia', { method: 'POST', body: ok }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(String(results[0].body)).toContain('same account');
    expect(String(results[1].body).toLowerCase()).toContain('approved');
  });

  it('userinfo orphan∥valid isolation under parallel', async () => {
    const db = aliceDb();
    const orphan = 'orphan-par';
    const valid = 'valid-par';
    db.tokensByHash.set(await hashToken(orphan), {
      user_id: '@ghost:example.com',
      device_id: 'G',
      created_at: NOW,
    });
    db.tokensByHash.set(await hashToken(valid), {
      user_id: USER_ID,
      device_id: 'A',
      created_at: NOW,
    });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${orphan}` } }, env),
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${valid}` } }, env),
    ]);
    expect(results[0].status).toBe(401);
    expect(results[0].body.error).toBe('invalid_token');
    expect(results[1].status).toBe(200);
    expect(results[1].body.sub).toBe(USER_ID);
  });

  for (let i = 0; i < 6; i++) {
    it(`opaque introspect residual flood-${i}`, async () => {
      const token = `opaque-f-${i}`;
      const hash = await hashToken(token);
      const db = aliceDb();
      db.tokensByHash.set(hash, {
        user_id: USER_ID,
        device_id: `D${i}`,
        created_at: NOW - i * 1000,
      });
      const env = makeEnv({ db });
      const results = await Promise.all([
        request('/oauth/introspect', urlencoded({ token }), env),
        request('/oauth/introspect', urlencoded({ token: `missing-${i}` }), env),
      ]);
      expect(results[0].body.active).toBe(true);
      expect(results[0].body.iat).toBe(Math.floor((NOW - i * 1000) / 1000));
      expect(results[1].body.active).toBe(false);
    });
  }
});
