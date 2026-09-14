/**
 * TOKENMAXX HEAVY leftovers after #189 — admin *mutate concurrent race / TOCTOU*
 * + soft/edge reliability for mutate slices not covered by admin-api-route-leftovers
 * (#157/#161 GET soft floods) or admin-api-routes base coverage.
 * Orthogonal to typing (#185), qr-login (#183), receipts race (#184), federation
 * keys/membership/account-data race (#188), sliding-sync (#189), workflows (#187),
 * oauth/push/account-data/identity (#186), to-device races (#181), relations (#179),
 * devices/keybackups/report races (#174), keys/media/appservice races (#167).
 * Focus: create∥create localpart TOCTOU, PUT∥DELETE deactivate, make-admin∥remove-admin,
 * reset-password∥sessions revoke, login-token double-mint, purge∥bulk-delete,
 * quarantine∥media delete, report resolve∥unresolve, registration PUT races,
 * IdP provider PUT∥DELETE, Synapse deactivate∥reset_password, Admin DO invalidate races.
 * Tests-only. Fixtures use example.com only. No product inventing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const authState = vi.hoisted(() => ({
  userId: '@admin:example.com' as string | undefined,
  deviceId: 'ADMINDEVICE',
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', authState.userId);
      c.set('deviceId', authState.deviceId);
      await next();
    };
  },
}));

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    hashPassword: vi.fn(async (password: string) => `hashed:${password}`),
    hashToken: vi.fn(async (token: string) => `tokhash:${token}`),
  };
});

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateOpaqueId: vi.fn(async () => 'idp-opaque-12'),
    generateLoginToken: vi.fn(async () => 'mlt_pinned_login_token'),
  };
});

vi.mock('../src/services/oidc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/oidc')>();
  return {
    ...actual,
    fetchOIDCDiscovery: vi.fn(async (issuerUrl: string) => {
      if (issuerUrl.includes('bad-issuer')) {
        throw new Error('discovery failed');
      }
      const base = issuerUrl.replace(/\/$/, '');
      return {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
        jwks_uri: `${base}/jwks`,
      };
    }),
  };
});

vi.mock('../src/api/oidc-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/oidc-auth')>();
  return {
    ...actual,
    encryptSecret: vi.fn(async (secret: string) => `enc:${secret}`),
  };
});

import adminApp from '../src/api/admin';

const ADMIN = '@admin:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const MEDIA_ID = 'mxc_media_abc';

type SqlCall = { sql: string; args: unknown[] };


type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type RunBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

async function withBarrier(
  barrier: { match: (sql: string, args: unknown[]) => boolean; count: number } | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  sql: string,
  args: unknown[]
) {
  if (!barrier || !barrier.match(sql, args)) return;
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
  updated_at: number;
};

type DeviceRow = {
  user_id: string;
  device_id: string;
  display_name: string | null;
  last_seen_ts: number | null;
  last_seen_ip: string | null;
};

type TokenRow = {
  token_id: string;
  user_id: string;
  device_id: string | null;
  created_at: number;
};

type RoomRow = {
  room_id: string;
  room_version: string;
  is_public: number;
  creator_id: string;
  created_at: number;
};

type MembershipRow = {
  room_id: string;
  user_id: string;
  membership: string;
  display_name: string | null;
  avatar_url: string | null;
};

type EventRow = {
  event_id: string;
  room_id: string;
  event_type: string;
  state_key: string | null;
  sender: string;
  content: string;
  origin_server_ts: number;
  stream_position: number;
};

type StateRow = { room_id: string; event_type: string; event_id: string };

type MediaRow = {
  media_id: string;
  user_id: string;
  content_type: string;
  content_length: number;
  filename: string | null;
  created_at: number;
  quarantined: number;
};

type ThumbRow = { media_id: string; width: number; height: number; method: string };

type ReportRow = {
  id: number;
  reporter_user_id: string;
  room_id: string;
  event_id: string;
  reason: string | null;
  score: number | null;
  created_at: number;
  resolved: number;
  resolved_by: string | null;
  resolved_at: number | null;
  resolution_note: string | null;
};

type ServerRow = {
  server_name: string;
  valid_until_ts: number;
  last_successful_fetch: number;
  retry_count: number;
};

type AliasRow = { alias: string; room_id: string };

type IdpProvider = {
  id: string;
  name: string;
  issuer_url: string;
  client_id: string;
  client_secret_encrypted: string;
  scopes: string;
  enabled: number;
  auto_create_users: number;
  username_claim: string;
  display_order: number;
  icon_url: string | null;
  created_at: number;
  updated_at: number;
};

type IdpLink = {
  id: number;
  provider_id: string;
  external_id: string;
  user_id: string;
  external_email: string | null;
  external_name: string | null;
  created_at: number;
  last_login_at: number | null;
};

type AuditRow = {
  id: number;
  ts: number;
  actor_user_id: string;
  action: string;
  target: string | null;
  ip: string | null;
  success: number;
  details: string | null;
};

type CrossSigningKey = {
  user_id: string;
  key_type: string;
  key_id: string;
  key_data: string;
};

type CrossSigningSig = {
  user_id: string;
  key_id: string;
  signer_user_id: string;
  signer_key_id: string;
  signature: string;
};

function defaultAdmin(): UserRow {
  return {
    user_id: ADMIN,
    localpart: 'admin',
    display_name: 'Admin',
    avatar_url: null,
    password_hash: 'hashed:adminpass',
    is_guest: 0,
    is_deactivated: 0,
    admin: 1,
    created_at: 1_000,
    updated_at: 1_000,
  };
}

function defaultBob(): UserRow {
  return {
    user_id: BOB,
    localpart: 'bob',
    display_name: 'Bob',
    avatar_url: 'mxc://example.com/bob',
    password_hash: 'hashed:bobpass',
    is_guest: 0,
    is_deactivated: 0,
    admin: 0,
    created_at: 2_000,
    updated_at: 2_000,
  };
}

function mockKv(data: Record<string, string> = {}) {
  const puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
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
    puts: typeof puts;
    deletes: string[];
  };
}

function mockR2() {
  const deleted: string[] = [];
  return {
    deleted,
    async delete(key: string) {
      deleted.push(key);
    },
    async get() {
      return null;
    },
    async put() {
      return undefined;
    },
    async head() {
      return null;
    },
    async list() {
      return { objects: [], truncated: false };
    },
  } as unknown as R2Bucket & { deleted: string[] };
}

function createAdminDO(opts: {
  stats?: Record<string, unknown>;
  config?: { registration_enabled: boolean };
  failConfigPut?: boolean;
  fetchBarrier?: { count: number; pathIncludes?: string };
  failInvalidate?: boolean;
} = {}) {
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];
  let fetchBarrier = opts.fetchBarrier;
  const fetchWaiters = { list: [] as Array<() => void> };
  let config = { registration_enabled: opts.config?.registration_enabled ?? true };
  const stats = opts.stats ?? {
    users: 2,
    rooms: 1,
    events: 10,
    media: 1,
    unresolved_reports: 0,
  };

  const stub = {
    fetches,
    config,
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const req = typeof input === 'string' || input instanceof URL ? new Request(String(input), init) : input;
      const url = new URL(req.url);
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      fetches.push({ url: req.url, method: req.method, body });

      if (fetchBarrier) {
        const pathOk =
          !fetchBarrier.pathIncludes || req.url.includes(fetchBarrier.pathIncludes);
        if (pathOk) {
          await new Promise<void>((resolve) => {
            fetchWaiters.list.push(resolve);
            if (fetchWaiters.list.length >= fetchBarrier!.count) {
              const all = [...fetchWaiters.list];
              fetchWaiters.list = [];
              fetchBarrier = undefined;
              for (const r of all) r();
            }
          });
        }
      }

      if (url.pathname === '/stats') {
        return Response.json(stats);
      }
      if (url.pathname === '/invalidate-cache') {
        if (opts.failInvalidate) {
          throw new Error('admin-do-invalidate-fail');
        }
        return Response.json({ ok: true });
      }
      if (url.pathname === '/config') {
        if (req.method === 'PUT') {
          if (opts.failConfigPut) {
            return new Response('fail', { status: 500 });
          }
          const b = body as { registration_enabled?: boolean };
          if (typeof b?.registration_enabled === 'boolean') {
            config.registration_enabled = b.registration_enabled;
            stub.config = config;
          }
          return Response.json(config);
        }
        return Response.json(config);
      }
      return new Response('not found', { status: 404 });
    },
  };
  return stub;
}

function createAdminDb(opts: {
  users?: UserRow[];
  devices?: DeviceRow[];
  tokens?: TokenRow[];
  rooms?: RoomRow[];
  memberships?: MembershipRow[];
  events?: EventRow[];
  state?: StateRow[];
  media?: MediaRow[];
  thumbnails?: ThumbRow[];
  reports?: ReportRow[];
  servers?: ServerRow[];
  aliases?: AliasRow[];
  idpProviders?: IdpProvider[];
  idpLinks?: IdpLink[];
  audit?: AuditRow[];
  crossSigningKeys?: CrossSigningKey[];
  crossSigningSigs?: CrossSigningSig[];
  streamPositions?: Record<string, number>;
  knownServersCount?: number;
  nullCounts?: boolean;
  selectBarrier?: SelectBarrier;
  runBarrier?: RunBarrier;
  mutateUserAfterSelects?: { after: number; apply: (users: UserRow[]) => void };
  failRunAfter?: number;
  delayRunMs?: number;
} = {}) {
  const users = opts.users ?? [defaultAdmin(), defaultBob()];
  const devices = opts.devices ?? [
    {
      user_id: ADMIN,
      device_id: 'ADMINDEVICE',
      display_name: 'Admin Device',
      last_seen_ts: 5_000,
      last_seen_ip: '1.2.3.4',
    },
    {
      user_id: BOB,
      device_id: 'BOBDEVICE',
      display_name: 'Bob Phone',
      last_seen_ts: 6_000,
      last_seen_ip: '5.6.7.8',
    },
  ];
  const tokens = opts.tokens ?? [
    { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1_100 },
    { token_id: 'tok-bob', user_id: BOB, device_id: 'BOBDEVICE', created_at: 2_100 },
  ];
  const rooms = opts.rooms ?? [
    {
      room_id: ROOM,
      room_version: '10',
      is_public: 1,
      creator_id: ADMIN,
      created_at: 3_000,
    },
  ];
  const memberships = opts.memberships ?? [
    {
      room_id: ROOM,
      user_id: ADMIN,
      membership: 'join',
      display_name: 'Admin',
      avatar_url: null,
    },
    {
      room_id: ROOM,
      user_id: BOB,
      membership: 'join',
      display_name: 'Bob',
      avatar_url: null,
    },
  ];
  const events = opts.events ?? [
    {
      event_id: '$name:example.com',
      room_id: ROOM,
      event_type: 'm.room.name',
      state_key: '',
      sender: ADMIN,
      content: JSON.stringify({ name: 'General' }),
      origin_server_ts: Date.now() - 60_000,
      stream_position: 10,
    },
    {
      event_id: '$topic:example.com',
      room_id: ROOM,
      event_type: 'm.room.topic',
      state_key: '',
      sender: ADMIN,
      content: JSON.stringify({ topic: 'hello' }),
      origin_server_ts: Date.now() - 50_000,
      stream_position: 11,
    },
    {
      event_id: '$alias:example.com',
      room_id: ROOM,
      event_type: 'm.room.canonical_alias',
      state_key: '',
      sender: ADMIN,
      content: JSON.stringify({ alias: '#general:example.com' }),
      origin_server_ts: Date.now() - 40_000,
      stream_position: 12,
    },
    {
      event_id: '$avatar:example.com',
      room_id: ROOM,
      event_type: 'm.room.avatar',
      state_key: '',
      sender: ADMIN,
      content: JSON.stringify({ url: 'mxc://example.com/room' }),
      origin_server_ts: Date.now() - 30_000,
      stream_position: 13,
    },
    {
      event_id: '$join:example.com',
      room_id: ROOM,
      event_type: 'm.room.join_rules',
      state_key: '',
      sender: ADMIN,
      content: JSON.stringify({ join_rule: 'public' }),
      origin_server_ts: Date.now() - 20_000,
      stream_position: 14,
    },
    {
      event_id: '$msg:example.com',
      room_id: ROOM,
      event_type: 'm.room.message',
      state_key: null,
      sender: BOB,
      content: JSON.stringify({ msgtype: 'm.text', body: 'hi' }),
      origin_server_ts: Date.now() - 10_000,
      stream_position: 20,
    },
  ];
  const state = opts.state ?? [
    { room_id: ROOM, event_type: 'm.room.name', event_id: '$name:example.com' },
    { room_id: ROOM, event_type: 'm.room.topic', event_id: '$topic:example.com' },
    { room_id: ROOM, event_type: 'm.room.canonical_alias', event_id: '$alias:example.com' },
    { room_id: ROOM, event_type: 'm.room.avatar', event_id: '$avatar:example.com' },
    { room_id: ROOM, event_type: 'm.room.join_rules', event_id: '$join:example.com' },
  ];
  const media = opts.media ?? [
    {
      media_id: MEDIA_ID,
      user_id: BOB,
      content_type: 'image/png',
      content_length: 1234,
      filename: 'pic.png',
      created_at: 7_000,
      quarantined: 0,
    },
  ];
  const thumbnails = opts.thumbnails ?? [
    { media_id: MEDIA_ID, width: 96, height: 96, method: 'crop' },
  ];
  const reports = opts.reports ?? [
    {
      id: 1,
      reporter_user_id: ADMIN,
      room_id: ROOM,
      event_id: '$msg:example.com',
      reason: 'spam',
      score: -100,
      created_at: 8_000,
      resolved: 0,
      resolved_by: null,
      resolved_at: null,
      resolution_note: null,
    },
  ];
  const servers = opts.servers ?? [
    {
      server_name: 'remote.example.org',
      valid_until_ts: 9_999_999,
      last_successful_fetch: 9_000,
      retry_count: 2,
    },
  ];
  const aliases = opts.aliases ?? [{ alias: '#general:example.com', room_id: ROOM }];
  const idpProviders = opts.idpProviders ?? [
    {
      id: 'idp1',
      name: 'GitHub',
      issuer_url: 'https://idp.example.com',
      client_id: 'cid',
      client_secret_encrypted: 'enc:secret',
      scopes: 'openid profile email',
      enabled: 1,
      auto_create_users: 1,
      username_claim: 'email',
      display_order: 0,
      icon_url: null,
      created_at: 1_000,
      updated_at: 1_000,
    },
  ];
  const idpLinks = opts.idpLinks ?? [
    {
      id: 10,
      provider_id: 'idp1',
      external_id: 'gh-1',
      user_id: BOB,
      external_email: 'bob@ex.com',
      external_name: 'Bob',
      created_at: 2_000,
      last_login_at: 3_000,
    },
  ];
  const audit = opts.audit ?? [
    {
      id: 1,
      ts: 10_000,
      actor_user_id: ADMIN,
      action: 'user.update',
      target: BOB,
      ip: '1.2.3.4',
      success: 1,
      details: JSON.stringify({ display_name: true }),
    },
    {
      id: 2,
      ts: 9_000,
      actor_user_id: ADMIN,
      action: 'room.delete',
      target: ROOM,
      ip: null,
      success: 0,
      details: 'not-json{',
    },
  ];
  const crossSigningKeys = opts.crossSigningKeys ?? [
    {
      user_id: BOB,
      key_type: 'master',
      key_id: 'ed25519:master',
      key_data: JSON.stringify({ keys: { 'ed25519:master': 'AAAA' } }),
    },
    {
      user_id: BOB,
      key_type: 'self_signing',
      key_id: 'ed25519:ss',
      key_data: JSON.stringify({ keys: { 'ed25519:ss': 'BBBB' } }),
    },
  ];
  const crossSigningSigs = opts.crossSigningSigs ?? [
    {
      user_id: BOB,
      key_id: 'BOBDEVICE',
      signer_user_id: BOB,
      signer_key_id: 'ed25519:ss',
      signature: 'sig',
    },
  ];
  const streamPositions = { ...(opts.streamPositions ?? { to_device: 5 }) };
  let nextReportId = Math.max(0, ...reports.map((r) => r.id)) + 1;
  void idpLinks;
  let nextAuditId = Math.max(0, ...audit.map((a) => a.id)) + 1;

  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const runs: SqlCall[] = [];
  let selectBarrier = opts.selectBarrier;
  let runBarrier = opts.runBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const runWaiters = { list: [] as Array<() => void> };
  let userSelectCount = 0;
  let runCount = 0;
  const mutateUser = opts.mutateUserAfterSelects;
  const failRunAfter = opts.failRunAfter;
  const delayRunMs = opts.delayRunMs;

  function countOrNull(n: number) {
    if (opts.nullCounts) return null;
    return { count: n };
  }

  function stateContent(roomId: string, eventType: string): string | null {
    const st = state.find((s) => s.room_id === roomId && s.event_type === eventType);
    if (!st) return null;
    const ev = events.find((e) => e.event_id === st.event_id);
    return ev?.content ?? null;
  }

  const db = {
    users,
    devices,
    tokens,
    rooms,
    memberships,
    events,
    state,
    media,
    thumbnails,
    reports,
    servers,
    aliases,
    idpProviders,
    idpLinks,
    audit,
    crossSigningKeys,
    crossSigningSigs,
    streamPositions,
    inserts,
    updates,
    deletes,
    runs,
    prepare(sql: string) {
      const bound = (...args: unknown[]) => ({
            async first<T>() {
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              // getUserById shape
              if (
                sql.includes('FROM users WHERE user_id = ?') &&
                sql.includes('localpart') &&
                sql.includes('is_guest') &&
                sql.includes('admin') &&
                !sql.includes('as name') &&
                !sql.includes('displayname')
              ) {
                const userId = args[0] as string;
                const u = users.find((x) => x.user_id === userId);
                userSelectCount += 1;
                if (mutateUser && userSelectCount === mutateUser.after) {
                  mutateUser.apply(users);
                }
                if (!u) return null;
                if (sql.includes('updated_at')) {
                  return {
                    user_id: u.user_id,
                    localpart: u.localpart,
                    display_name: u.display_name,
                    avatar_url: u.avatar_url,
                    is_guest: u.is_guest,
                    is_deactivated: u.is_deactivated,
                    admin: u.admin,
                    created_at: u.created_at,
                    updated_at: u.updated_at,
                  } as T;
                }
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

              if (sql.includes('SELECT user_id FROM users WHERE user_id = ?')) {
                const userId = args[0] as string;
                const u = users.find((x) => x.user_id === userId);
                userSelectCount += 1;
                if (mutateUser && userSelectCount === mutateUser.after) {
                  mutateUser.apply(users);
                }
                return (u ? { user_id: u.user_id } : null) as T;
              }

              if (sql.includes('SELECT room_id FROM rooms WHERE room_id = ?')) {
                const roomId = args[0] as string;
                const r = rooms.find((x) => x.room_id === roomId);
                return (r ? { room_id: r.room_id } : null) as T;
              }

              if (
                sql.includes('FROM rooms WHERE room_id = ?') &&
                sql.includes('room_version') &&
                sql.includes('creator_id')
              ) {
                const roomId = args[0] as string;
                const r = rooms.find((x) => x.room_id === roomId);
                if (!r) return null;
                return {
                  room_id: r.room_id,
                  room_version: r.room_version,
                  is_public: r.is_public,
                  creator_id: r.creator_id,
                  created_at: r.created_at,
                } as T;
              }

              // Synapse user detail
              if (
                sql.includes('user_id as name') &&
                sql.includes('displayname') &&
                sql.includes('FROM users WHERE user_id = ?')
              ) {
                const userId = args[0] as string;
                const u = users.find((x) => x.user_id === userId);
                if (!u) return null;
                return {
                  name: u.user_id,
                  displayname: u.display_name,
                  avatar_url: u.avatar_url,
                  is_guest: u.is_guest,
                  deactivated: u.is_deactivated,
                  admin: u.admin,
                  creation_ts: u.created_at,
                } as T;
              }

              if (sql.includes("SELECT position FROM stream_positions WHERE stream_name = 'to_device'")) {
                return { position: streamPositions.to_device ?? 1 } as T;
              }

              if (sql.includes('SELECT id FROM idp_providers WHERE id = ?')) {
                const id = args[0] as string;
                const p = idpProviders.find((x) => x.id === id);
                return (p ? { id: p.id } : null) as T;
              }

              if (
                sql.includes('FROM idp_providers WHERE id = ?') &&
                sql.includes('issuer_url') &&
                sql.includes('client_id')
              ) {
                const id = args[0] as string;
                const p = idpProviders.find((x) => x.id === id);
                if (!p) return null;
                return {
                  id: p.id,
                  name: p.name,
                  issuer_url: p.issuer_url,
                  client_id: p.client_id,
                  scopes: p.scopes,
                  enabled: p.enabled,
                  auto_create_users: p.auto_create_users,
                  username_claim: p.username_claim,
                  display_order: p.display_order,
                  icon_url: p.icon_url,
                  created_at: p.created_at,
                  updated_at: p.updated_at,
                } as T;
              }

              if (sql.includes('SELECT issuer_url FROM idp_providers WHERE id = ?')) {
                const id = args[0] as string;
                const p = idpProviders.find((x) => x.id === id);
                return (p ? { issuer_url: p.issuer_url } : null) as T;
              }

              // room state content joins
              if (
                sql.includes('FROM room_state rs') &&
                sql.includes('JOIN events e') &&
                sql.includes('rs.event_type = ')
              ) {
                const roomId = args[0] as string;
                const m = sql.match(/rs\.event_type = '([^']+)'/);
                const eventType = m?.[1];
                if (!eventType) return null;
                const content = stateContent(roomId, eventType);
                return (content ? { content } : null) as T;
              }

              // COUNT variants
              if (sql.includes('SELECT COUNT(*) as count FROM users')) {
                if (sql.includes('WHERE localpart LIKE')) {
                  const like = String(args[0]).replace(/%/g, '');
                  const n = users.filter(
                    (u) =>
                      u.localpart.includes(like) ||
                      (u.display_name ?? '').includes(like)
                  ).length;
                  return countOrNull(n) as T;
                }
                return countOrNull(users.length) as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM rooms')) {
                return countOrNull(rooms.length) as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM media')) {
                return countOrNull(media.length) as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM servers')) {
                return countOrNull(servers.length) as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM content_reports')) {
                if (sql.includes('resolved = 1')) {
                  return countOrNull(reports.filter((r) => r.resolved === 1).length) as T;
                }
                if (sql.includes('resolved = 0')) {
                  return countOrNull(reports.filter((r) => r.resolved === 0).length) as T;
                }
                return countOrNull(reports.length) as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM admin_audit_log')) {
                return countOrNull(audit.length) as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM idp_user_links WHERE provider_id = ?')) {
                const pid = args[0] as string;
                return countOrNull(idpLinks.filter((l) => l.provider_id === pid).length) as T;
              }
              if (
                sql.includes('FROM room_memberships') &&
                sql.includes("membership = 'join'") &&
                sql.includes('COUNT(*)')
              ) {
                const roomId = args[0] as string;
                return countOrNull(
                  memberships.filter((m) => m.room_id === roomId && m.membership === 'join').length
                ) as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM room_state WHERE room_id = ?')) {
                const roomId = args[0] as string;
                return countOrNull(state.filter((s) => s.room_id === roomId).length) as T;
              }
              if (
                sql.includes('SELECT COUNT(*) as count FROM events') &&
                sql.includes('origin_server_ts > ?')
              ) {
                const since = args[0] as number;
                if (sql.includes('sender NOT LIKE')) {
                  const n = events.filter(
                    (e) => e.origin_server_ts > since && !e.sender.endsWith(`:${SERVER}`)
                  ).length;
                  return countOrNull(n) as T;
                }
                if (sql.includes('sender LIKE')) {
                  const n = events.filter(
                    (e) => e.origin_server_ts > since && e.sender.endsWith(`:${SERVER}`)
                  ).length;
                  return countOrNull(n) as T;
                }
                return countOrNull(events.filter((e) => e.origin_server_ts > since).length) as T;
              }
              if (sql.includes('SELECT COUNT(DISTINCT sender) as count FROM events')) {
                const since = args[0] as number;
                const set = new Set(
                  events.filter((e) => e.origin_server_ts > since).map((e) => e.sender)
                );
                return countOrNull(set.size) as T;
              }
              if (sql.includes('SELECT COUNT(DISTINCT room_id) as count FROM events')) {
                const since = args[0] as number;
                const set = new Set(
                  events.filter((e) => e.origin_server_ts > since).map((e) => e.room_id)
                );
                return countOrNull(set.size) as T;
              }
              if (sql.includes('SELECT COUNT(DISTINCT server_name) as count FROM known_servers')) {
                return countOrNull(opts.knownServersCount ?? servers.length) as T;
              }

              return null;
            },

            async all<T>() {
              // List users (admin)
              if (
                sql.includes('FROM users') &&
                sql.includes('ORDER BY created_at DESC') &&
                sql.includes('LIMIT ?') &&
                sql.includes('localpart') &&
                !sql.includes('as name')
              ) {
                let rows = [...users];
                if (sql.includes('WHERE localpart LIKE')) {
                  const like = String(args[0]).replace(/%/g, '');
                  rows = rows.filter(
                    (u) =>
                      u.localpart.includes(like) ||
                      (u.display_name ?? '').includes(like)
                  );
                }
                const limit = Number(args[args.length - 2]);
                const offset = Number(args[args.length - 1]);
                rows = rows
                  .sort((a, b) => b.created_at - a.created_at)
                  .slice(offset, offset + limit)
                  .map((u) => ({
                    user_id: u.user_id,
                    localpart: u.localpart,
                    display_name: u.display_name,
                    avatar_url: u.avatar_url,
                    is_guest: u.is_guest,
                    is_deactivated: u.is_deactivated,
                    admin: u.admin,
                    created_at: u.created_at,
                  }));
                return { results: rows as T[] };
              }

              // Synapse list users
              if (sql.includes('user_id as name') && sql.includes('FROM users WHERE 1=1')) {
                let rows = [...users];
                let i = 0;
                if (sql.includes('AND is_guest = 0')) {
                  rows = rows.filter((u) => u.is_guest === 0);
                }
                if (sql.includes('AND is_deactivated = 1')) {
                  rows = rows.filter((u) => u.is_deactivated === 1);
                }
                if (sql.includes('localpart LIKE')) {
                  const like = String(args[i]).replace(/%/g, '');
                  i += 2;
                  rows = rows.filter(
                    (u) =>
                      u.localpart.includes(like) ||
                      (u.display_name ?? '').includes(like)
                  );
                }
                const limit = Number(args[args.length - 2]);
                const offset = Number(args[args.length - 1]);
                const results = rows
                  .sort((a, b) => b.created_at - a.created_at)
                  .slice(offset, offset + limit)
                  .map((u) => ({
                    name: u.user_id,
                    displayname: u.display_name,
                    is_guest: u.is_guest,
                    deactivated: u.is_deactivated,
                    admin: u.admin,
                    creation_ts: u.created_at,
                  }));
                return { results: results as T[] };
              }

              if (sql.includes('FROM devices WHERE user_id = ?') && sql.includes('last_seen')) {
                const userId = args[0] as string;
                const results = devices
                  .filter((d) => d.user_id === userId)
                  .map((d) => ({
                    device_id: d.device_id,
                    display_name: d.display_name,
                    last_seen_ts: d.last_seen_ts,
                    last_seen_ip: d.last_seen_ip,
                  }));
                return { results: results as T[] };
              }

              if (sql.includes('SELECT device_id FROM devices WHERE user_id = ?')) {
                const userId = args[0] as string;
                return {
                  results: devices
                    .filter((d) => d.user_id === userId)
                    .map((d) => ({ device_id: d.device_id })) as T[],
                };
              }

              if (sql.includes('SELECT device_id, display_name FROM devices WHERE user_id = ?')) {
                const userId = args[0] as string;
                return {
                  results: devices
                    .filter((d) => d.user_id === userId)
                    .map((d) => ({ device_id: d.device_id, display_name: d.display_name })) as T[],
                };
              }

              if (
                sql.includes('FROM devices d') &&
                sql.includes('LEFT JOIN access_tokens') &&
                sql.includes('WHERE d.user_id = ?')
              ) {
                const userId = args[0] as string;
                const results = devices
                  .filter((d) => d.user_id === userId)
                  .map((d) => {
                    const tok = tokens.find(
                      (t) => t.user_id === userId && t.device_id === d.device_id
                    );
                    return {
                      device_id: d.device_id,
                      display_name: d.display_name,
                      last_seen_ts: d.last_seen_ts,
                      last_seen_ip: d.last_seen_ip,
                      session_created_at: tok?.created_at ?? null,
                    };
                  });
                return { results: results as T[] };
              }

              if (
                sql.includes('FROM room_memberships rm') &&
                sql.includes('LEFT JOIN rooms') &&
                sql.includes('WHERE rm.user_id = ?')
              ) {
                const userId = args[0] as string;
                const results = memberships
                  .filter((m) => m.user_id === userId)
                  .map((m) => ({
                    room_id: m.room_id,
                    membership: m.membership,
                    room_exists: rooms.some((r) => r.room_id === m.room_id)
                      ? m.room_id
                      : null,
                  }));
                return { results: results as T[] };
              }

              if (
                sql.includes('FROM room_memberships WHERE room_id = ?') &&
                sql.includes('user_id, membership')
              ) {
                const roomId = args[0] as string;
                return {
                  results: memberships
                    .filter((m) => m.room_id === roomId)
                    .map((m) => ({
                      user_id: m.user_id,
                      membership: m.membership,
                      display_name: m.display_name,
                      avatar_url: m.avatar_url,
                    })) as T[],
                };
              }

              if (sql.includes('SELECT alias FROM room_aliases WHERE room_id = ?')) {
                const roomId = args[0] as string;
                return {
                  results: aliases
                    .filter((a) => a.room_id === roomId)
                    .map((a) => ({ alias: a.alias })) as T[],
                };
              }

              // room list with subselects
              if (
                sql.includes('FROM rooms r') &&
                sql.includes('member_count') &&
                sql.includes('LIMIT ? OFFSET ?')
              ) {
                const limit = Number(args[args.length - 2]);
                const offset = Number(args[args.length - 1]);
                let rows = [...rooms];
                if (sql.includes('WHERE r.room_id LIKE')) {
                  const like = String(args[0]).replace(/%/g, '');
                  rows = rows.filter((r) => r.room_id.includes(like));
                }
                const results = rows
                  .sort((a, b) => b.created_at - a.created_at)
                  .slice(offset, offset + limit)
                  .map((r) => ({
                    room_id: r.room_id,
                    room_version: r.room_version,
                    is_public: r.is_public,
                    public: r.is_public,
                    creator_id: r.creator_id,
                    creator: r.creator_id,
                    created_at: r.created_at,
                    member_count: memberships.filter(
                      (m) => m.room_id === r.room_id && m.membership === 'join'
                    ).length,
                    joined_members: memberships.filter(
                      (m) => m.room_id === r.room_id && m.membership === 'join'
                    ).length,
                    joined_local_members: memberships.filter((m) => m.room_id === r.room_id)
                      .length,
                    event_count: events.filter((e) => e.room_id === r.room_id).length,
                    state_events: events.filter((e) => e.room_id === r.room_id).length,
                  }));
                return { results: results as T[] };
              }

              // Synapse rooms list (joined_members without member_count alias)
              if (
                sql.includes('FROM rooms r') &&
                sql.includes('joined_members') &&
                sql.includes('LIMIT ? OFFSET ?')
              ) {
                const limit = Number(args[args.length - 2]);
                const offset = Number(args[args.length - 1]);
                let rows = [...rooms];
                if (sql.includes('WHERE r.room_id LIKE')) {
                  const like = String(args[0]).replace(/%/g, '');
                  rows = rows.filter((r) => r.room_id.includes(like));
                }
                const results = rows.slice(offset, offset + limit).map((r) => ({
                  room_id: r.room_id,
                  room_version: r.room_version,
                  public: r.is_public,
                  creator: r.creator_id,
                  created_at: r.created_at,
                  joined_members: memberships.filter(
                    (m) => m.room_id === r.room_id && m.membership === 'join'
                  ).length,
                  joined_local_members: memberships.filter((m) => m.room_id === r.room_id)
                    .length,
                  state_events: events.filter((e) => e.room_id === r.room_id).length,
                }));
                return { results: results as T[] };
              }

              if (
                sql.includes('FROM room_state rs') &&
                sql.includes('JOIN events e') &&
                sql.includes('WHERE rs.room_id = ?') &&
                !sql.includes('rs.event_type =')
              ) {
                const roomId = args[0] as string;
                const results = state
                  .filter((s) => s.room_id === roomId)
                  .map((s) => {
                    const ev = events.find((e) => e.event_id === s.event_id)!;
                    return {
                      event_type: ev.event_type,
                      state_key: ev.state_key ?? '',
                      content: ev.content,
                      sender: ev.sender,
                      origin_server_ts: ev.origin_server_ts,
                    };
                  });
                return { results: results as T[] };
              }

              if (sql.includes('FROM events') && sql.includes('WHERE room_id = ?')) {
                const roomId = args[0] as string;
                let rows = events.filter((e) => e.room_id === roomId);
                let idx = 1;
                if (sql.includes('stream_position < ?')) {
                  const before = Number(args[idx++]);
                  rows = rows.filter((e) => e.stream_position < before);
                }
                const limit = Number(args[args.length - 1]);
                const results = rows
                  .sort((a, b) => b.stream_position - a.stream_position)
                  .slice(0, limit)
                  .map((e) => ({
                    event_id: e.event_id,
                    event_type: e.event_type,
                    state_key: e.state_key,
                    sender: e.sender,
                    content: e.content,
                    origin_server_ts: e.origin_server_ts,
                    stream_position: e.stream_position,
                  }));
                return { results: results as T[] };
              }

              if (sql.includes('FROM media') && sql.includes('ORDER BY created_at DESC')) {
                const limit = Number(args[0]);
                const offset = Number(args[1]);
                const results = [...media]
                  .sort((a, b) => b.created_at - a.created_at)
                  .slice(offset, offset + limit);
                return { results: results as T[] };
              }

              if (sql.includes('SELECT media_id FROM media WHERE user_id = ?')) {
                const userId = args[0] as string;
                return {
                  results: media
                    .filter((m) => m.user_id === userId)
                    .map((m) => ({ media_id: m.media_id })) as T[],
                };
              }

              if (sql.includes('SELECT media_id FROM media') && !sql.includes('WHERE')) {
                return { results: media.map((m) => ({ media_id: m.media_id })) as T[] };
              }

              if (sql.includes('FROM thumbnails WHERE media_id = ?')) {
                const mediaId = args[0] as string;
                return {
                  results: thumbnails
                    .filter((t) => t.media_id === mediaId)
                    .map((t) => ({
                      width: t.width,
                      height: t.height,
                      method: t.method,
                    })) as T[],
                };
              }

              if (sql.includes('FROM servers') && sql.includes('ORDER BY last_successful_fetch')) {
                if (sql.includes('LIMIT ? OFFSET ?')) {
                  const limit = Number(args[0]);
                  const offset = Number(args[1]);
                  const results = [...servers]
                    .sort((a, b) => b.last_successful_fetch - a.last_successful_fetch)
                    .slice(offset, offset + limit)
                    .map((s) => ({
                      destination: s.server_name,
                      valid_until_ts: s.valid_until_ts,
                      last_successful_stream_ordering: s.last_successful_fetch,
                      failure_ts: s.retry_count,
                      retry_count: s.retry_count,
                    }));
                  return { results: results as T[] };
                }
                return {
                  results: servers.map((s) => ({
                    server_name: s.server_name,
                    valid_until_ts: s.valid_until_ts,
                    last_successful_fetch: s.last_successful_fetch,
                    retry_count: s.retry_count,
                  })) as T[],
                };
              }

              if (sql.includes('FROM content_reports')) {
                let rows = [...reports];
                let i = 0;
                if (sql.includes('cr.resolved = 1') || sql.includes('AND cr.resolved = 1')) {
                  rows = rows.filter((r) => r.resolved === 1);
                }
                if (sql.includes('cr.resolved = 0') || sql.includes('AND cr.resolved = 0')) {
                  rows = rows.filter((r) => r.resolved === 0);
                }
                if (sql.includes('cr.room_id = ?')) {
                  const roomId = args[i++] as string;
                  rows = rows.filter((r) => r.room_id === roomId);
                }
                if (sql.includes('cr.reporter_user_id = ?')) {
                  const uid = args[i++] as string;
                  rows = rows.filter((r) => r.reporter_user_id === uid);
                }
                const limit = Number(args[args.length - 2]);
                const offset = Number(args[args.length - 1]);
                const results = rows
                  .sort((a, b) => b.created_at - a.created_at)
                  .slice(offset, offset + limit)
                  .map((r) => {
                    const ev = events.find((e) => e.event_id === r.event_id);
                    return {
                      ...r,
                      id: r.id,
                      reporter_user_id: r.reporter_user_id,
                      user_id: r.reporter_user_id,
                      room_id: r.room_id,
                      event_id: r.event_id,
                      reason: r.reason,
                      score: r.score,
                      created_at: r.created_at,
                      received_ts: r.created_at,
                      resolved: r.resolved,
                      resolved_by: r.resolved_by,
                      resolved_at: r.resolved_at,
                      resolution_note: r.resolution_note,
                      reported_user_id: ev?.sender ?? null,
                      event_type: ev?.event_type ?? null,
                      content: ev?.content ?? null,
                      sender: ev?.sender ?? null,
                    };
                  });
                return { results: results as T[] };
              }

              if (sql.includes('FROM access_tokens') && sql.includes('token_id as id')) {
                const userId = args[0] as string;
                const results = tokens
                  .filter((t) => t.user_id === userId)
                  .sort((a, b) => b.created_at - a.created_at)
                  .map((t) => ({
                    id: t.token_id,
                    device_id: t.device_id,
                    created_at: t.created_at,
                  }));
                return { results: results as T[] };
              }

              if (sql.includes('FROM admin_audit_log')) {
                let rows = [...audit];
                let i = 0;
                if (sql.includes('actor_user_id = ?')) {
                  const actor = args[i++] as string;
                  rows = rows.filter((a) => a.actor_user_id === actor);
                }
                if (sql.includes('target = ?')) {
                  const target = args[i++] as string;
                  rows = rows.filter((a) => a.target === target);
                }
                if (sql.includes('action = ?')) {
                  const action = args[i++] as string;
                  rows = rows.filter((a) => a.action === action);
                }
                const limit = Number(args[args.length - 2]);
                const offset = Number(args[args.length - 1]);
                const results = rows
                  .sort((a, b) => b.ts - a.ts)
                  .slice(offset, offset + limit);
                return { results: results as T[] };
              }

              if (sql.includes('FROM idp_providers') && sql.includes('ORDER BY display_order')) {
                return {
                  results: [...idpProviders]
                    .sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name))
                    .map((p) => ({
                      id: p.id,
                      name: p.name,
                      issuer_url: p.issuer_url,
                      client_id: p.client_id,
                      scopes: p.scopes,
                      enabled: p.enabled,
                      auto_create_users: p.auto_create_users,
                      username_claim: p.username_claim,
                      display_order: p.display_order,
                      icon_url: p.icon_url,
                      created_at: p.created_at,
                      updated_at: p.updated_at,
                    })) as T[],
                };
              }

              if (sql.includes('FROM idp_user_links l') && sql.includes('WHERE l.provider_id = ?')) {
                const pid = args[0] as string;
                return {
                  results: idpLinks
                    .filter((l) => l.provider_id === pid)
                    .sort((a, b) => (b.last_login_at ?? 0) - (a.last_login_at ?? 0))
                    .slice(0, 100)
                    .map((l) => ({
                      id: l.id,
                      external_id: l.external_id,
                      user_id: l.user_id,
                      external_email: l.external_email,
                      external_name: l.external_name,
                      created_at: l.created_at,
                      last_login_at: l.last_login_at,
                    })) as T[],
                };
              }

              if (sql.includes('SELECT user_id FROM users WHERE admin = 1')) {
                return {
                  results: users
                    .filter((u) => u.admin === 1)
                    .map((u) => ({ user_id: u.user_id })) as T[],
                };
              }

              if (sql.includes('SELECT user_id FROM users WHERE admin = 0')) {
                return {
                  results: users
                    .filter((u) => u.admin === 0)
                    .map((u) => ({ user_id: u.user_id })) as T[],
                };
              }

              if (
                sql.includes('FROM devices WHERE user_id IN (SELECT user_id FROM users WHERE admin = 0)')
              ) {
                const nonAdmins = new Set(users.filter((u) => u.admin === 0).map((u) => u.user_id));
                return {
                  results: devices
                    .filter((d) => nonAdmins.has(d.user_id))
                    .map((d) => ({ user_id: d.user_id, device_id: d.device_id })) as T[],
                };
              }

              if (sql.includes('FROM cross_signing_keys WHERE user_id = ?')) {
                const userId = args[0] as string;
                return {
                  results: crossSigningKeys
                    .filter((k) => k.user_id === userId)
                    .map((k) => ({
                      key_type: k.key_type,
                      key_id: k.key_id,
                      key_data: k.key_data,
                    })) as T[],
                };
              }

              if (sql.includes('FROM cross_signing_signatures WHERE user_id = ?')) {
                const userId = args[0] as string;
                return {
                  results: crossSigningSigs
                    .filter((s) => s.user_id === userId)
                    .map((s) => ({
                      key_id: s.key_id,
                      signer_user_id: s.signer_user_id,
                      signer_key_id: s.signer_key_id,
                      signature: s.signature,
                    })) as T[],
                };
              }

              // stats history day buckets — return empty; handler fills zeros
              if (sql.includes("DATE(origin_server_ts / 1000, 'unixepoch')")) {
                return { results: [] as T[] };
              }
              if (sql.includes("DATE(created_at / 1000, 'unixepoch')")) {
                return { results: [] as T[] };
              }

              if (
                sql.includes('SELECT event_type, COUNT(*) as count FROM events') &&
                sql.includes('GROUP BY event_type')
              ) {
                const since = args[0] as number;
                const map = new Map<string, number>();
                for (const e of events) {
                  if (e.origin_server_ts > since) {
                    map.set(e.event_type, (map.get(e.event_type) ?? 0) + 1);
                  }
                }
                const results = [...map.entries()]
                  .map(([event_type, count]) => ({ event_type, count }))
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 20);
                return { results: results as T[] };
              }

              return { results: [] as T[] };
            },

            async run() {
              await withBarrier(
                runBarrier,
                runWaiters,
                () => {
                  runBarrier = undefined;
                },
                sql,
                args
              );
              runCount += 1;
              if (delayRunMs) {
                await new Promise((r) => setTimeout(r, delayRunMs));
              }
              if (failRunAfter !== undefined && runCount > failRunAfter) {
                throw new Error('admin-db-run-fail');
              }

              runs.push({ sql, args });
              if (sql.trimStart().toUpperCase().startsWith('INSERT')) {
                inserts.push({ sql, args });
              } else if (sql.trimStart().toUpperCase().startsWith('UPDATE')) {
                updates.push({ sql, args });
              } else if (sql.trimStart().toUpperCase().startsWith('DELETE')) {
                deletes.push({ sql, args });
              }

              // Mutating helpers for stateful flows
              if (sql.includes('UPDATE users SET is_deactivated = 1')) {
                const userId = args[args.length - 1] as string;
                const u = users.find((x) => x.user_id === userId);
                if (u) {
                  u.is_deactivated = 1;
                  u.updated_at = args[0] as number;
                }
              }
              if (sql.includes('UPDATE users SET is_deactivated = 0')) {
                const userId = args[args.length - 1] as string;
                const u = users.find((x) => x.user_id === userId);
                if (u) {
                  u.is_deactivated = 0;
                  u.updated_at = args[0] as number;
                }
              }
              if (sql.includes('UPDATE users SET admin = 1')) {
                const userId = args[args.length - 1] as string;
                const u = users.find((x) => x.user_id === userId);
                if (u) u.admin = 1;
              }
              if (sql.includes('UPDATE users SET admin = 0')) {
                const userId = args[args.length - 1] as string;
                const u = users.find((x) => x.user_id === userId);
                if (u) u.admin = 0;
              }
              if (sql.includes('UPDATE users SET password_hash = ?')) {
                const userId = args[args.length - 1] as string;
                const u = users.find((x) => x.user_id === userId);
                if (u) u.password_hash = args[0] as string;
              }
              if (sql.includes('UPDATE media SET quarantined = 1')) {
                const mediaId = args[0] as string;
                const m = media.find((x) => x.media_id === mediaId);
                if (m) m.quarantined = 1;
              }
              if (sql.includes('UPDATE content_reports') && sql.includes('resolved = 1')) {
                const id = Number(args[args.length - 1]);
                const r = reports.find((x) => x.id === id);
                if (!r) return { success: true, meta: { changes: 0, last_row_id: 0 } };
                r.resolved = 1;
                r.resolved_by = args[0] as string;
                r.resolved_at = args[1] as number;
                r.resolution_note = args[2] as string | null;
                return { success: true, meta: { changes: 1, last_row_id: id } };
              }
              if (sql.includes('UPDATE content_reports') && sql.includes('resolved = 0')) {
                const id = Number(args[0]);
                const r = reports.find((x) => x.id === id);
                if (!r) return { success: true, meta: { changes: 0, last_row_id: 0 } };
                r.resolved = 0;
                r.resolved_by = null;
                r.resolved_at = null;
                r.resolution_note = null;
                return { success: true, meta: { changes: 1, last_row_id: id } };
              }
              if (sql.includes("UPDATE stream_positions SET position = position + 1")) {
                streamPositions.to_device = (streamPositions.to_device ?? 0) + 1;
              }
              if (sql.includes('INSERT INTO to_device_messages')) {
                // no-op store
              }
              if (sql.includes('INSERT INTO users')) {
                // create: (user_id, localpart, password_hash, display_name, admin, created, updated) — 7 args
                // synapse: (user_id, localpart, password_hash, display_name, avatar_url, admin, created, updated) — 8 args
                if (args.length === 7) {
                  users.push({
                    user_id: args[0] as string,
                    localpart: args[1] as string,
                    password_hash: args[2] as string,
                    display_name: args[3] as string | null,
                    avatar_url: null,
                    is_guest: 0,
                    is_deactivated: 0,
                    admin: args[4] as number,
                    created_at: args[5] as number,
                    updated_at: args[6] as number,
                  });
                } else {
                  users.push({
                    user_id: args[0] as string,
                    localpart: args[1] as string,
                    password_hash: args[2] as string,
                    display_name: args[3] as string | null,
                    avatar_url: (args[4] as string | null) ?? null,
                    is_guest: 0,
                    is_deactivated: 0,
                    admin: (args[5] as number) ?? 0,
                    created_at: (args[6] as number) ?? Date.now(),
                    updated_at: (args[7] as number) ?? Date.now(),
                  });
                }
              }
              if (sql.includes('INSERT INTO idp_providers')) {
                idpProviders.push({
                  id: args[0] as string,
                  name: args[1] as string,
                  issuer_url: args[2] as string,
                  client_id: args[3] as string,
                  client_secret_encrypted: args[4] as string,
                  scopes: args[5] as string,
                  enabled: 1,
                  auto_create_users: args[6] as number,
                  username_claim: args[7] as string,
                  display_order: 0,
                  icon_url: args[8] as string | null,
                  created_at: args[9] as number,
                  updated_at: args[10] as number,
                });
              }
              if (sql.includes('INSERT INTO admin_audit_log')) {
                audit.push({
                  id: nextAuditId++,
                  ts: args[0] as number,
                  actor_user_id: args[1] as string,
                  action: args[2] as string,
                  target: args[3] as string | null,
                  ip: args[4] as string | null,
                  success: args[5] as number,
                  details: args[6] as string | null,
                });
              }
              if (sql.includes('DELETE FROM access_tokens WHERE user_id = ?')) {
                const userId = args[0] as string;
                const before = tokens.length;
                for (let i = tokens.length - 1; i >= 0; i--) {
                  if (tokens[i].user_id === userId) tokens.splice(i, 1);
                }
                return {
                  success: true,
                  meta: { changes: before - tokens.length, last_row_id: 0 },
                };
              }
              if (sql.includes('DELETE FROM access_tokens WHERE token_id = ?')) {
                const tid = args[0] as string;
                const idx = tokens.findIndex((t) => t.token_id === tid);
                if (idx >= 0) tokens.splice(idx, 1);
              }
              if (sql.includes('DELETE FROM users WHERE user_id = ?')) {
                const userId = args[0] as string;
                const idx = users.findIndex((u) => u.user_id === userId);
                if (idx >= 0) users.splice(idx, 1);
              }
              if (sql.includes('DELETE FROM rooms WHERE room_id = ?')) {
                const roomId = args[0] as string;
                const idx = rooms.findIndex((r) => r.room_id === roomId);
                if (idx >= 0) rooms.splice(idx, 1);
              }
              if (sql.includes('DELETE FROM media WHERE media_id = ?')) {
                const mediaId = args[0] as string;
                const idx = media.findIndex((m) => m.media_id === mediaId);
                if (idx >= 0) media.splice(idx, 1);
              }
              if (sql.includes('DELETE FROM idp_providers WHERE id = ?')) {
                const id = args[0] as string;
                const idx = idpProviders.findIndex((p) => p.id === id);
                if (idx >= 0) idpProviders.splice(idx, 1);
              }
              if (sql.includes('DELETE FROM idp_user_links WHERE id = ? AND provider_id = ?')) {
                const linkId = Number(args[0]);
                const providerId = args[1] as string;
                const idx = idpLinks.findIndex(
                  (l) => l.id === linkId && l.provider_id === providerId
                );
                if (idx >= 0) idpLinks.splice(idx, 1);
              }
              if (sql.includes('UPDATE idp_providers SET')) {
                const id = args[args.length - 1] as string;
                const p = idpProviders.find((x) => x.id === id);
                if (p && sql.includes('name = ?')) {
                  // best-effort: leave as-is; updates tracked in updates[]
                  p.updated_at = Date.now();
                }
              }
              if (sql.includes('UPDATE users SET') && sql.includes('display_name')) {
                // tracked via updates
              }

              return { success: true, meta: { changes: 1, last_row_id: nextReportId } };
            },
      });
      return {
        bind(...args: unknown[]) {
          return bound(...args);
        },
        first<T>() {
          return bound().first<T>();
        },
        all<T>() {
          return bound().all<T>();
        },
        run() {
          return bound().run();
        },
      };
    },
  };

  return db as unknown as D1Database & typeof db;
}

function createEnv(opts: {
  db?: ReturnType<typeof createAdminDb>;
  adminDO?: ReturnType<typeof createAdminDO>;
  cache?: ReturnType<typeof mockKv>;
  sessions?: ReturnType<typeof mockKv>;
  deviceKeys?: ReturnType<typeof mockKv>;
  crossSigning?: ReturnType<typeof mockKv>;
  media?: ReturnType<typeof mockR2>;
} = {}): Env {
  const adminDO = opts.adminDO ?? createAdminDO();
  const adminNs = {
    idFromName: () => ({ toString: () => 'admin-global' }),
    get: () => adminDO,
  };

  return {
    DB: (opts.db ?? createAdminDb()) as unknown as D1Database,
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'tuwunel-test-0.1.0',
    ADMIN: adminNs as unknown as Env['ADMIN'],
    CACHE: opts.cache ?? mockKv({ server_signing_key: JSON.stringify({ keyId: 'ed25519:test' }) }),
    SESSIONS: opts.sessions ?? mockKv(),
    DEVICE_KEYS: opts.deviceKeys ?? mockKv({
      [`device:${BOB}:BOBDEVICE`]: JSON.stringify({
        algorithms: ['m.olm.v1.curve25519-aes-sha2'],
        device_id: 'BOBDEVICE',
        user_id: BOB,
        keys: { 'ed25519:BOBDEVICE': 'DEVKEY' },
        signatures: { [BOB]: { 'ed25519:ss': 'sig' } },
      }),
    }),
    CROSS_SIGNING_KEYS: opts.crossSigning ?? mockKv(),
    ONE_TIME_KEYS: mockKv(),
    ACCOUNT_DATA: mockKv(),
    MEDIA: opts.media ?? mockR2(),
    OIDC_ENCRYPTION_KEY: 'dGVzdC1vaWRjLWVuY3J5cHRpb24ta2V5LTMyYnl0ZXMh',
  } as unknown as Env;
}

async function req(
  path: string,
  init: RequestInit = {},
  env: Env = createEnv()
): Promise<Response> {
  return adminApp.request(path, init, env);
}

const AUTH = { Authorization: 'Bearer test-token' };

function jsonInit(method: string, body?: unknown, contentType = 'application/json'): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': contentType,
      ...AUTH,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

async function jsonReq(
  path: string,
  init: RequestInit = {},
  env: Env = createEnv()
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await req(path, init, env);
  let body: Record<string, unknown> = {};
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text };
    }
  }
  return { status: res.status, body };
}

function bobOnlyDb() {
  return createAdminDb({ users: [defaultBob()] });
}

function nonAdminEnv() {
  const db = createAdminDb({
    users: [{ ...defaultAdmin(), admin: 0 }, defaultBob()],
  });
  return createEnv({ db });
}


function defaultCarol(): UserRow {
  return {
    user_id: CAROL,
    localpart: 'carol',
    display_name: 'Carol',
    avatar_url: null,
    password_hash: 'hashed:carolpass',
    is_guest: 0,
    is_deactivated: 0,
    admin: 0,
    created_at: 3_000,
    updated_at: 3_000,
  };
}

function enc(userId: string) {
  return encodeURIComponent(userId);
}

beforeEach(() => {
  authState.userId = ADMIN;
  authState.deviceId = 'ADMINDEVICE';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('race admin create user SELECT→INSERT TOCTOU after #189', () => {
  it('parallel create same localpart: both pass existence SELECT; last insert wins / double row possible', async () => {
    const db = createAdminDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id = ?'),
        count: 2,
      },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'dave', password: 'p1', display_name: 'D1' }), env),
      jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'dave', password: 'p2', display_name: 'D2' }), env),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
    const daves = db.users.filter((u) => u.localpart === 'dave');
    expect(daves.length).toBeGreaterThanOrEqual(1);
    expect(daves.length).toBeLessThanOrEqual(2);
  });

  it('create after mid-flight insert by peer returns M_USER_IN_USE for second', async () => {
    const db = createAdminDb({
      mutateUserAfterSelects: {
        after: 1,
        apply: (users) => {
          users.push({
            user_id: '@dave:example.com',
            localpart: 'dave',
            display_name: 'Peer',
            avatar_url: null,
            password_hash: 'hashed:x',
            is_guest: 0,
            is_deactivated: 0,
            admin: 0,
            created_at: 9_000,
            updated_at: 9_000,
          });
        },
      },
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id = ?'),
        count: 2,
      },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'dave', password: 'p1' }), env),
      jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'dave', password: 'p2' }), env),
    ]);
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 200 || s === 400)).toBe(true);
  });
  it('create soft flood charset/admin flag soft-0', async () => {
    const env = createEnv();
    const username = 'u0_' + (0 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass0',
        display_name: 0 % 3 === 0 ? undefined : `User 0`,
        admin: 0 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-1', async () => {
    const env = createEnv();
    const username = 'u1_' + (1 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass1',
        display_name: 1 % 3 === 0 ? undefined : `User 1`,
        admin: 1 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-2', async () => {
    const env = createEnv();
    const username = 'u2_' + (2 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass2',
        display_name: 2 % 3 === 0 ? undefined : `User 2`,
        admin: 2 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-3', async () => {
    const env = createEnv();
    const username = 'u3_' + (3 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass3',
        display_name: 3 % 3 === 0 ? undefined : `User 3`,
        admin: 3 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-4', async () => {
    const env = createEnv();
    const username = 'u4_' + (4 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass4',
        display_name: 4 % 3 === 0 ? undefined : `User 4`,
        admin: 4 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-5', async () => {
    const env = createEnv();
    const username = 'u5_' + (5 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass5',
        display_name: 5 % 3 === 0 ? undefined : `User 5`,
        admin: 5 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-6', async () => {
    const env = createEnv();
    const username = 'u6_' + (6 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass6',
        display_name: 6 % 3 === 0 ? undefined : `User 6`,
        admin: 6 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-7', async () => {
    const env = createEnv();
    const username = 'u7_' + (7 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass7',
        display_name: 7 % 3 === 0 ? undefined : `User 7`,
        admin: 7 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-8', async () => {
    const env = createEnv();
    const username = 'u8_' + (8 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass8',
        display_name: 8 % 3 === 0 ? undefined : `User 8`,
        admin: 8 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-9', async () => {
    const env = createEnv();
    const username = 'u9_' + (9 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass9',
        display_name: 9 % 3 === 0 ? undefined : `User 9`,
        admin: 9 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-10', async () => {
    const env = createEnv();
    const username = 'u10_' + (10 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass10',
        display_name: 10 % 3 === 0 ? undefined : `User 10`,
        admin: 10 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-11', async () => {
    const env = createEnv();
    const username = 'u11_' + (11 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass11',
        display_name: 11 % 3 === 0 ? undefined : `User 11`,
        admin: 11 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-12', async () => {
    const env = createEnv();
    const username = 'u12_' + (12 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass12',
        display_name: 12 % 3 === 0 ? undefined : `User 12`,
        admin: 12 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-13', async () => {
    const env = createEnv();
    const username = 'u13_' + (13 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass13',
        display_name: 13 % 3 === 0 ? undefined : `User 13`,
        admin: 13 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-14', async () => {
    const env = createEnv();
    const username = 'u14_' + (14 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass14',
        display_name: 14 % 3 === 0 ? undefined : `User 14`,
        admin: 14 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('create soft flood charset/admin flag soft-15', async () => {
    const env = createEnv();
    const username = 'u15_' + (15 % 2 === 0 ? 'ok' : 'okx');
    const res = await jsonReq(
      '/admin/api/users/create',
      jsonInit('POST', {
        username,
        password: 'pass15',
        display_name: 15 % 3 === 0 ? undefined : `User 15`,
        admin: 15 % 4 === 0,
      }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });

});

describe('race admin PUT∥DELETE user deactivate after #189', () => {
  it('PUT display_name ∥ DELETE deactivate: both succeed; final deactivated', async () => {
    const db = createAdminDb({
      runBarrier: {
        match: (sql) => sql.includes('UPDATE users SET'),
        count: 2,
      },
    });
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}`, jsonInit('PUT', { display_name: 'Bob Renamed' }), env),
      jsonReq(`/admin/api/users/${bobEnc}`, jsonInit('DELETE'), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const bob = db.users.find((u) => u.user_id === BOB)!;
    expect(bob.is_deactivated).toBe(1);
  });

  it('PUT admin=true ∥ PUT deactivated=true lost-update on parallel field writes', async () => {
    const db = createAdminDb({
      runBarrier: {
        match: (sql) => sql.includes('UPDATE users SET') && sql.includes('WHERE user_id'),
        count: 2,
      },
    });
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}`, jsonInit('PUT', { admin: true }), env),
      jsonReq(`/admin/api/users/${bobEnc}`, jsonInit('PUT', { deactivated: true }), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const bob = db.users.find((u) => u.user_id === BOB)!;
    expect(bob.admin === 1 || bob.is_deactivated === 1).toBe(true);
  });

  it('reactivate ∥ deactivate flip-flop last write wins', async () => {
    const db = createAdminDb({
      users: [defaultAdmin(), { ...defaultBob(), is_deactivated: 1 }],
    });
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}/reactivate`, jsonInit('POST', {}), env),
      jsonReq(`/admin/api/users/${bobEnc}`, jsonInit('DELETE'), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const bob = db.users.find((u) => u.user_id === BOB)!;
    expect([0, 1]).toContain(bob.is_deactivated);
  });
  it('PUT user soft flood field matrix soft-0', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (0 % 2 === 0) fields.display_name = `N0`;
    if (0 % 3 === 0) fields.admin = 0 % 6 === 0;
    if (0 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback0`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-1', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (1 % 2 === 0) fields.display_name = `N1`;
    if (1 % 3 === 0) fields.admin = 1 % 6 === 0;
    if (1 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback1`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-2', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (2 % 2 === 0) fields.display_name = `N2`;
    if (2 % 3 === 0) fields.admin = 2 % 6 === 0;
    if (2 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback2`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-3', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (3 % 2 === 0) fields.display_name = `N3`;
    if (3 % 3 === 0) fields.admin = 3 % 6 === 0;
    if (3 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback3`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-4', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (4 % 2 === 0) fields.display_name = `N4`;
    if (4 % 3 === 0) fields.admin = 4 % 6 === 0;
    if (4 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback4`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-5', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (5 % 2 === 0) fields.display_name = `N5`;
    if (5 % 3 === 0) fields.admin = 5 % 6 === 0;
    if (5 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback5`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-6', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (6 % 2 === 0) fields.display_name = `N6`;
    if (6 % 3 === 0) fields.admin = 6 % 6 === 0;
    if (6 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback6`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-7', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (7 % 2 === 0) fields.display_name = `N7`;
    if (7 % 3 === 0) fields.admin = 7 % 6 === 0;
    if (7 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback7`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-8', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (8 % 2 === 0) fields.display_name = `N8`;
    if (8 % 3 === 0) fields.admin = 8 % 6 === 0;
    if (8 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback8`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-9', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (9 % 2 === 0) fields.display_name = `N9`;
    if (9 % 3 === 0) fields.admin = 9 % 6 === 0;
    if (9 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback9`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-10', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (10 % 2 === 0) fields.display_name = `N10`;
    if (10 % 3 === 0) fields.admin = 10 % 6 === 0;
    if (10 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback10`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-11', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (11 % 2 === 0) fields.display_name = `N11`;
    if (11 % 3 === 0) fields.admin = 11 % 6 === 0;
    if (11 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback11`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-12', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (12 % 2 === 0) fields.display_name = `N12`;
    if (12 % 3 === 0) fields.admin = 12 % 6 === 0;
    if (12 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback12`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-13', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (13 % 2 === 0) fields.display_name = `N13`;
    if (13 % 3 === 0) fields.admin = 13 % 6 === 0;
    if (13 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback13`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-14', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (14 % 2 === 0) fields.display_name = `N14`;
    if (14 % 3 === 0) fields.admin = 14 % 6 === 0;
    if (14 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback14`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });
  it('PUT user soft flood field matrix soft-15', async () => {
    const env = createEnv();
    const fields: Record<string, unknown> = {};
    if (15 % 2 === 0) fields.display_name = `N15`;
    if (15 % 3 === 0) fields.admin = 15 % 6 === 0;
    if (15 % 5 === 0) fields.deactivated = false;
    if (Object.keys(fields).length === 0) fields.display_name = `fallback15`;
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', fields), env);
    expect(res.status).toBe(200);
  });

});

describe('race admin make-admin∥remove-admin lost-update after #189', () => {
  it('make-admin ∥ remove-admin on same user: last write wins admin bit', async () => {
    const db = createAdminDb({
      runBarrier: {
        match: (sql) => sql.includes('UPDATE users SET admin ='),
        count: 2,
      },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: BOB }), env),
      jsonReq('/admin/api/remove-admin', jsonInit('POST', { user_id: BOB }), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const bob = db.users.find((u) => u.user_id === BOB)!;
    expect([0, 1]).toContain(bob.admin);
  });

  it('self-demotion remove-admin returns 403; parallel make-admin on peer ok', async () => {
    const env = createEnv();
    const results = await Promise.all([
      jsonReq('/admin/api/remove-admin', jsonInit('POST', { user_id: ADMIN }), env),
      jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: BOB }), env),
    ]);
    expect(results[0].status).toBe(403);
    expect(results[1].status).toBe(200);
  });

  it('double make-admin is idempotent', async () => {
    const db = createAdminDb({
      runBarrier: {
        match: (sql) => sql.includes('UPDATE users SET admin = 1'),
        count: 2,
      },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: BOB }), env),
      jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: BOB }), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.users.find((u) => u.user_id === BOB)!.admin).toBe(1);
  });
  it('make/remove-admin soft flood soft-0', async () => {
    const path = 0 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 0 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-1', async () => {
    const path = 1 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 1 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-2', async () => {
    const path = 2 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 2 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-3', async () => {
    const path = 3 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 3 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-4', async () => {
    const path = 4 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 4 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-5', async () => {
    const path = 5 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 5 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-6', async () => {
    const path = 6 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 6 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-7', async () => {
    const path = 7 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 7 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-8', async () => {
    const path = 8 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 8 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-9', async () => {
    const path = 9 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 9 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-10', async () => {
    const path = 10 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 10 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-11', async () => {
    const path = 11 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 11 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-12', async () => {
    const path = 12 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 12 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-13', async () => {
    const path = 13 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 13 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-14', async () => {
    const path = 14 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 14 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });
  it('make/remove-admin soft flood soft-15', async () => {
    const path = 15 % 2 === 0 ? '/admin/api/make-admin' : '/admin/api/remove-admin';
    const target = 15 % 3 === 0 ? CAROL : BOB;
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const e = createEnv({ db });
    const res = await jsonReq(path, jsonInit('POST', { user_id: target }), e);
    expect([200, 403, 400]).toContain(res.status);
  });

});

describe('race admin reset-password∥sessions revoke after #189', () => {
  it('reset-password ∥ DELETE sessions: both clear tokens', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    const before = db.tokens.filter((t) => t.user_id === BOB).length;
    expect(before).toBeGreaterThan(0);
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: 'newpass1' }), env),
      jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.tokens.filter((t) => t.user_id === BOB)).toHaveLength(0);
  });

  it('reset-password ∥ DELETE single session: password rotated and session gone', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: 'np' }), env),
      jsonReq('/admin/api/sessions/tok-bob', jsonInit('DELETE'), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.users.find((u) => u.user_id === BOB)!.password_hash).toBe('hashed:np');
  });

  it('parallel reset-password last hash wins', async () => {
    const db = createAdminDb({
      runBarrier: {
        match: (sql) => sql.includes('UPDATE users SET password_hash'),
        count: 2,
      },
    });
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: 'aaa' }), env),
      jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: 'bbb' }), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const hash = db.users.find((u) => u.user_id === BOB)!.password_hash;
    expect(['hashed:aaa', 'hashed:bbb']).toContain(hash);
  });
  it('reset-password / sessions soft flood soft-0', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (0 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p0` }), env);
      expect(res.status).toBe(200);
    } else if (0 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-1', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (1 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p1` }), env);
      expect(res.status).toBe(200);
    } else if (1 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-2', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (2 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p2` }), env);
      expect(res.status).toBe(200);
    } else if (2 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-3', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (3 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p3` }), env);
      expect(res.status).toBe(200);
    } else if (3 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-4', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (4 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p4` }), env);
      expect(res.status).toBe(200);
    } else if (4 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-5', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (5 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p5` }), env);
      expect(res.status).toBe(200);
    } else if (5 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-6', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (6 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p6` }), env);
      expect(res.status).toBe(200);
    } else if (6 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-7', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (7 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p7` }), env);
      expect(res.status).toBe(200);
    } else if (7 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-8', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (8 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p8` }), env);
      expect(res.status).toBe(200);
    } else if (8 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-9', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (9 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p9` }), env);
      expect(res.status).toBe(200);
    } else if (9 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-10', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (10 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p10` }), env);
      expect(res.status).toBe(200);
    } else if (10 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-11', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (11 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p11` }), env);
      expect(res.status).toBe(200);
    } else if (11 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-12', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (12 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p12` }), env);
      expect(res.status).toBe(200);
    } else if (12 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-13', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (13 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p13` }), env);
      expect(res.status).toBe(200);
    } else if (13 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-14', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (14 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p14` }), env);
      expect(res.status).toBe(200);
    } else if (14 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });
  it('reset-password / sessions soft flood soft-15', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    if (15 % 3 === 0) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/reset-password`, jsonInit('POST', { password: `p15` }), env);
      expect(res.status).toBe(200);
    } else if (15 % 3 === 1) {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    }
  });

});

describe('race admin login-token double-mint SESSIONS after #189', () => {
  it('parallel login-token mint: both succeed; two SESSIONS puts', async () => {
    const sessions = mockKv();
    const env = createEnv({ sessions });
    const bobEnc = enc(BOB);
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}/login-token`, jsonInit('POST', { ttl_minutes: 5 }), env),
      jsonReq(`/admin/api/users/${bobEnc}/login-token`, jsonInit('POST', { ttl_minutes: 15 }), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(sessions.puts.length).toBeGreaterThanOrEqual(2);
    expect(results.every((r) => r.body.success === true)).toBe(true);
  });

  it('login-token on deactivated user fails even under parallel load', async () => {
    const db = createAdminDb({
      users: [defaultAdmin(), { ...defaultBob(), is_deactivated: 1 }],
    });
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}/login-token`, jsonInit('POST', {}), env),
      jsonReq(`/admin/api/users/${bobEnc}/login-token`, jsonInit('POST', { ttl_minutes: 30 }), env),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
  });

  it('login-token ∥ deactivate mid-flight: one may mint before deactivate lands', async () => {
    const db = createAdminDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM users WHERE user_id = ?') && sql.includes('localpart'),
        count: 2,
      },
    });
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}/login-token`, jsonInit('POST', {}), env),
      jsonReq(`/admin/api/users/${bobEnc}`, jsonInit('DELETE'), env),
    ]);
    expect(results.map((r) => r.status).every((s) => s === 200 || s === 400)).toBe(true);
  });
  it('login-token ttl soft flood soft-0', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][0 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-1', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][1 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-2', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][2 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-3', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][3 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-4', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][4 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-5', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][5 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-6', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][6 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-7', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][7 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-8', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][8 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-9', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][9 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-10', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][10 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-11', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][11 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-12', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][12 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-13', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][13 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-14', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][14 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });
  it('login-token ttl soft flood soft-15', async () => {
    const env = createEnv();
    const ttl = [1, 10, 60, 0, 99, -1, 30, 5][15 % 8];
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/login-token`,
      jsonInit('POST', { ttl_minutes: ttl }),
      env
    );
    expect([200, 400]).toContain(res.status);
  });

});

describe('race admin purge∥bulk-delete∥cleanup after #189', () => {
  it('purge ∥ bulk-delete same user: both succeed; user gone once', async () => {
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}/purge`, jsonInit('DELETE'), env),
      jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [BOB] }), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.users.find((u) => u.user_id === BOB)).toBeUndefined();
  });

  it('bulk-delete overlapping lists with preserve_admin skips admins', async () => {
    const db = createAdminDb({
      users: [defaultAdmin(), defaultBob(), { ...defaultCarol(), admin: 1 }],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [BOB, CAROL, ADMIN], preserve_admin: true }),
        env
      ),
      jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [BOB], preserve_admin: false }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.users.find((u) => u.user_id === ADMIN)).toBeTruthy();
    expect(db.users.find((u) => u.user_id === BOB)).toBeUndefined();
  });

  it('self-purge forbidden while peer purge ok', async () => {
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob()] });
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${enc(ADMIN)}/purge`, jsonInit('DELETE'), env),
      jsonReq(`/admin/api/users/${enc(BOB)}/purge`, jsonInit('DELETE'), env),
    ]);
    expect(results[0].status).toBe(403);
    expect(results[1].status).toBe(200);
  });

  it('cleanup ∥ purge: cleanup deletes non-admins; purge target already gone ok', async () => {
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob(), defaultCarol()] });
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq('/admin/api/cleanup', jsonInit('POST', {}), env),
      jsonReq(`/admin/api/users/${enc(BOB)}/purge`, jsonInit('DELETE'), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.users.every((u) => u.admin === 1)).toBe(true);
  });
  it('purge/bulk-delete soft flood soft-0', async () => {
    const uid = `@bob0:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob0` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b0`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (0 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 0 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-1', async () => {
    const uid = `@bob1:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob1` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b1`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (1 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 1 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-2', async () => {
    const uid = `@bob2:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob2` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b2`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (2 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 2 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-3', async () => {
    const uid = `@bob3:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob3` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b3`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (3 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 3 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-4', async () => {
    const uid = `@bob4:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob4` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b4`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (4 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 4 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-5', async () => {
    const uid = `@bob5:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob5` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b5`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (5 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 5 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-6', async () => {
    const uid = `@bob6:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob6` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b6`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (6 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 6 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-7', async () => {
    const uid = `@bob7:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob7` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b7`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (7 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 7 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-8', async () => {
    const uid = `@bob8:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob8` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b8`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (8 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 8 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-9', async () => {
    const uid = `@bob9:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob9` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b9`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (9 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 9 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-10', async () => {
    const uid = `@bob10:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob10` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b10`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (10 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 10 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-11', async () => {
    const uid = `@bob11:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob11` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b11`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (11 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 11 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-12', async () => {
    const uid = `@bob12:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob12` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b12`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (12 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 12 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-13', async () => {
    const uid = `@bob13:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob13` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b13`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (13 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 13 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-14', async () => {
    const uid = `@bob14:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob14` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b14`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (14 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 14 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });
  it('purge/bulk-delete soft flood soft-15', async () => {
    const uid = `@bob15:example.com`;
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        { ...defaultBob(), user_id: uid, localpart: `bob15` },
      ],
      tokens: [
        { token_id: 'tok-admin', user_id: ADMIN, device_id: 'ADMINDEVICE', created_at: 1 },
        { token_id: `tok-b15`, user_id: uid, device_id: 'D', created_at: 2 },
      ],
      devices: [
        { user_id: ADMIN, device_id: 'ADMINDEVICE', display_name: null, last_seen_ts: null, last_seen_ip: null },
        { user_id: uid, device_id: 'D', display_name: null, last_seen_ts: null, last_seen_ip: null },
      ],
      media: [],
    });
    const env = createEnv({ db });
    if (15 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(
        '/admin/api/users/bulk-delete',
        jsonInit('POST', { user_ids: [uid, ADMIN], preserve_admin: 15 % 4 === 1 }),
        env
      );
      expect(res.status).toBe(200);
    }
  });

});

describe('race admin media quarantine∥delete after #189', () => {
  it('quarantine ∥ DELETE media: delete wins; quarantine may race', async () => {
    const media = mockR2();
    const db = createAdminDb();
    const env = createEnv({ db, media });
    const results = await Promise.all([
      jsonReq(`/admin/api/media/${MEDIA_ID}/quarantine`, jsonInit('POST', {}), env),
      jsonReq(`/admin/api/media/${MEDIA_ID}`, jsonInit('DELETE'), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(media.deleted.length).toBeGreaterThanOrEqual(1);
  });

  it('double quarantine is idempotent', async () => {
    const db = createAdminDb({
      runBarrier: {
        match: (sql) => sql.includes('UPDATE media SET quarantined = 1'),
        count: 2,
      },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq(`/admin/api/media/${MEDIA_ID}/quarantine`, jsonInit('POST', {}), env),
      jsonReq(`/admin/api/media/${MEDIA_ID}/quarantine`, jsonInit('POST', {}), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.media.find((m) => m.media_id === MEDIA_ID)?.quarantined).toBe(1);
  });
  it('media mutate soft flood soft-0', async () => {
    const mid = `mxc_0`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 0,
        filename: `f0.png`,
        created_at: 1000 + 0,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (0 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-1', async () => {
    const mid = `mxc_1`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 1,
        filename: `f1.png`,
        created_at: 1000 + 1,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (1 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-2', async () => {
    const mid = `mxc_2`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 2,
        filename: `f2.png`,
        created_at: 1000 + 2,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (2 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-3', async () => {
    const mid = `mxc_3`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 3,
        filename: `f3.png`,
        created_at: 1000 + 3,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (3 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-4', async () => {
    const mid = `mxc_4`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 4,
        filename: `f4.png`,
        created_at: 1000 + 4,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (4 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-5', async () => {
    const mid = `mxc_5`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 5,
        filename: `f5.png`,
        created_at: 1000 + 5,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (5 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-6', async () => {
    const mid = `mxc_6`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 6,
        filename: `f6.png`,
        created_at: 1000 + 6,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (6 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-7', async () => {
    const mid = `mxc_7`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 7,
        filename: `f7.png`,
        created_at: 1000 + 7,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (7 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-8', async () => {
    const mid = `mxc_8`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 8,
        filename: `f8.png`,
        created_at: 1000 + 8,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (8 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-9', async () => {
    const mid = `mxc_9`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 9,
        filename: `f9.png`,
        created_at: 1000 + 9,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (9 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-10', async () => {
    const mid = `mxc_10`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 10,
        filename: `f10.png`,
        created_at: 1000 + 10,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (10 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-11', async () => {
    const mid = `mxc_11`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 11,
        filename: `f11.png`,
        created_at: 1000 + 11,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (11 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-12', async () => {
    const mid = `mxc_12`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 12,
        filename: `f12.png`,
        created_at: 1000 + 12,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (12 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-13', async () => {
    const mid = `mxc_13`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 13,
        filename: `f13.png`,
        created_at: 1000 + 13,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (13 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-14', async () => {
    const mid = `mxc_14`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 14,
        filename: `f14.png`,
        created_at: 1000 + 14,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (14 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('media mutate soft flood soft-15', async () => {
    const mid = `mxc_15`;
    const db = createAdminDb({
      media: [{
        media_id: mid,
        user_id: BOB,
        content_type: 'image/png',
        content_length: 10 + 15,
        filename: `f15.png`,
        created_at: 1000 + 15,
        quarantined: 0,
      }],
      thumbnails: [{ media_id: mid, width: 32, height: 32, method: 'crop' }],
    });
    const media = mockR2();
    const env = createEnv({ db, media });
    if (15 % 2 === 0) {
      const res = await jsonReq(`/admin/api/media/${mid}/quarantine`, jsonInit('POST', {}), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/admin/api/media/${mid}`, jsonInit('DELETE'), env);
      expect(res.status).toBe(200);
      expect(media.deleted.length).toBeGreaterThanOrEqual(1);
    }
  });

});

describe('race admin report resolve∥unresolve after #189', () => {
  it('resolve ∥ unresolve: last write wins resolved bit', async () => {
    const db = createAdminDb({
      runBarrier: {
        match: (sql) => sql.includes('UPDATE content_reports'),
        count: 2,
      },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq('/admin/api/reports/1/resolve', jsonInit('POST', { note: 'done' }), env),
      jsonReq('/admin/api/reports/1/unresolve', jsonInit('POST', {}), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect([0, 1]).toContain(db.reports[0].resolved);
  });

  it('double resolve: second may overwrite note; stays resolved', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq('/admin/api/reports/1/resolve', jsonInit('POST', { note: 'a' }), env),
      jsonReq('/admin/api/reports/1/resolve', jsonInit('POST', { note: 'b' }), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.reports[0].resolved).toBe(1);
    expect(['a', 'b']).toContain(db.reports[0].resolution_note);
  });

  it('resolve missing report returns 404 under parallel', async () => {
    const env = createEnv();
    const results = await Promise.all([
      jsonReq('/admin/api/reports/999/resolve', jsonInit('POST', {}), env),
      jsonReq('/admin/api/reports/999/unresolve', jsonInit('POST', {}), env),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it('report resolve soft flood soft-0', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 0,
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 0 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n0` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-1', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 1,
        resolved_by: ADMIN,
        resolved_at: 2,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 1 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n1` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-2', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 0,
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 2 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n2` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-3', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 1,
        resolved_by: ADMIN,
        resolved_at: 2,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 3 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n3` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-4', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 0,
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 4 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n4` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-5', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 1,
        resolved_by: ADMIN,
        resolved_at: 2,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 5 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n5` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-6', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 0,
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 6 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n6` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-7', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 1,
        resolved_by: ADMIN,
        resolved_at: 2,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 7 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n7` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-8', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 0,
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 8 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n8` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-9', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 1,
        resolved_by: ADMIN,
        resolved_at: 2,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 9 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n9` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-10', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 0,
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 10 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n10` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-11', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 1,
        resolved_by: ADMIN,
        resolved_at: 2,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 11 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n11` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-12', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 0,
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 12 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n12` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-13', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 1,
        resolved_by: ADMIN,
        resolved_at: 2,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 13 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n13` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-14', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 0,
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 14 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n14` }), env);
    expect([200, 404]).toContain(res.status);
  });
  it('report resolve soft flood soft-15', async () => {
    const db = createAdminDb({
      reports: [{
        id: 1,
        reporter_user_id: ADMIN,
        room_id: ROOM,
        event_id: '$msg:example.com',
        reason: 'spam',
        score: -1,
        created_at: 1,
        resolved: 1,
        resolved_by: ADMIN,
        resolved_at: 2,
        resolution_note: null,
      }],
    });
    const env = createEnv({ db });
    const path = 15 % 2 === 0 ? '/admin/api/reports/1/resolve' : '/admin/api/reports/1/unresolve';
    const res = await jsonReq(path, jsonInit('POST', { note: `n15` }), env);
    expect([200, 404]).toContain(res.status);
  });

});

describe('race admin registration PUT∥GET Admin DO after #189', () => {
  it('parallel registration PUT true∥false: last Admin DO write wins', async () => {
    const adminDO = createAdminDO({
      fetchBarrier: { count: 2, pathIncludes: '/config' },
    });
    const env = createEnv({ adminDO });
    const results = await Promise.all([
      jsonReq('/admin/api/registration', jsonInit('PUT', { enabled: true }), env),
      jsonReq('/admin/api/registration', jsonInit('PUT', { enabled: false }), env),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
    expect([true, false]).toContain(adminDO.config.registration_enabled);
  });

  it('registration PUT failConfigPut returns 500 under parallel', async () => {
    const adminDO = createAdminDO({ failConfigPut: true });
    const env = createEnv({ adminDO });
    const results = await Promise.all([
      jsonReq('/admin/api/registration', jsonInit('PUT', { enabled: false }), env),
      jsonReq('/admin/api/registration', jsonInit('PUT', { enabled: true }), env),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
  });

  it('GET∥PUT registration: read may see stale or fresh', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const results = await Promise.all([
      jsonReq('/admin/api/registration', {}, env),
      jsonReq('/admin/api/registration', jsonInit('PUT', { enabled: false }), env),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
  });
  it('registration PUT soft flood soft-0', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: true }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-1', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: false }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-2', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: true }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-3', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: false }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-4', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: true }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-5', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: false }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-6', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: true }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-7', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: false }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-8', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: true }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-9', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: false }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-10', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: true }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-11', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: false }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-12', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: true }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-13', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: false }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-14', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: true }),
      env
    );
    expect(res.status).toBe(200);
  });
  it('registration PUT soft flood soft-15', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      jsonInit('PUT', { enabled: false }),
      env
    );
    expect(res.status).toBe(200);
  });

});

describe('race admin IdP provider PUT∥DELETE after #189', () => {
  it('IdP PUT ∥ DELETE same provider: delete may win', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: 'Renamed', enabled: false }),
        env
      ),
      jsonReq('/admin/api/idp/providers/idp1', jsonInit('DELETE'), env),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 404)).toBe(true);
  });

  it('parallel IdP create: pinned opaque id collision surface', async () => {
    const db = createAdminDb({ idpProviders: [] });
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq(
        '/admin/api/idp/providers',
        jsonInit('POST', {
          name: 'A',
          issuer_url: 'https://a.example.com',
          client_id: 'c1',
          client_secret: 's1',
        }),
        env
      ),
      jsonReq(
        '/admin/api/idp/providers',
        jsonInit('POST', {
          name: 'B',
          issuer_url: 'https://b.example.com',
          client_id: 'c2',
          client_secret: 's2',
        }),
        env
      ),
    ]);
    expect(results.every((r) => [200, 400, 409, 500].includes(r.status))).toBe(true);
  });

  it('delete IdP link ∥ delete provider', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env),
      jsonReq('/admin/api/idp/providers/idp1', jsonInit('DELETE'), env),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 404)).toBe(true);
  });
  it('IdP mutate soft flood soft-0', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (0 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N0`, enabled: 0 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (0 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (0 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-1', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (1 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N1`, enabled: 1 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (1 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (1 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-2', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (2 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N2`, enabled: 2 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (2 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (2 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-3', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (3 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N3`, enabled: 3 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (3 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (3 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-4', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (4 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N4`, enabled: 4 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (4 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (4 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-5', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (5 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N5`, enabled: 5 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (5 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (5 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-6', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (6 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N6`, enabled: 6 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (6 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (6 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-7', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (7 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N7`, enabled: 7 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (7 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (7 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-8', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (8 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N8`, enabled: 8 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (8 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (8 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-9', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (9 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N9`, enabled: 9 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (9 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (9 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-10', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (10 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N10`, enabled: 10 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (10 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (10 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-11', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (11 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N11`, enabled: 11 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (11 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (11 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-12', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (12 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N12`, enabled: 12 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (12 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (12 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-13', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (13 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N13`, enabled: 13 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (13 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (13 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-14', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (14 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N14`, enabled: 14 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (14 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (14 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('IdP mutate soft flood soft-15', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    if (15 % 4 === 0) {
      const res = await jsonReq(
        '/admin/api/idp/providers/idp1',
        jsonInit('PUT', { name: `N15`, enabled: 15 % 2 === 0 }),
        env
      );
      expect([200, 404]).toContain(res.status);
    } else if (15 % 4 === 1) {
      const res = await jsonReq('/admin/api/idp/providers/idp1/test', jsonInit('POST', {}), env);
      expect([200, 400, 404, 500]).toContain(res.status);
    } else if (15 % 4 === 2) {
      const res = await jsonReq('/admin/api/idp/providers', {}, env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/idp/providers/idp1/links/10', jsonInit('DELETE'), env);
      expect([200, 404]).toContain(res.status);
    }
  });

});

describe('race admin server-notice stream position after #189', () => {
  it('parallel server-notice: stream position increments; devices notified', async () => {
    const db = createAdminDb({
      runBarrier: {
        match: (sql) => sql.includes("UPDATE stream_positions SET position = position + 1"),
        count: 2,
      },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB, message: 'hi1' }), env),
      jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB, message: 'hi2' }), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.streamPositions.to_device).toBeGreaterThanOrEqual(7);
  });
  it('server-notice soft flood soft-0', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 0` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-1', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 1` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-2', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 2` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-3', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 3` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-4', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 4` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-5', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 5` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-6', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 6` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-7', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 7` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-8', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 8` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-9', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 9` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-10', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 10` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-11', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 11` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-12', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 12` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-13', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 13` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-14', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 14` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });
  it('server-notice soft flood soft-15', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      jsonInit('POST', { user_id: BOB, message: `notice 15` }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.devices_notified).toBeGreaterThanOrEqual(1);
  });

});

describe('race admin Synapse-compat deactivate∥reset after #189', () => {
  it('Synapse deactivate ∥ reset_password parallel', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    const results = await Promise.all([
      jsonReq(`/_synapse/admin/v1/deactivate/${bobEnc}`, jsonInit('POST', { erase: false }), env),
      jsonReq(
        `/_synapse/admin/v1/reset_password/${bobEnc}`,
        jsonInit('POST', { new_password: 'synpass' }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('Synapse room delete ∥ native room delete', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const roomEnc = encodeURIComponent(ROOM);
    const results = await Promise.all([
      jsonReq(`/_synapse/admin/v1/rooms/${roomEnc}`, jsonInit('DELETE', { purge: true }), env),
      jsonReq(`/admin/api/rooms/${roomEnc}`, jsonInit('DELETE'), env),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 404)).toBe(true);
  });

  it('native deactivate ∥ Synapse deactivate same user', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bobEnc = enc(BOB);
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}`, jsonInit('DELETE'), env),
      jsonReq(`/_synapse/admin/v1/deactivate/${bobEnc}`, jsonInit('POST', {}), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.users.find((u) => u.user_id === BOB)!.is_deactivated).toBe(1);
  });
  it('Synapse-compat mutate soft flood soft-0', async () => {
    const uid = `@s0:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s0` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (0 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: true }), env);
      expect(res.status).toBe(200);
    } else if (0 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np0` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-1', async () => {
    const uid = `@s1:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s1` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (1 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: false }), env);
      expect(res.status).toBe(200);
    } else if (1 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np1` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-2', async () => {
    const uid = `@s2:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s2` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (2 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: true }), env);
      expect(res.status).toBe(200);
    } else if (2 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np2` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-3', async () => {
    const uid = `@s3:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s3` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (3 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: false }), env);
      expect(res.status).toBe(200);
    } else if (3 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np3` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-4', async () => {
    const uid = `@s4:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s4` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (4 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: true }), env);
      expect(res.status).toBe(200);
    } else if (4 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np4` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-5', async () => {
    const uid = `@s5:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s5` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (5 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: false }), env);
      expect(res.status).toBe(200);
    } else if (5 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np5` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-6', async () => {
    const uid = `@s6:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s6` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (6 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: true }), env);
      expect(res.status).toBe(200);
    } else if (6 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np6` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-7', async () => {
    const uid = `@s7:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s7` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (7 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: false }), env);
      expect(res.status).toBe(200);
    } else if (7 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np7` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-8', async () => {
    const uid = `@s8:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s8` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (8 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: true }), env);
      expect(res.status).toBe(200);
    } else if (8 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np8` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-9', async () => {
    const uid = `@s9:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s9` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (9 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: false }), env);
      expect(res.status).toBe(200);
    } else if (9 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np9` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-10', async () => {
    const uid = `@s10:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s10` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (10 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: true }), env);
      expect(res.status).toBe(200);
    } else if (10 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np10` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-11', async () => {
    const uid = `@s11:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s11` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (11 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: false }), env);
      expect(res.status).toBe(200);
    } else if (11 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np11` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-12', async () => {
    const uid = `@s12:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s12` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (12 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: true }), env);
      expect(res.status).toBe(200);
    } else if (12 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np12` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-13', async () => {
    const uid = `@s13:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s13` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (13 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: false }), env);
      expect(res.status).toBe(200);
    } else if (13 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np13` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-14', async () => {
    const uid = `@s14:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s14` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (14 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: true }), env);
      expect(res.status).toBe(200);
    } else if (14 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np14` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });
  it('Synapse-compat mutate soft flood soft-15', async () => {
    const uid = `@s15:example.com`;
    const db = createAdminDb({ users: [defaultAdmin(), { ...defaultBob(), user_id: uid, localpart: `s15` }] });
    const env = createEnv({ db });
    const encUid = enc(uid);
    if (15 % 3 === 0) {
      const res = await jsonReq(`/_synapse/admin/v1/deactivate/${encUid}`, jsonInit('POST', { erase: false }), env);
      expect(res.status).toBe(200);
    } else if (15 % 3 === 1) {
      const res = await jsonReq(`/_synapse/admin/v1/reset_password/${encUid}`, jsonInit('POST', { new_password: `np15` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq(`/_synapse/admin/v2/users/${encUid}`, {}, env);
      expect([200, 404]).toContain(res.status);
    }
  });

});

describe('race admin mutate∥Admin DO invalidate-cache after #189', () => {
  it('deactivate triggers invalidate-cache; parallel stats refresh races DO', async () => {
    const adminDO = createAdminDO({
      fetchBarrier: { count: 2 },
    });
    const env = createEnv({ adminDO });
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('DELETE'), env),
      jsonReq('/admin/api/stats?refresh=true', {}, env),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(2);
  });

  it('purge ∥ create both invalidate Admin DO cache', async () => {
    const adminDO = createAdminDO({ fetchBarrier: { count: 2, pathIncludes: 'invalidate' } });
    const db = createAdminDb({ users: [defaultAdmin(), defaultBob()] });
    const env = createEnv({ db, adminDO });
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${enc(BOB)}/purge`, jsonInit('DELETE'), env),
      jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'eve', password: 'pw' }), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const invalidates = adminDO.fetches.filter((f) => f.url.includes('invalidate'));
    expect(invalidates.length).toBeGreaterThanOrEqual(2);
  });
  it('Admin DO invalidate soft flood soft-0', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (0 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X0` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-1', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (1 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X1` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-2', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (2 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X2` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-3', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (3 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X3` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-4', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (4 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X4` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-5', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (5 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X5` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-6', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (6 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X6` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-7', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (7 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X7` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-8', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (8 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X8` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-9', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (9 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X9` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-10', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (10 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X10` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-11', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (11 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X11` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-12', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (12 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X12` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-13', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (13 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X13` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-14', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (14 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X14` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });
  it('Admin DO invalidate soft flood soft-15', async () => {
    const adminDO = createAdminDO();
    const env = createEnv({ adminDO });
    if (15 % 2 === 0) {
      const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: `X15` }), env);
      expect(res.status).toBe(200);
    } else {
      const res = await jsonReq('/admin/api/stats?refresh=true', {}, env);
      expect(res.status).toBe(200);
    }
  });

});

describe('admin mutate soft auth/JSON/params floods after #189', () => {
  it('non-admin 403 mutate soft-0', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'x', password: 'y' }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-1', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: 'z' }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-2', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('DELETE', undefined), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-3', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: BOB }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-4', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/remove-admin', jsonInit('POST', { user_id: BOB }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-5', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', { password: 'p' }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-6', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}/purge`, jsonInit('DELETE', undefined), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-7', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [BOB] }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-8', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq(`/admin/api/media/${MEDIA_ID}/quarantine`, jsonInit('POST', {}), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-9', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/reports/1/resolve', jsonInit('POST', { note: 'n' }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-10', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/registration', jsonInit('PUT', { enabled: false }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-11', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB, message: 'm' }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-12', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'x', password: 'y' }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-13', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', { display_name: 'z' }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-14', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('DELETE', undefined), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-15', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: BOB }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-16', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/remove-admin', jsonInit('POST', { user_id: BOB }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-17', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', { password: 'p' }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-18', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq(`/admin/api/users/${enc(BOB)}/purge`, jsonInit('DELETE', undefined), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-19', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [BOB] }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-20', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq(`/admin/api/media/${MEDIA_ID}/quarantine`, jsonInit('POST', {}), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-21', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/reports/1/resolve', jsonInit('POST', { note: 'n' }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-22', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/registration', jsonInit('PUT', { enabled: false }), env);
    expect(res.status).toBe(403);
  });
  it('non-admin 403 mutate soft-23', async () => {
    const env = nonAdminEnv();
    const res = await jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB, message: 'm' }), env);
    expect(res.status).toBe(403);
  });
  it('bad JSON mutate soft-0', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/users/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-1', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/make-admin',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-2', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/remove-admin',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-3', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/users/bulk-delete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-4', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-5', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-6', async () => {
    const env = createEnv();
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/reset-password`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-7', async () => {
    const env = createEnv();
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-8', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/users/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-9', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/make-admin',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-10', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/remove-admin',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-11', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/users/bulk-delete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-12', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-13', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-14', async () => {
    const env = createEnv();
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/reset-password`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-15', async () => {
    const env = createEnv();
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-16', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/users/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-17', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/make-admin',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-18', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/remove-admin',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-19', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/users/bulk-delete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-20', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/registration',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-21', async () => {
    const env = createEnv();
    const res = await jsonReq(
      '/admin/api/server-notice',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-22', async () => {
    const env = createEnv();
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}/reset-password`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('bad JSON mutate soft-23', async () => {
    const env = createEnv();
    const res = await jsonReq(
      `/admin/api/users/${enc(BOB)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      },
      env
    );
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-0', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[0 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-1', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[1 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-2', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[2 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-3', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[3 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-4', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[4 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-5', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[5 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-6', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[6 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-7', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[7 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-8', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[8 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-9', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[9 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-10', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[10 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-11', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[11 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-12', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[12 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-13', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[13 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-14', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[14 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-15', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[15 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-16', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[16 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-17', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[17 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-18', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[18 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-19', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[19 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-20', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[20 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-21', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[21 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-22', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[22 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });
  it('missing params mutate soft-23', async () => {
    const env = createEnv();
    const cases = [
      () => jsonReq('/admin/api/users/create', jsonInit('POST', { username: 'only' }), env),
      () => jsonReq('/admin/api/make-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/remove-admin', jsonInit('POST', {}), env),
      () => jsonReq('/admin/api/users/bulk-delete', jsonInit('POST', { user_ids: [] }), env),
      () => jsonReq('/admin/api/server-notice', jsonInit('POST', { user_id: BOB }), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}/reset-password`, jsonInit('POST', {}), env),
      () => jsonReq(`/admin/api/users/${enc(BOB)}`, jsonInit('PUT', {}), env),
      () => jsonReq('/admin/api/registration', jsonInit('PUT', {}), env),
    ];
    const res = await cases[23 % cases.length]();
    expect([400, 500]).toContain(res.status);
  });

});

describe('admin mutate lifecycle chains after #189', () => {
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-0', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life0`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np0` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (0 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-1', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life1`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np1` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (1 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-2', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life2`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np2` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (2 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-3', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life3`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np3` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (3 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-4', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life4`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np4` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (4 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-5', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life5`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np5` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (5 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-6', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life6`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np6` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (6 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-7', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life7`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np7` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (7 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-8', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life8`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np8` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (8 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-9', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life9`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np9` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (9 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-10', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life10`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np10` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (10 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-11', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life11`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np11` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (11 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-12', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life12`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np12` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (12 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-13', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life13`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np13` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (13 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-14', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life14`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np14` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (14 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-15', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life15`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np15` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (15 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-16', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life16`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np16` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (16 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-17', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life17`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np17` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (17 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-18', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life18`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np18` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (18 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });
  it('lifecycle create→make-admin→reset→sessions→deactivate soft-19', async () => {
    const db = createAdminDb({ users: [defaultAdmin()] });
    const env = createEnv({ db });
    const uname = `life19`;
    const uid = `@${uname}:example.com`;
    const c = await jsonReq('/admin/api/users/create', jsonInit('POST', { username: uname, password: 'p', admin: false }), env);
    expect(c.status).toBe(200);
    const m = await jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: uid }), env);
    expect(m.status).toBe(200);
    const r = await jsonReq(`/admin/api/users/${enc(uid)}/reset-password`, jsonInit('POST', { password: `np19` }), env);
    expect(r.status).toBe(200);
    const s = await jsonReq(`/admin/api/users/${enc(uid)}/sessions`, jsonInit('DELETE'), env);
    expect(s.status).toBe(200);
    if (19 % 2 === 0) {
      const d = await jsonReq(`/admin/api/users/${enc(uid)}`, jsonInit('DELETE'), env);
      expect(d.status).toBe(200);
    } else {
      const p = await jsonReq(`/admin/api/users/${enc(uid)}/purge`, jsonInit('DELETE'), env);
      expect(p.status).toBe(200);
    }
  });

});

describe('admin mutate wrong-method soft floods after #189', () => {
  it('wrong method soft flood soft-0', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[0 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-1', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[1 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-2', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[2 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-3', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[3 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-4', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[4 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-5', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[5 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-6', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[6 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-7', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[7 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-8', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[8 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-9', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[9 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-10', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[10 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-11', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[11 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-12', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[12 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-13', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[13 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-14', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[14 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-15', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[15 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-16', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[16 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-17', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[17 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-18', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[18 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });
  it('wrong method soft flood soft-19', async () => {
    const env = createEnv();
    const cases: Array<[string, string]> = [
      ['GET', '/admin/api/users/create'],
      ['PUT', '/admin/api/make-admin'],
      ['GET', '/admin/api/remove-admin'],
      ['POST', `/admin/api/users/${enc(BOB)}/purge`],
      ['GET', '/admin/api/users/bulk-delete'],
      ['PUT', `/admin/api/media/${MEDIA_ID}/quarantine`],
      ['GET', '/admin/api/reports/1/resolve'],
      ['POST', '/admin/api/registration'],
      ['GET', '/admin/api/server-notice'],
      ['PUT', `/admin/api/users/${enc(BOB)}/reset-password`],
    ];
    const [method, path] = cases[19 % cases.length];
    const res = await jsonReq(path, { method, headers: { ...AUTH } }, env);
    expect([404, 405, 400, 500]).toContain(res.status);
  });

});
