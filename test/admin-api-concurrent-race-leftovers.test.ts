/**
 * TOKENMAXX HEAVY leftovers after #214 / deepen after #232 / residual after #241
 * — admin *GET concurrent race / TOCTOU* for leftover admin-api routes that
 * only had serial soft floods (#157 leftover) or mutate races (#189). Distinct
 * from admin-mutate-concurrent-race-leftovers (writes) and
 * admin-api-route-leftovers (serial GET floods).
 *
 * Distinct from tip #241 (devices+keybackups residual) and #239 (this file's
 * prior deepen). Residual after #241: sessions list∥revoke; login-token∥sessions;
 * quarantine∥media list; reactivate∥user detail; make-admin∥whois;
 * analytics∥destinations isolation — soft-flooded in route leftovers but not
 * raced under Promise.all after #239.
 *
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

type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

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

type KvBarrier = { match: (key: string) => boolean; count: number };

async function withKvBarrier(
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


const ADMIN = '@admin:example.com';
const BOB = '@bob:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const MEDIA_ID = 'mxc_media_abc';

type SqlCall = { sql: string; args: unknown[] };

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

function mockKv(
  data: Record<string, string> = {},
  opts: {
    getBarrier?: KvBarrier;
    mutateAfterGets?: { after: number; next: Record<string, string> };
  } = {}
) {
  const puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
  const deletes: string[] = [];
  let getBarrier = opts.getBarrier;
  const getWaiters = { list: [] as Array<() => void> };
  let getCount = 0;
  const kv = {
    data,
    puts,
    deletes,
    get: async (key: string, type?: string) => {
      await withKvBarrier(
        getBarrier,
        getWaiters,
        () => {
          getBarrier = undefined;
        },
        key
      );
      getCount += 1;
      const raw = data[key];
      if (opts.mutateAfterGets && getCount === opts.mutateAfterGets.after) {
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, opts.mutateAfterGets.next);
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
} = {}) {
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];
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

      if (url.pathname === '/stats') {
        return Response.json(stats);
      }
      if (url.pathname === '/invalidate-cache') {
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
  const selectWaiters = { list: [] as Array<() => void> };

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
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
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

function nonAdminEnv() {
  const db = createAdminDb({
    users: [{ ...defaultAdmin(), admin: 0 }, defaultBob()],
  });
  return createEnv({ db });
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


function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function mockFederationSelfTestFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/.well-known/matrix/server')) {
      return Response.json({ 'm.server': `${SERVER}:443` });
    }
    if (url.includes('/_matrix/key/v2/server')) {
      return Response.json({ verify_keys: { 'ed25519:test': { key: 'AAAA' } } });
    }
    if (url.includes('/_matrix/federation/v1/version')) {
      return Response.json({ server: { name: 'matrix-worker', version: 'tuwunel-test-0.1.0' } });
    }
    if (url.includes('/.well-known/matrix/client')) {
      return Response.json({ 'm.homeserver': { base_url: `https://${SERVER}` } });
    }
    return new Response('missing', { status: 404 });
  });
}

describe('race admin GET stats∥stats Admin DO after #214', () => {
  it('dual GET stats same Admin DO snapshot', async () => {
    const adminDO = createAdminDO({ stats: { users: 42, rooms: 7, events: 99 } });
    const env = createEnv({ adminDO });
    const results = await Promise.all([
      jsonReq('/admin/api/stats', {}, env),
      jsonReq('/admin/api/stats', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.users).toBe(42);
      expect(r.body.rooms).toBe(7);
      expect(r.body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    }
    expect(adminDO.fetches.filter((f) => f.url.includes('/stats')).length).toBe(2);
  });

  it('GET stats refresh∥cached both 200; refresh query reaches Admin DO', async () => {
    const adminDO = createAdminDO({ stats: { users: 3, rooms: 1, events: 8 } });
    const env = createEnv({ adminDO });
    const results = await Promise.all([
      jsonReq('/admin/api/stats?refresh=true', {}, env),
      jsonReq('/admin/api/stats', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const refreshFetch = adminDO.fetches.find((f) => f.url.includes('refresh=true'));
    expect(refreshFetch).toBeDefined();
  });

  for (let i = 0; i < 12; i++) {
    it(`parallel stats flood-${i}: refresh=${i % 2 === 0} coherency`, async () => {
      const adminDO = createAdminDO({ stats: { users: 10 + i, rooms: i, events: i * 2 } });
      const env = createEnv({ adminDO });
      const q = i % 2 === 0 ? '?refresh=true' : '';
      const results = await Promise.all(
        [0, 1, 2].map(() => jsonReq(`/admin/api/stats${q}`, {}, env))
      );
      expect(statusesOf(results)).toEqual([200, 200, 200]);
      expect(results.every((r) => r.body.users === 10 + i)).toBe(true);
      expect(results.every((r) => (r.body.server as { name: string }).name === SERVER)).toBe(true);
    });
  }
});

describe('race admin GET history periods concurrent after #214', () => {
  it('GET history 7d∥30d both fill date arrays', async () => {
    const env = createEnv();
    const results = await Promise.all([
      jsonReq('/admin/api/stats/history?period=7d', {}, env),
      jsonReq('/admin/api/stats/history?period=30d', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect((results[0].body.data as unknown[]).length).toBe(7);
    expect((results[1].body.data as unknown[]).length).toBe(30);
  });

  for (let i = 0; i < 10; i++) {
    it(`history period flood-${i}`, async () => {
      const env = createEnv();
      const period = i % 2 === 0 ? '7d' : '30d';
      const results = await Promise.all([
        jsonReq(`/admin/api/stats/history?period=${period}`, {}, env),
        jsonReq(`/admin/api/stats/history?period=${period}`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      const expectLen = period === '7d' ? 7 : 30;
      expect((results[0].body.data as unknown[]).length).toBe(expectLen);
      expect((results[1].body.data as unknown[]).length).toBe(expectLen);
    });
  }
});

describe('race admin GET users∥rooms∥config isolation after #214', () => {
  it('parallel users∥rooms∥config do not clobber bodies', async () => {
    const env = createEnv();
    const [users, rooms, config] = await Promise.all([
      jsonReq('/admin/api/users?limit=10&offset=0', {}, env),
      jsonReq('/admin/api/rooms?limit=5&offset=0', {}, env),
      jsonReq('/admin/api/config', {}, env),
    ]);
    expect(statusesOf([users, rooms, config])).toEqual([200, 200, 200]);
    expect(Array.isArray(users.body.users)).toBe(true);
    expect(Array.isArray(rooms.body.rooms)).toBe(true);
    expect(config.body.server_name).toBe(SERVER);
    expect((config.body.features as { federation: boolean }).federation).toBe(true);
  });

  for (let i = 0; i < 12; i++) {
    it(`users∥rooms query flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        jsonReq(`/admin/api/users?limit=${(i % 5) + 1}&offset=0`, {}, env),
        jsonReq(`/admin/api/rooms?limit=${(i % 3) + 1}&offset=0`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(Array.isArray(results[0].body.users)).toBe(true);
      expect(Array.isArray(results[1].body.rooms)).toBe(true);
    });
  }
});

describe('race admin GET federation/status CACHE get barrier after #214', () => {
  it('parallel status both observe cached signing_key_id', async () => {
    const cache = mockKv(
      { server_signing_key: JSON.stringify({ keyId: 'ed25519:test' }) },
      { getBarrier: { count: 2, match: (key) => key === 'server_signing_key' } }
    );
    const env = createEnv({ cache });
    const results = await Promise.all([
      jsonReq('/admin/api/federation/status', {}, env),
      jsonReq('/admin/api/federation/status', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.server_name).toBe(SERVER);
      expect(r.body.federation_enabled).toBe(true);
      expect(r.body.signing_key_id).toBe('ed25519:test');
      expect(r.body.known_servers_count).toBe(1);
    }
  });

  it('corrupt CACHE JSON falls back to derived signing_key_id under race', async () => {
    const cache = mockKv(
      { server_signing_key: 'not-json{' },
      { getBarrier: { count: 2, match: (key) => key === 'server_signing_key' } }
    );
    const env = createEnv({ cache });
    const results = await Promise.all([
      jsonReq('/admin/api/federation/status', {}, env),
      jsonReq('/admin/api/federation/status', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.signing_key_id).toBe('ed25519:a_exam');
    }
  });

  it('missing CACHE key uses derived signing_key_id', async () => {
    const env = createEnv({ cache: mockKv() });
    const results = await Promise.all([
      jsonReq('/admin/api/federation/status', {}, env),
      jsonReq('/admin/api/federation/status', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.signing_key_id).toBe(results[1].body.signing_key_id);
  });

  it('status∥servers isolation: servers list vs status count', async () => {
    const env = createEnv();
    const [status, servers] = await Promise.all([
      jsonReq('/admin/api/federation/status', {}, env),
      jsonReq('/admin/api/federation/servers', {}, env),
    ]);
    expect(status.status).toBe(200);
    expect(servers.status).toBe(200);
    expect(Array.isArray(servers.body.servers)).toBe(true);
    expect((servers.body.servers as unknown[]).length).toBe(status.body.known_servers_count);
  });

  for (let i = 0; i < 8; i++) {
    it(`federation servers flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        jsonReq('/admin/api/federation/servers', {}, env),
        jsonReq('/admin/api/federation/servers', {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect((results[0].body.servers as Array<{ server_name: string }>)[0].server_name).toBe(
        'remote.example.org'
      );
    });
  }
});

describe('race admin GET federation/test fetch after #214', () => {
  it('parallel self-tests share fetch mock and both pass', async () => {
    mockFederationSelfTestFetch();
    const env = createEnv();
    const results = await Promise.all([
      jsonReq('/admin/api/federation/test', {}, env),
      jsonReq('/admin/api/federation/test', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.success).toBe(true);
      expect(r.body.server_name).toBe(SERVER);
      expect((r.body.tests as unknown[]).length).toBe(4);
    }
  });

  for (let i = 0; i < 8; i++) {
    it(`federation test flood-${i}`, async () => {
      mockFederationSelfTestFetch();
      const env = createEnv();
      const results = await Promise.all([
        jsonReq('/admin/api/federation/test', {}, env),
        jsonReq('/admin/api/federation/test', {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results.every((r) => r.body.success === true)).toBe(true);
    });
  }
});

describe('race admin GET analytics periods concurrent after #214', () => {
  it('requests∥federation analytics isolate period echoes', async () => {
    const env = createEnv();
    const [reqA, fed] = await Promise.all([
      jsonReq('/_matrix/client/v3/admin/analytics/requests?period=7d', {}, env),
      jsonReq('/_matrix/client/v3/admin/analytics/federation?period=1h', {}, env),
    ]);
    expect(reqA.status).toBe(200);
    expect(fed.status).toBe(200);
    expect(reqA.body.period).toBe('7d');
    expect(fed.body.period).toBe('1h');
    expect(typeof fed.body.inbound_events).toBe('number');
    expect(typeof fed.body.outbound_events).toBe('number');
  });

  for (const period of ['1h', '6h', '24h', '7d', 'weird'] as const) {
    it(`analytics period=${period} parallel coherency`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        jsonReq(`/_matrix/client/v3/admin/analytics/requests?period=${period}`, {}, env),
        jsonReq(`/_matrix/client/v3/admin/analytics/federation?period=${period}`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body.period).toBe(period);
      expect(results[1].body.period).toBe(period);
    });
  }
});

describe('race admin GET whois concurrent after #214', () => {
  it('admin dual whois BOB both 200', async () => {
    const env = createEnv();
    const results = await Promise.all([
      jsonReq(`/_matrix/client/v3/admin/whois/${encodeURIComponent(BOB)}`, {}, env),
      jsonReq(`/_matrix/client/v3/admin/whois/${encodeURIComponent(BOB)}`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.user_id).toBe(BOB);
      expect(r.body.devices).toHaveProperty('BOBDEVICE');
    }
  });

  it('whois self∥other isolation', async () => {
    const env = createEnv();
    const [self, other] = await Promise.all([
      jsonReq(`/_matrix/client/v3/admin/whois/${encodeURIComponent(ADMIN)}`, {}, env),
      jsonReq(`/_matrix/client/v3/admin/whois/${encodeURIComponent(BOB)}`, {}, env),
    ]);
    expect(self.status).toBe(200);
    expect(other.status).toBe(200);
    expect(self.body.user_id).toBe(ADMIN);
    expect(other.body.user_id).toBe(BOB);
  });

  for (let i = 0; i < 8; i++) {
    it(`whois flood-${i}`, async () => {
      const env = createEnv();
      const target = i % 2 === 0 ? BOB : ADMIN;
      const results = await Promise.all([
        jsonReq(`/_matrix/client/v3/admin/whois/${encodeURIComponent(target)}`, {}, env),
        jsonReq(`/_matrix/client/v3/admin/whois/${encodeURIComponent(target)}`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body.user_id).toBe(target);
    });
  }
});

describe('race admin GET synapse destinations∥event_reports after #214', () => {
  it('destinations∥event_reports parallel', async () => {
    const env = createEnv();
    const [dest, reports] = await Promise.all([
      jsonReq('/_synapse/admin/v1/federation/destinations?limit=10&from=0', {}, env),
      jsonReq('/_synapse/admin/v1/event_reports?limit=10&from=0', {}, env),
    ]);
    expect(dest.status).toBe(200);
    expect(reports.status).toBe(200);
    expect(Array.isArray(dest.body.destinations)).toBe(true);
    expect(Array.isArray(reports.body.event_reports)).toBe(true);
  });

  it('server_version∥v2 users∥v1 rooms coherency', async () => {
    const env = createEnv();
    const results = await Promise.all([
      jsonReq('/_synapse/admin/v1/server_version', {}, env),
      jsonReq('/_synapse/admin/v2/users?limit=10&from=0', {}, env),
      jsonReq('/_synapse/admin/v1/rooms?limit=10&from=0', {}, env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results[0].body.server_version).toBe('tuwunel-test-0.1.0');
  });

  for (let i = 0; i < 8; i++) {
    it(`synapse destinations flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        jsonReq(`/_synapse/admin/v1/federation/destinations?limit=${i + 1}&from=0`, {}, env),
        jsonReq(`/_synapse/admin/v1/event_reports?limit=${i + 1}&from=0`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race admin GET registration∥idp∥sessions∥keys after #214', () => {
  it('registration GET dual hits Admin DO /config', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const results = await Promise.all([
      jsonReq('/admin/api/registration', {}, env),
      jsonReq('/admin/api/registration', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => r.body.enabled === false)).toBe(true);
  });

  it('idp providers parallel list', async () => {
    const env = createEnv();
    const results = await Promise.all([
      jsonReq('/admin/api/idp/providers', {}, env),
      jsonReq('/admin/api/idp/providers', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect((results[0].body.providers as Array<{ id: string }>)[0].id).toBe('idp1');
  });

  it('sessions∥keys isolation for BOB', async () => {
    const env = createEnv();
    const bobEnc = encodeURIComponent(BOB);
    const [sessions, keys] = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env),
      jsonReq(`/admin/api/users/${bobEnc}/keys`, {}, env),
    ]);
    expect(sessions.status).toBe(200);
    expect(keys.status).toBe(200);
    expect(Array.isArray(sessions.body.sessions)).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`registration GET flood-${i}`, async () => {
      const enabled = i % 2 === 0;
      const adminDO = createAdminDO({ config: { registration_enabled: enabled } });
      const env = createEnv({ adminDO });
      const results = await Promise.all([
        jsonReq('/admin/api/registration', {}, env),
        jsonReq('/admin/api/registration', {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results.every((r) => r.body.enabled === enabled)).toBe(true);
    });
  }
});

describe('race admin GET media∥reports∥audit∥rooms detail after #214', () => {
  it('media∥reports∥audit parallel isolation', async () => {
    const env = createEnv();
    const [media, reports, audit] = await Promise.all([
      jsonReq('/admin/api/media?limit=10&offset=0', {}, env),
      jsonReq('/admin/api/reports?limit=10&offset=0', {}, env),
      jsonReq('/admin/api/audit?limit=10&offset=0', {}, env),
    ]);
    expect(statusesOf([media, reports, audit])).toEqual([200, 200, 200]);
    expect(Array.isArray(media.body.media)).toBe(true);
    expect(Array.isArray(reports.body.reports)).toBe(true);
    expect(Array.isArray(audit.body.entries)).toBe(true);
  });

  it('room detail∥events parallel', async () => {
    const env = createEnv();
    const roomEnc = encodeURIComponent(ROOM);
    const [detail, events] = await Promise.all([
      jsonReq(`/admin/api/rooms/${roomEnc}`, {}, env),
      jsonReq(`/admin/api/rooms/${roomEnc}/events?limit=10`, {}, env),
    ]);
    expect(detail.status).toBe(200);
    expect(events.status).toBe(200);
    expect(detail.body.room_id).toBe(ROOM);
    expect(Array.isArray(events.body.events)).toBe(true);
  });

  it('user detail parallel BOB', async () => {
    const env = createEnv();
    const results = await Promise.all([
      jsonReq(`/admin/api/users/${encodeURIComponent(BOB)}`, {}, env),
      jsonReq(`/admin/api/users/${encodeURIComponent(BOB)}`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.user_id).toBe(BOB);
  });

  for (let i = 0; i < 8; i++) {
    it(`reports query flood-${i}`, async () => {
      const env = createEnv();
      const resolved = i % 3 === 0 ? '' : i % 3 === 1 ? '?resolved=false' : '?resolved=true';
      const results = await Promise.all([
        jsonReq(`/admin/api/reports${resolved}`, {}, env),
        jsonReq(`/admin/api/audit?limit=${i + 1}`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race admin GET non-admin 403 Promise.all after #214', () => {
  it('parallel forbidden across leftover GET surfaces', async () => {
    const env = nonAdminEnv();
    const paths = [
      '/admin/api/stats',
      '/admin/api/stats/history',
      '/admin/api/users',
      '/admin/api/rooms',
      '/admin/api/config',
      '/admin/api/media',
      '/admin/api/reports',
      '/admin/api/audit',
      '/admin/api/federation/status',
      '/_synapse/admin/v1/server_version',
      '/_matrix/client/v3/admin/analytics/requests',
    ];
    const results = await Promise.all(paths.map((p) => jsonReq(p, {}, env)));
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.body.errcode === 'M_FORBIDDEN')).toBe(true);
  });

  for (let i = 0; i < 10; i++) {
    it(`non-admin 403 flood-${i}`, async () => {
      const env = nonAdminEnv();
      const results = await Promise.all([
        jsonReq('/admin/api/stats', {}, env),
        jsonReq('/admin/api/config', {}, env),
        jsonReq('/admin/api/federation/servers', {}, env),
      ]);
      expect(statusesOf(results)).toEqual([403, 403, 403]);
    });
  }
});

describe('race admin GET method-matrix concurrent after #214', () => {
  it('POST/PUT/DELETE/PATCH on GET-only leftover paths', async () => {
    const env = createEnv();
    const paths = [
      '/admin/api/stats',
      '/admin/api/config',
      '/admin/api/federation/status',
      '/admin/api/federation/servers',
      '/_synapse/admin/v1/server_version',
    ];
    const methods = ['POST', 'PUT', 'DELETE', 'PATCH'] as const;
    const results = await Promise.all(
      paths.flatMap((p) => methods.map((m) => jsonReq(p, jsonInit(m, {}), env)))
    );
    expect(results.every((r) => [404, 405].includes(r.status))).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`method matrix flood-${i}`, async () => {
      const env = createEnv();
      const res = await Promise.all([
        jsonReq('/admin/api/stats', jsonInit('POST', {}), env),
        jsonReq('/admin/api/users', jsonInit('PUT', {}), env),
        jsonReq('/admin/api/rooms', jsonInit('PATCH', {}), env),
      ]);
      expect(res.every((r) => [404, 405].includes(r.status))).toBe(true);
    });
  }
});

describe('race admin GET leftover lifecycle Promise.all after #214', () => {
  it('stats→users→rooms→config→media→reports→audit concurrent vs serial leftover', async () => {
    const env = createEnv();
    const results = await Promise.all([
      jsonReq('/admin/api/stats', {}, env),
      jsonReq('/admin/api/users?limit=5', {}, env),
      jsonReq('/admin/api/rooms?limit=5', {}, env),
      jsonReq('/admin/api/config', {}, env),
      jsonReq('/admin/api/media?limit=5', {}, env),
      jsonReq('/admin/api/reports?limit=5', {}, env),
      jsonReq('/admin/api/audit?limit=5', {}, env),
      jsonReq('/admin/api/federation/status', {}, env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`lifecycle concurrent flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        jsonReq(`/admin/api/stats${i % 2 === 0 ? '?refresh=true' : ''}`, {}, env),
        jsonReq(`/admin/api/users?limit=${(i % 4) + 1}`, {}, env),
        jsonReq('/admin/api/config', {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 200]);
    });
  }
});

// ---------------------------------------------------------------------------
// After #232: leftover GET TOCTOU / filter isolation / 404 / CACHE mutate
// ---------------------------------------------------------------------------

describe('race leftover federation/status CACHE mutate mid-flight after #232', () => {
  it('first GET sees cached keyId; later GET falls back after mutate', async () => {
    const cache = mockKv(
      { server_signing_key: JSON.stringify({ keyId: 'ed25519:live' }) },
      {
        getBarrier: { count: 2, match: (key) => key === 'server_signing_key' },
        mutateAfterGets: { after: 1, next: {} },
      }
    );
    const env = createEnv({ cache });
    const results = await Promise.all([
      jsonReq('/admin/api/federation/status', {}, env),
      jsonReq('/admin/api/federation/status', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const ids = results.map((r) => r.body.signing_key_id as string).sort();
    expect(ids).toContain('ed25519:live');
    expect(ids).toContain('ed25519:a_exam');
  });

  it('empty keyId object uses serverName split fallback under race', async () => {
    const cache = mockKv(
      { server_signing_key: JSON.stringify({ notKeyId: true }) },
      { getBarrier: { count: 2, match: (key) => key === 'server_signing_key' } }
    );
    const env = createEnv({ cache });
    const results = await Promise.all([
      jsonReq('/admin/api/federation/status', {}, env),
      jsonReq('/admin/api/federation/status', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => r.body.signing_key_id === 'ed25519:example')).toBe(true);
  });

  it('servers COUNT barrier: both status calls share known_servers_count', async () => {
    const db = createAdminDb({
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('SELECT COUNT(*) as count FROM servers'),
      },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      jsonReq('/admin/api/federation/status', {}, env),
      jsonReq('/admin/api/federation/status', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => r.body.known_servers_count === 1)).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`status CACHE mutate leftover flood-${i}`, async () => {
      const cache = mockKv(
        { server_signing_key: JSON.stringify({ keyId: `ed25519:f${i}` }) },
        {
          getBarrier: { count: 2, match: (key) => key === 'server_signing_key' },
          mutateAfterGets: { after: 1, next: { server_signing_key: 'not-json{' } },
        }
      );
      const env = createEnv({ cache });
      const results = await Promise.all([
        jsonReq('/admin/api/federation/status', {}, env),
        jsonReq('/admin/api/federation/status', {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      const ids = results.map((r) => r.body.signing_key_id as string);
      expect(ids).toContain(`ed25519:f${i}`);
      expect(ids).toContain('ed25519:a_exam');
    });
  }
});

describe('race leftover DEVICE_KEYS get-barrier keys debug after #232', () => {
  it('parallel keys GET both observe BOBDEVICE signatures', async () => {
    const deviceKeys = mockKv(
      {
        [`device:${BOB}:BOBDEVICE`]: JSON.stringify({
          algorithms: ['m.olm.v1.curve25519-aes-sha2'],
          device_id: 'BOBDEVICE',
          user_id: BOB,
          keys: { 'ed25519:BOBDEVICE': 'DEVKEY' },
          signatures: { [BOB]: { 'ed25519:ss': 'sig' } },
        }),
      },
      { getBarrier: { count: 2, match: (key) => key === `device:${BOB}:BOBDEVICE` } }
    );
    const env = createEnv({ deviceKeys });
    const path = `/admin/api/users/${encodeURIComponent(BOB)}/keys`;
    const results = await Promise.all([jsonReq(path, {}, env), jsonReq(path, {}, env)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.user_id).toBe(BOB);
      expect((r.body.verification_status as Record<string, { verified: boolean }>).BOBDEVICE.verified).toBe(
        true
      );
    }
  });

  it('corrupt DEVICE_KEYS JSON surfaces 500 under race (unhandled parse)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deviceKeys = mockKv({ [`device:${BOB}:BOBDEVICE`]: 'not-json{' });
    const env = createEnv({ deviceKeys });
    const path = `/admin/api/users/${encodeURIComponent(BOB)}/keys`;
    const results = await Promise.all([jsonReq(path, {}, env), jsonReq(path, {}, env)]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('keys∥sessions isolation under DEVICE_KEYS barrier', async () => {
    const deviceKeys = mockKv(
      {
        [`device:${BOB}:BOBDEVICE`]: JSON.stringify({
          device_id: 'BOBDEVICE',
          signatures: { [BOB]: { 'ed25519:ss': 'sig' } },
        }),
      },
      { getBarrier: { count: 1, match: (key) => key.startsWith('device:') } }
    );
    const env = createEnv({ deviceKeys });
    const bobEnc = encodeURIComponent(BOB);
    const [keys, sessions] = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}/keys`, {}, env),
      jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env),
    ]);
    expect(keys.status).toBe(200);
    expect(sessions.status).toBe(200);
    expect(Array.isArray(sessions.body.sessions)).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`keys debug leftover flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        jsonReq(`/admin/api/users/${encodeURIComponent(BOB)}/keys`, {}, env),
        jsonReq(`/admin/api/users/${encodeURIComponent(ADMIN)}/keys`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body.user_id).toBe(BOB);
      expect(results[1].body.user_id).toBe(ADMIN);
    });
  }
});

describe('race leftover IdP GET by id + synapse detail after #232', () => {
  it('idp list∥detail isolation: list omits secret, detail has linked_users', async () => {
    const env = createEnv();
    const [list, detail] = await Promise.all([
      jsonReq('/admin/api/idp/providers', {}, env),
      jsonReq('/admin/api/idp/providers/idp1', {}, env),
    ]);
    expect(statusesOf([list, detail])).toEqual([200, 200]);
    expect((list.body.providers as Array<{ id: string }>)[0].id).toBe('idp1');
    expect(detail.body.id).toBe('idp1');
    expect(detail.body.enabled).toBe(true);
    expect(Array.isArray(detail.body.linked_users)).toBe(true);
  });

  it('missing IdP∥missing user∥missing room 404 isolation', async () => {
    const env = createEnv();
    const results = await Promise.all([
      jsonReq('/admin/api/idp/providers/nope', {}, env),
      jsonReq(`/admin/api/users/${encodeURIComponent('@missing:example.com')}`, {}, env),
      jsonReq(`/admin/api/rooms/${encodeURIComponent('!missing:example.com')}`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([404, 404, 404]);
    expect(results.every((r) => r.body.errcode === 'M_NOT_FOUND')).toBe(true);
  });

  it('synapse v2 user detail∥v1 room detail parallel', async () => {
    const env = createEnv();
    const [user, room] = await Promise.all([
      jsonReq(`/_synapse/admin/v2/users/${encodeURIComponent(BOB)}`, {}, env),
      jsonReq(`/_synapse/admin/v1/rooms/${encodeURIComponent(ROOM)}`, {}, env),
    ]);
    expect(user.status).toBe(200);
    expect(room.status).toBe(200);
    expect(user.body.name).toBe(BOB);
    expect(user.body.threepids).toEqual([]);
    expect(room.body.room_id).toBe(ROOM);
    expect(room.body.name).toBe('General');
  });

  for (let i = 0; i < 8; i++) {
    it(`idp detail leftover flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        jsonReq('/admin/api/idp/providers/idp1', {}, env),
        jsonReq('/admin/api/idp/providers/idp1', {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results.every((r) => r.body.name === 'GitHub')).toBe(true);
    });
  }
});

describe('race leftover whois non-admin + search filters after #232', () => {
  it('non-admin self whois 200∥other 403', async () => {
    authState.userId = BOB;
    const env = nonAdminEnv();
    const [self, other] = await Promise.all([
      jsonReq(`/_matrix/client/v3/admin/whois/${encodeURIComponent(BOB)}`, {}, env),
      jsonReq(`/_matrix/client/v3/admin/whois/${encodeURIComponent(ADMIN)}`, {}, env),
    ]);
    expect(self.status).toBe(200);
    expect(other.status).toBe(403);
    expect(self.body.user_id).toBe(BOB);
    expect(other.body.errcode).toBe('M_FORBIDDEN');
  });

  it('whois missing user 404 under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      jsonReq(`/_matrix/client/v3/admin/whois/${encodeURIComponent('@ghost:example.com')}`, {}, env),
      jsonReq(`/_matrix/client/v3/admin/whois/${encodeURIComponent('@ghost:example.com')}`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  it('users search=bob∥synapse guests=false isolation', async () => {
    const env = createEnv();
    const [search, guests] = await Promise.all([
      jsonReq('/admin/api/users?search=bob&limit=10', {}, env),
      jsonReq('/_synapse/admin/v2/users?guests=false&limit=10&from=0', {}, env),
    ]);
    expect(statusesOf([search, guests])).toEqual([200, 200]);
    expect(Array.isArray(search.body.users)).toBe(true);
    expect(Array.isArray(guests.body.users)).toBe(true);
  });

  it('history invalid period pins 7d under race vs 30d', async () => {
    const env = createEnv();
    const [weird, month] = await Promise.all([
      jsonReq('/admin/api/stats/history?period=weird', {}, env),
      jsonReq('/admin/api/stats/history?period=30d', {}, env),
    ]);
    expect(statusesOf([weird, month])).toEqual([200, 200]);
    expect(weird.body.period).toBe('7d');
    expect((weird.body.data as unknown[]).length).toBe(7);
    expect(month.body.period).toBe('30d');
    expect((month.body.data as unknown[]).length).toBe(30);
  });

  for (let i = 0; i < 8; i++) {
    it(`search filter leftover flood-${i}`, async () => {
      const env = createEnv();
      const q = i % 2 === 0 ? 'bob' : 'admin';
      const results = await Promise.all([
        jsonReq(`/admin/api/users?search=${q}`, {}, env),
        jsonReq(`/_synapse/admin/v2/users?name=${q}&from=0&limit=5`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race leftover audit/report/events query isolation after #232', () => {
  it('audit actor∥target∥action filters isolate', async () => {
    const env = createEnv();
    const [actor, target, action] = await Promise.all([
      jsonReq(`/admin/api/audit?actor=${encodeURIComponent(ADMIN)}`, {}, env),
      jsonReq(`/admin/api/audit?target=${encodeURIComponent(BOB)}`, {}, env),
      jsonReq('/admin/api/audit?action=user.update', {}, env),
    ]);
    expect(statusesOf([actor, target, action])).toEqual([200, 200, 200]);
    expect(Array.isArray(actor.body.entries)).toBe(true);
    expect(Array.isArray(target.body.entries)).toBe(true);
    expect(Array.isArray(action.body.entries)).toBe(true);
  });

  it('reports resolved=true∥false isolate totals', async () => {
    const db = createAdminDb({
      reports: [
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
        {
          id: 2,
          reporter_user_id: BOB,
          room_id: ROOM,
          event_id: '$msg:example.com',
          reason: 'done',
          score: 0,
          created_at: 9_000,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: 9_100,
          resolution_note: 'ok',
        },
      ],
    });
    const env = createEnv({ db });
    const [open, closed] = await Promise.all([
      jsonReq('/admin/api/reports?resolved=false', {}, env),
      jsonReq('/admin/api/reports?resolved=true', {}, env),
    ]);
    expect(statusesOf([open, closed])).toEqual([200, 200]);
    expect(open.body.total).toBe(1);
    expect(closed.body.total).toBe(1);
  });

  it('room events before= pagination isolation', async () => {
    const env = createEnv();
    const roomEnc = encodeURIComponent(ROOM);
    const [all, before] = await Promise.all([
      jsonReq(`/admin/api/rooms/${roomEnc}/events?limit=50`, {}, env),
      jsonReq(`/admin/api/rooms/${roomEnc}/events?limit=50&before=15`, {}, env),
    ]);
    expect(statusesOf([all, before])).toEqual([200, 200]);
    expect(Array.isArray(all.body.events)).toBe(true);
    expect(Array.isArray(before.body.events)).toBe(true);
  });

  it('synapse destinations next_token vs event_reports dir=f', async () => {
    const env = createEnv();
    const [dest, reports] = await Promise.all([
      jsonReq('/_synapse/admin/v1/federation/destinations?limit=1&from=0', {}, env),
      jsonReq('/_synapse/admin/v1/event_reports?limit=10&from=0&dir=f', {}, env),
    ]);
    expect(dest.status).toBe(200);
    expect(reports.status).toBe(200);
    expect(dest.body.total).toBe(1);
    expect(dest.body.next_token).toBeUndefined();
    expect(Array.isArray(reports.body.event_reports)).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`audit/report leftover flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        jsonReq(`/admin/api/audit?limit=${(i % 3) + 1}`, {}, env),
        jsonReq(`/admin/api/reports?limit=${(i % 3) + 1}`, {}, env),
        jsonReq(`/admin/api/media?limit=${(i % 3) + 1}&offset=0`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 200]);
    });
  }
});

describe('race leftover federation/test fetch fail + config after #232', () => {
  it('parallel self-tests both fail when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network down');
    });
    const env = createEnv();
    const results = await Promise.all([
      jsonReq('/admin/api/federation/test', {}, env),
      jsonReq('/admin/api/federation/test', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => r.body.success === false)).toBe(true);
    expect(results.every((r) => (r.body.tests as unknown[]).length === 4)).toBe(true);
  });

  it('mixed HTTP fail on keys endpoint: tests array still length 4', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/_matrix/key/v2/server')) {
        return new Response('nope', { status: 503 });
      }
      if (url.includes('/.well-known/matrix/server')) {
        return Response.json({ 'm.server': `${SERVER}:443` });
      }
      if (url.includes('/_matrix/federation/v1/version')) {
        return Response.json({ server: { name: 'matrix-worker', version: 'x' } });
      }
      if (url.includes('/.well-known/matrix/client')) {
        return Response.json({ 'm.homeserver': { base_url: `https://${SERVER}` } });
      }
      return new Response('missing', { status: 404 });
    });
    const env = createEnv();
    const results = await Promise.all([
      jsonReq('/admin/api/federation/test', {}, env),
      jsonReq('/admin/api/config', {}, env),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    expect(results[0].body.success).toBe(false);
    expect(results[1].body.server_name).toBe(SERVER);
    expect((results[1].body.limits as { max_upload_size: number }).max_upload_size).toBe(
      50 * 1024 * 1024
    );
  });

  it('config∥registration GET∥synapse version leftover isolation', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const [config, reg, ver] = await Promise.all([
      jsonReq('/admin/api/config', {}, env),
      jsonReq('/admin/api/registration', {}, env),
      jsonReq('/_synapse/admin/v1/server_version', {}, env),
    ]);
    expect(statusesOf([config, reg, ver])).toEqual([200, 200, 200]);
    expect(reg.body.enabled).toBe(false);
    expect(ver.body.python_version).toBe('N/A (Cloudflare Workers)');
    expect((config.body.features as { voip: boolean }).voip).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`config leftover flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        jsonReq('/admin/api/config', {}, env),
        jsonReq('/_synapse/admin/v1/server_version', {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body.version).toBe('tuwunel-test-0.1.0');
    });
  }
});

describe('race leftover GET charset + HEAD/OPTIONS after #232', () => {
  it('GET leftover paths with charset Content-Type still 200', async () => {
    const env = createEnv();
    const init: RequestInit = {
      method: 'GET',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...AUTH },
    };
    const results = await Promise.all([
      jsonReq('/admin/api/config', init, env),
      jsonReq('/admin/api/users?limit=1', init, env),
      jsonReq('/admin/api/federation/servers', init, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
  });

  it('HEAD/OPTIONS leftover GET paths', async () => {
    const env = createEnv();
    const results = await Promise.all([
      jsonReq('/admin/api/stats', jsonInit('HEAD'), env),
      jsonReq('/admin/api/config', jsonInit('OPTIONS'), env),
      jsonReq('/admin/api/users', jsonInit('PATCH', {}), env),
    ]);
    expect(results.every((r) => [200, 204, 404, 405].includes(r.status))).toBe(true);
  });

  for (let i = 0; i < 6; i++) {
    it(`charset leftover flood-${i}`, async () => {
      const env = createEnv();
      const init: RequestInit = {
        headers: { 'Content-Type': `application/json; charset=utf-8`, ...AUTH },
      };
      const results = await Promise.all([
        jsonReq('/admin/api/media?limit=1', init, env),
        jsonReq('/admin/api/audit?limit=1', init, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

// residual concurrent races after #241 (route-leftover soft niches not raced post-#239)

describe('race residual sessions list∥revoke after #241', () => {
  it('sessions GET∥DELETE-all under race', async () => {
    const db = createAdminDb();
    const bobEnc = encodeURIComponent(BOB);
    const env = createEnv({ db });
    const [list, revoke] = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env),
      jsonReq(`/admin/api/users/${bobEnc}/sessions`, { method: 'DELETE', headers: AUTH }, env),
    ]);
    expect(list.status).toBe(200);
    expect(revoke.status).toBe(200);
    expect(revoke.body.success).toBe(true);
    expect(db.tokens.every((t) => t.user_id !== BOB)).toBe(true);
  });

  it('session id revoke∥list isolation', async () => {
    const db = createAdminDb();
    const bobEnc = encodeURIComponent(BOB);
    const env = createEnv({ db });
    const [rev, list] = await Promise.all([
      jsonReq('/admin/api/sessions/tok-bob', { method: 'DELETE', headers: AUTH }, env),
      jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env),
    ]);
    expect(rev.status).toBe(200);
    expect(list.status).toBe(200);
    expect(db.tokens.find((t) => t.token_id === 'tok-bob')).toBeUndefined();
  });

  for (let i = 0; i < 8; i++) {
    it(`sessions residual flood-${i}`, async () => {
      const db = createAdminDb();
      const bobEnc = encodeURIComponent(BOB);
      const env = createEnv({ db });
      const results = await Promise.all([
        jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env),
        jsonReq(`/admin/api/users/${bobEnc}/sessions`, { method: 'DELETE', headers: AUTH }, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race residual login-token∥sessions after #241', () => {
  it('login-token mint∥sessions list dual 200', async () => {
    const sessions = mockKv();
    const db = createAdminDb();
    const bobEnc = encodeURIComponent(BOB);
    const env = createEnv({ db, sessions });
    const [token, list] = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}/login-token`, jsonInit('POST', { ttl_minutes: 5 }), env),
      jsonReq(`/admin/api/users/${bobEnc}/sessions`, {}, env),
    ]);
    expect(token.status).toBe(200);
    expect(list.status).toBe(200);
    expect(token.body.token).toBe('mlt_pinned_login_token');
    expect(sessions.puts.length).toBeGreaterThanOrEqual(1);
  });

  it('login-token deactivated∥missing isolation', async () => {
    const db = createAdminDb({
      users: [defaultAdmin(), { ...defaultBob(), is_deactivated: 1 }],
    });
    const env = createEnv({ db });
    const [deact, missing] = await Promise.all([
      jsonReq(
        `/admin/api/users/${encodeURIComponent(BOB)}/login-token`,
        jsonInit('POST', { ttl_minutes: 2 }),
        env
      ),
      jsonReq(
        `/admin/api/users/${encodeURIComponent('@nope:example.com')}/login-token`,
        jsonInit('POST', {}),
        env
      ),
    ]);
    expect(deact.status).toBe(400);
    expect(deact.body.errcode).toBe('M_USER_DEACTIVATED');
    expect(missing.status).toBe(404);
  });

  for (let i = 0; i < 8; i++) {
    it(`login-token residual flood-${i}`, async () => {
      const sessions = mockKv();
      const env = createEnv({ sessions });
      const results = await Promise.all([
        jsonReq(
          `/admin/api/users/${encodeURIComponent(BOB)}/login-token`,
          jsonInit('POST', { ttl_minutes: 1 + (i % 3) }),
          env
        ),
        jsonReq(`/admin/api/users/${encodeURIComponent(BOB)}/sessions`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race residual quarantine∥media∥reactivate after #241', () => {
  it('quarantine∥media list isolation', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const [q, list] = await Promise.all([
      jsonReq(`/admin/api/media/${MEDIA_ID}/quarantine`, { method: 'POST', headers: AUTH }, env),
      jsonReq('/admin/api/media?limit=10', {}, env),
    ]);
    expect(q.status).toBe(200);
    expect(list.status).toBe(200);
    expect(db.media.find((m) => m.media_id === MEDIA_ID)?.quarantined).toBe(1);
  });

  it('reactivate∥user detail dual', async () => {
    const db = createAdminDb({
      users: [defaultAdmin(), { ...defaultBob(), is_deactivated: 1 }],
    });
    const bobEnc = encodeURIComponent(BOB);
    const env = createEnv({ db });
    const [react, detail] = await Promise.all([
      jsonReq(`/admin/api/users/${bobEnc}/reactivate`, { method: 'POST', headers: AUTH }, env),
      jsonReq(`/admin/api/users/${bobEnc}`, {}, env),
    ]);
    expect(react.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(db.users.find((u) => u.user_id === BOB)?.is_deactivated).toBe(0);
  });

  for (let i = 0; i < 8; i++) {
    it(`quarantine/reactivate residual flood-${i}`, async () => {
      const db = createAdminDb({
        users: [defaultAdmin(), { ...defaultBob(), is_deactivated: 1 }],
      });
      const env = createEnv({ db });
      const results = await Promise.all([
        jsonReq(`/admin/api/media/${MEDIA_ID}/quarantine`, { method: 'POST', headers: AUTH }, env),
        jsonReq(
          `/admin/api/users/${encodeURIComponent(BOB)}/reactivate`,
          { method: 'POST', headers: AUTH },
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race residual make-admin∥whois∥analytics after #241', () => {
  it('make-admin∥whois isolation', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const [make, whois] = await Promise.all([
      jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: BOB }), env),
      jsonReq(`/_matrix/client/v3/admin/whois/${encodeURIComponent(BOB)}`, {}, env),
    ]);
    expect(make.status).toBe(200);
    expect(whois.status).toBe(200);
    expect(db.users.find((u) => u.user_id === BOB)?.admin).toBe(1);
  });

  it('remove-admin self-demote∥make-admin isolation', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const [self, make] = await Promise.all([
      jsonReq('/admin/api/remove-admin', jsonInit('POST', { user_id: ADMIN }), env),
      jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: BOB }), env),
    ]);
    expect(self.status).toBe(403);
    expect(make.status).toBe(200);
  });

  it('analytics requests∥federation∥destinations residual', async () => {
    const env = createEnv();
    const results = await Promise.all([
      jsonReq('/_matrix/client/v3/admin/analytics/requests?period=7d', {}, env),
      jsonReq('/_matrix/client/v3/admin/analytics/federation?period=1h', {}, env),
      jsonReq('/_synapse/admin/v1/federation/destinations?limit=5&from=0', {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results[0].body.period).toBe('7d');
    expect(results[1].body.period).toBe('1h');
    expect(Array.isArray(results[2].body.destinations)).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`make-admin/analytics residual flood-${i}`, async () => {
      const db = createAdminDb();
      const env = createEnv({ db });
      const results = await Promise.all([
        jsonReq('/admin/api/make-admin', jsonInit('POST', { user_id: BOB }), env),
        jsonReq(`/_matrix/client/v3/admin/analytics/requests?period=${i % 2 === 0 ? '1h' : '24h'}`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});
