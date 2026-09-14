/**
 * TOKENMAXX HEAVY deepen after #99 — different slice: admin API routes.
 * Avoids keys (#99), key-backups (#93/#96), search (#94), oauth (#90).
 * Tests-only — no product inventing.
 * Exercises /admin/api/* + Synapse-compat + whois/analytics via Hono app.request().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

/** Switchable auth principal for whois / requireAdmin !userId edges. */
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
const ROOM_ENC = encodeURIComponent(ROOM);
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
  let nextLinkId = Math.max(0, ...idpLinks.map((l) => l.id)) + 1;
  let nextAuditId = Math.max(0, ...audit.map((a) => a.id)) + 1;

  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const runs: SqlCall[] = [];

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

describe('admin API auth gate', () => {
  it('rejects non-admin via requireAdmin after auth', async () => {
    const db = createAdminDb({
      users: [
        {
          ...defaultAdmin(),
          admin: 0,
        },
        defaultBob(),
      ],
    });
    const res = await req('/admin/api/config', {}, createEnv({ db }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('rejects unknown user (no admin row)', async () => {
    const db = createAdminDb({ users: [defaultBob()] });
    const res = await req('/admin/api/config', {}, createEnv({ db }));
    expect(res.status).toBe(403);
  });
});

describe('GET /admin/api/stats + history', () => {
  it('merges DO stats with server info and honors refresh', async () => {
    const adminDO = createAdminDO({ stats: { users: 9, rooms: 3 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(9);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches[0].url).toContain('refresh=true');
  });

  it('defaults history period to 7d and fills zero series', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
    const res = await req('/admin/api/stats/history');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.period).toBe('7d');
    expect(body.data).toHaveLength(7);
    expect(body.data[0]).toMatchObject({ events: 0, registrations: 0 });
    expect(body.data[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    vi.useRealTimers();
  });

  it('accepts 30d period', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
    const res = await req('/admin/api/stats/history?period=30d');
    const body = await res.json();
    expect(body.period).toBe('30d');
    expect(body.data).toHaveLength(30);
    vi.useRealTimers();
  });
});

describe('admin users CRUD', () => {
  it('lists users with clamped limit/offset and search', async () => {
    const res = await req('/admin/api/users?limit=999&offset=-5&search=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
    expect(body.users.some((u: { localpart: string }) => u.localpart === 'bob')).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it('returns user details with devices and rooms', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
  });

  it('404s missing user detail', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent('@nope:example.com')}`);
    expect(res.status).toBe(404);
  });

  it('updates user fields and rejects empty/bad JSON', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const bad = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      { method: 'PUT', body: 'not-json' },
      env
    );
    expect(bad.status).toBe(400);

    const empty = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env
    );
    expect(empty.status).toBe(400);

    const ok = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: 'Bobby', admin: true, deactivated: false }),
      },
      env
    );
    expect(ok.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((i) => i.sql.includes('admin_audit_log'))).toBe(true);
  });

  it('deactivates user and revokes tokens + invalidates cache', async () => {
    const db = createAdminDb();
    const adminDO = createAdminDO();
    const env = createEnv({ db, adminDO });
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`, { method: 'DELETE' }, env);
    expect(res.status).toBe(200);
    expect(db.users.find((u) => u.user_id === BOB)?.is_deactivated).toBe(1);
    expect(db.tokens.some((t) => t.user_id === BOB)).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/invalidate-cache'))).toBe(true);
  });

  it('reset-password requires password and hashes + revokes', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const missing = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}/reset-password`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env
    );
    expect(missing.status).toBe(400);

    const ok = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}/reset-password`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'NewPass123!' }),
      },
      env
    );
    expect(ok.status).toBe(200);
    expect(db.users.find((u) => u.user_id === BOB)?.password_hash).toBe('hashed:NewPass123!');
  });

  it('create user validates username and rejects duplicates', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const badName = await req(
      '/admin/api/users/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Bad Name!', password: 'x' }),
      },
      env
    );
    expect(badName.status).toBe(400);
    expect((await badName.json()).errcode).toBe('M_INVALID_USERNAME');

    const dup = await req(
      '/admin/api/users/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'bob', password: 'x' }),
      },
      env
    );
    expect(dup.status).toBe(400);
    expect((await dup.json()).errcode).toBe('M_USER_IN_USE');

    const ok = await req(
      '/admin/api/users/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'carol',
          password: 'Secret1!',
          display_name: 'Carol',
          admin: true,
        }),
      },
      env
    );
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.user_id).toBe(CAROL);
    expect(db.users.some((u) => u.user_id === CAROL && u.admin === 1)).toBe(true);
  });

  it('reactivate user clears deactivated flag', async () => {
    const db = createAdminDb({
      users: [defaultAdmin(), { ...defaultBob(), is_deactivated: 1 }],
    });
    const env = createEnv({ db });
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}/reactivate`,
      { method: 'POST' },
      env
    );
    expect(res.status).toBe(200);
    expect(db.users.find((u) => u.user_id === BOB)?.is_deactivated).toBe(0);
  });

  it('make-admin / remove-admin with self-demotion guard', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const make = await req(
      '/admin/api/make-admin',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: BOB }),
      },
      env
    );
    expect(make.status).toBe(200);
    expect(db.users.find((u) => u.user_id === BOB)?.admin).toBe(1);

    const self = await req(
      '/admin/api/remove-admin',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: ADMIN }),
      },
      env
    );
    expect(self.status).toBe(403);

    const remove = await req(
      '/admin/api/remove-admin',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: BOB }),
      },
      env
    );
    expect(remove.status).toBe(200);
    expect(db.users.find((u) => u.user_id === BOB)?.admin).toBe(0);
  });

  it('sessions list + revoke all + revoke one', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const list = await req(`/admin/api/users/${encodeURIComponent(BOB)}/sessions`, {}, env);
    expect((await list.json()).sessions[0].id).toBe('tok-bob');

    const one = await req('/admin/api/sessions/tok-bob', { method: 'DELETE' }, env);
    expect(one.status).toBe(200);
    expect(db.tokens.some((t) => t.token_id === 'tok-bob')).toBe(false);

    db.tokens.push({ token_id: 'tok-bob2', user_id: BOB, device_id: 'BOBDEVICE', created_at: 3 });
    const all = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}/sessions`,
      { method: 'DELETE' },
      env
    );
    const body = await all.json();
    expect(body.success).toBe(true);
    expect(body.revoked).toBeGreaterThanOrEqual(1);
  });
});

describe('admin purge / bulk-delete / cleanup', () => {
  it('refuses self-purge and purges other user media+KV', async () => {
    const db = createAdminDb();
    const media = mockR2();
    const deviceKeys = mockKv({ [`device:${BOB}:BOBDEVICE`]: '{}' });
    const crossSigning = mockKv({ [`user:${BOB}`]: '{}' });
    const adminDO = createAdminDO();
    const env = createEnv({ db, media, deviceKeys, crossSigning, adminDO });

    const self = await req(
      `/admin/api/users/${encodeURIComponent(ADMIN)}/purge`,
      { method: 'DELETE' },
      env
    );
    expect(self.status).toBe(403);

    const ok = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}/purge`,
      { method: 'DELETE' },
      env
    );
    expect(ok.status).toBe(200);
    expect(db.users.some((u) => u.user_id === BOB)).toBe(false);
    expect(media.deleted).toContain(MEDIA_ID);
    expect(media.deleted.some((k) => k.startsWith('thumb_'))).toBe(true);
    expect(deviceKeys.deletes).toContain(`device:${BOB}:BOBDEVICE`);
    expect(crossSigning.deletes).toContain(`user:${BOB}`);
  });

  it('bulk-delete filters self and optionally preserves admins', async () => {
    const db = createAdminDb({
      users: [
        defaultAdmin(),
        defaultBob(),
        { ...defaultBob(), user_id: CAROL, localpart: 'carol', admin: 1 },
      ],
    });
    const env = createEnv({ db });
    const empty = await req(
      '/admin/api/users/bulk-delete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_ids: [ADMIN] }),
      },
      env
    );
    expect((await empty.json()).deleted).toBe(0);

    const preserved = await req(
      '/admin/api/users/bulk-delete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_ids: [BOB, CAROL], preserve_admin: true }),
      },
      env
    );
    expect((await preserved.json()).deleted).toBe(1);
    expect(db.users.some((u) => u.user_id === BOB)).toBe(false);
    expect(db.users.some((u) => u.user_id === CAROL)).toBe(true);
  });

  it('cleanup removes non-admins and room/media data', async () => {
    const db = createAdminDb();
    const media = mockR2();
    const env = createEnv({ db, media });
    const res = await req('/admin/api/cleanup', { method: 'POST' }, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users_deleted).toBe(1);
    expect(body.rooms_deleted).toBe(true);
    expect(media.deleted).toContain(MEDIA_ID);
    expect(db.users.every((u) => u.admin === 1)).toBe(true);
  });
});

describe('admin rooms + media + federation', () => {
  it('lists rooms with names and room detail', async () => {
    const list = await req('/admin/api/rooms?limit=10&offset=0');
    const listBody = await list.json();
    expect(listBody.rooms[0].name).toBe('General');
    expect(listBody.total).toBe(1);

    const detail = await req(`/admin/api/rooms/${ROOM_ENC}`);
    const body = await detail.json();
    expect(body.name).toBe('General');
    expect(body.topic).toBe('hello');
    expect(body.join_rule).toBe('public');
    expect(body.member_count).toBe(2);
    expect(body.aliases).toContain('#general:example.com');
  });

  it('404s missing room and deletes room cascade', async () => {
    const miss = await req(`/admin/api/rooms/${encodeURIComponent('!nope:example.com')}`);
    expect(miss.status).toBe(404);

    const db = createAdminDb();
    const adminDO = createAdminDO();
    const env = createEnv({ db, adminDO });
    const del = await req(`/admin/api/rooms/${ROOM_ENC}`, { method: 'DELETE' }, env);
    expect(del.status).toBe(200);
    expect(db.rooms.some((r) => r.room_id === ROOM)).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/invalidate-cache'))).toBe(true);
  });

  it('browses room events with before cursor', async () => {
    const res = await req(`/admin/api/rooms/${ROOM_ENC}/events?limit=2&before=20`);
    const body = await res.json();
    expect(body.events.length).toBeLessThanOrEqual(2);
    expect(body.events[0].content).toBeTruthy();
  });

  it('lists/deletes/quarantines media', async () => {
    const db = createAdminDb();
    const media = mockR2();
    const env = createEnv({ db, media });
    const list = await req('/admin/api/media?limit=50&offset=0', {}, env);
    expect((await list.json()).media[0].media_id).toBe(MEDIA_ID);

    const q = await req(`/admin/api/media/${MEDIA_ID}/quarantine`, { method: 'POST' }, env);
    expect(q.status).toBe(200);
    expect(db.media.find((m) => m.media_id === MEDIA_ID)?.quarantined).toBe(1);

    const del = await req(`/admin/api/media/${MEDIA_ID}`, { method: 'DELETE' }, env);
    expect(del.status).toBe(200);
    expect(media.deleted).toContain(MEDIA_ID);
    expect(media.deleted).toContain(`thumb_${MEDIA_ID}_96x96_crop`);
  });

  it('federation status reads CACHE signing key and lists servers', async () => {
    const status = await req('/admin/api/federation/status');
    const s = await status.json();
    expect(s.server_name).toBe(SERVER);
    expect(s.signing_key_id).toBe('ed25519:test');
    expect(s.known_servers_count).toBe(1);

    const list = await req('/admin/api/federation/servers');
    expect((await list.json()).servers[0].server_name).toBe('remote.example.org');
  });

  it('federation test aggregates well-known/key/version outcomes', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/.well-known/matrix/server')) {
        return Response.json({ 'm.server': `${SERVER}:443` });
      }
      if (String(url).includes('/_matrix/key/v2/server')) {
        return Response.json({ verify_keys: { 'ed25519:a': { key: 'x' } } });
      }
      if (String(url).includes('/_matrix/federation/v1/version')) {
        return Response.json({ server: { name: 'tuwunel', version: '1' } });
      }
      if (String(url).includes('/.well-known/matrix/client')) {
        return new Response('nope', { status: 404 });
      }
      return new Response('err', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await req('/admin/api/federation/test');
    const body = await res.json();
    expect(body.tests).toHaveLength(4);
    expect(body.tests.filter((t: { passed: boolean }) => t.passed)).toHaveLength(3);
    expect(body.success).toBe(false);
    vi.unstubAllGlobals();
  });

  it('federation test records fetch exceptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    const res = await req('/admin/api/federation/test');
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.tests.every((t: { passed: boolean }) => !t.passed)).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('admin config / registration / audit / reports / notices', () => {
  it('returns static config feature flags', async () => {
    const res = await req('/admin/api/config');
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
  });

  it('gets and puts registration via Admin DO', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const get = await req('/admin/api/registration', {}, env);
    expect((await get.json()).enabled).toBe(true);

    const bad = await req(
      '/admin/api/registration',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      },
      env
    );
    expect(bad.status).toBe(400);

    const put = await req(
      '/admin/api/registration',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      },
      env
    );
    expect(put.status).toBe(200);
    expect(adminDO.config.registration_enabled).toBe(false);
  });

  it('registration put failure returns 500 and audits failure', async () => {
    const adminDO = createAdminDO({ failConfigPut: true });
    const db = createAdminDb();
    const env = createEnv({ adminDO, db });
    const put = await req(
      '/admin/api/registration',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      },
      env
    );
    expect(put.status).toBe(500);
    expect(
      db.inserts.some(
        (i) =>
          i.sql.includes('admin_audit_log') &&
          i.args.includes('config.registration.update') &&
          i.args.includes(0)
      )
    ).toBe(true);
  });

  it('lists audit entries with filters and safeParseJson fallback', async () => {
    const res = await req(
      `/admin/api/audit?actor=${encodeURIComponent(ADMIN)}&target=${encodeURIComponent(BOB)}&action=user.update&limit=10`
    );
    const body = await res.json();
    expect(body.entries[0].success).toBe(true);
    expect(body.entries[0].details).toEqual({ display_name: true });

    const all = await req('/admin/api/audit?limit=50');
    const allBody = await all.json();
    const broken = allBody.entries.find((e: { id: number }) => e.id === 2);
    expect(broken.details).toBe('not-json{');
    expect(broken.success).toBe(false);
  });

  it('lists reports and resolve/unresolve with 404', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const list = await req('/admin/api/reports?resolved=false&limit=10', {}, env);
    const listBody = await list.json();
    expect(listBody.reports[0].id).toBe(1);
    expect(listBody.reports[0].event_content.body).toBe('hi');

    const miss = await req(
      '/admin/api/reports/999/resolve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'x' }),
      },
      env
    );
    expect(miss.status).toBe(404);

    const resolve = await req(
      '/admin/api/reports/1/resolve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'handled' }),
      },
      env
    );
    expect(resolve.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);

    const un = await req('/admin/api/reports/1/unresolve', { method: 'POST' }, env);
    expect(un.status).toBe(200);
    expect(db.reports[0].resolved).toBe(0);
  });

  it('server-notice fans out to devices', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req(
      '/admin/api/server-notice',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: BOB, message: 'Hello bob' }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect((await res.json()).devices_notified).toBe(1);
    expect(db.inserts.some((i) => i.sql.includes('to_device_messages'))).toBe(true);
  });

  it('login-token rejects missing/deactivated and stores session', async () => {
    const sessions = mockKv();
    const db = createAdminDb();
    const env = createEnv({ db, sessions });

    const miss = await req(
      `/admin/api/users/${encodeURIComponent('@nope:example.com')}/login-token`,
      { method: 'POST' },
      env
    );
    expect(miss.status).toBe(404);

    db.users.find((u) => u.user_id === BOB)!.is_deactivated = 1;
    const deact = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}/login-token`,
      { method: 'POST' },
      env
    );
    expect(deact.status).toBe(400);

    db.users.find((u) => u.user_id === BOB)!.is_deactivated = 0;
    const ok = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}/login-token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Host: 'matrix.example.com' },
        body: JSON.stringify({ ttl_minutes: 120 }),
      },
      env
    );
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.token).toBe('mlt_pinned_login_token');
    expect(body.ttl_seconds).toBe(60 * 60); // clamped to 60 min
    expect(sessions.puts[0].key).toBe('login_token:tokhash:mlt_pinned_login_token');
    expect(sessions.puts[0].options?.expirationTtl).toBe(3600);
  });
});

describe('admin IdP provider management', () => {
  it('lists providers with linked_users counts', async () => {
    const res = await req('/admin/api/idp/providers');
    const body = await res.json();
    expect(body.providers[0].id).toBe('idp1');
    expect(body.providers[0].enabled).toBe(true);
    expect(body.providers[0].linked_users).toBe(1);
  });

  it('creates provider after discovery + encrypt', async () => {
    const db = createAdminDb({ idpProviders: [] });
    const env = createEnv({ db });
    const missing = await req(
      '/admin/api/idp/providers',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'X' }),
      },
      env
    );
    expect(missing.status).toBe(400);

    const bad = await req(
      '/admin/api/idp/providers',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Bad',
          issuer_url: 'https://bad-issuer.example',
          client_id: 'c',
          client_secret: 's',
        }),
      },
      env
    );
    expect(bad.status).toBe(400);

    const ok = await req(
      '/admin/api/idp/providers',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Okta',
          issuer_url: 'https://okta.example.com/',
          client_id: 'cid2',
          client_secret: 'sekrit',
          auto_create_users: false,
        }),
      },
      env
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).id).toBe('idp-opaque-12');
    expect(db.idpProviders[0].issuer_url).toBe('https://okta.example.com');
    expect(db.idpProviders[0].client_secret_encrypted).toBe('enc:sekrit');
    expect(db.idpProviders[0].auto_create_users).toBe(0);
  });

  it('gets/updates/deletes provider and link + test connection', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });

    const detail = await req('/admin/api/idp/providers/idp1', {}, env);
    expect((await detail.json()).linked_users[0].external_id).toBe('gh-1');

    const miss = await req('/admin/api/idp/providers/nope', {}, env);
    expect(miss.status).toBe(404);

    const noChange = await req(
      '/admin/api/idp/providers/idp1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env
    );
    expect((await noChange.json()).message).toBe('No changes');

    const upd = await req(
      '/admin/api/idp/providers/idp1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'GitHub2',
          enabled: false,
          client_secret: 'new',
          issuer_url: 'https://idp.example.com',
        }),
      },
      env
    );
    expect(upd.status).toBe(200);

    const badIss = await req(
      '/admin/api/idp/providers/idp1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issuer_url: 'https://bad-issuer.example' }),
      },
      env
    );
    expect(badIss.status).toBe(400);

    const testOk = await req('/admin/api/idp/providers/idp1/test', { method: 'POST' }, env);
    expect((await testOk.json()).success).toBe(true);

    const unlink = await req('/admin/api/idp/providers/idp1/links/10', { method: 'DELETE' }, env);
    expect(unlink.status).toBe(200);
    expect(db.idpLinks.some((l) => l.id === 10)).toBe(false);

    const del = await req('/admin/api/idp/providers/idp1', { method: 'DELETE' }, env);
    expect(del.status).toBe(200);
    expect(db.idpProviders.some((p) => p.id === 'idp1')).toBe(false);
  });
});

describe('admin E2EE keys debug', () => {
  it('reports verification status using DB sig + device key signatures', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}/keys`);
    const body = await res.json();
    expect(body.cross_signing_keys.self_signing.key_id).toBe('ed25519:ss');
    expect(body.verification_status.BOBDEVICE.verified).toBe(true);
    expect(body.verification_status.BOBDEVICE.reason).toBe('Verified');
  });

  it('explains missing self-signing key', async () => {
    const db = createAdminDb({
      crossSigningKeys: [
        {
          user_id: BOB,
          key_type: 'master',
          key_id: 'ed25519:master',
          key_data: JSON.stringify({ keys: {} }),
        },
      ],
      crossSigningSigs: [],
    });
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}/keys`,
      {},
      createEnv({ db })
    );
    const body = await res.json();
    expect(body.verification_status.BOBDEVICE.reason).toBe('No self-signing key');
  });
});

describe('Matrix whois + Synapse-compat admin routes', () => {
  it('whois allows admin for others and self for non-admin path via same mock', async () => {
    const res = await req(`/_matrix/client/v3/admin/whois/${encodeURIComponent(BOB)}`);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices.BOBDEVICE.sessions[0].connections[0].ip).toBe('5.6.7.8');
  });

  it('whois 404s unknown target', async () => {
    const res = await req(`/_matrix/client/v3/admin/whois/${encodeURIComponent('@x:example.com')}`);
    expect(res.status).toBe(404);
  });

  it('server_version + list/detail users synapse format', async () => {
    const ver = await req('/_synapse/admin/v1/server_version');
    expect((await ver.json()).server_version).toBe('tuwunel-test-0.1.0');

    const list = await req('/_synapse/admin/v2/users?limit=10&from=0&guests=false&name=bob');
    const listBody = await list.json();
    expect(listBody.users.some((u: { name: string }) => u.name === BOB)).toBe(true);

    const detail = await req(`/_synapse/admin/v2/users/${encodeURIComponent(BOB)}`);
    expect((await detail.json()).name).toBe(BOB);
  });

  it('synapse deactivate + reset_password', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const deact = await req(
      `/_synapse/admin/v1/deactivate/${encodeURIComponent(BOB)}`,
      { method: 'POST' },
      env
    );
    expect((await deact.json()).id_server_unbind_result).toBe('success');
    expect(db.users.find((u) => u.user_id === BOB)?.is_deactivated).toBe(1);

    db.users.find((u) => u.user_id === BOB)!.is_deactivated = 0;
    const reset = await req(
      `/_synapse/admin/v1/reset_password/${encodeURIComponent(BOB)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: 'Zzz1!', logout_devices: false }),
      },
      env
    );
    expect(reset.status).toBe(200);
    expect(db.users.find((u) => u.user_id === BOB)?.password_hash).toBe('hashed:Zzz1!');
  });

  it('synapse rooms list/detail/delete + destinations + event_reports', async () => {
    const list = await req('/_synapse/admin/v1/rooms?limit=10&from=0&search_term=room&order_by=joined_members&dir=b');
    const listBody = await list.json();
    expect(listBody.rooms[0].name).toBe('General');
    expect(listBody.total_rooms).toBe(1);

    const detail = await req(`/_synapse/admin/v1/rooms/${ROOM_ENC}`);
    expect((await detail.json()).join_rules).toBe('public');

    const dest = await req('/_synapse/admin/v1/federation/destinations?limit=10&from=0');
    expect((await dest.json()).destinations[0].destination).toBe('remote.example.org');

    const reports = await req(
      `/_synapse/admin/v1/event_reports?limit=10&from=0&room_id=${ROOM_ENC}&user_id=${encodeURIComponent(ADMIN)}`
    );
    expect((await reports.json()).event_reports[0].id).toBe(1);

    const db = createAdminDb();
    const env = createEnv({ db });
    const del = await req(`/_synapse/admin/v1/rooms/${ROOM_ENC}`, { method: 'DELETE' }, env);
    expect((await del.json()).kicked_users).toEqual([]);
    expect(db.rooms.some((r) => r.room_id === ROOM)).toBe(false);
  });

  it('synapse PUT user updates existing and creates new', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const upd = await req(
      `/_synapse/admin/v2/users/${encodeURIComponent(BOB)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayname: 'Bobby',
          admin: true,
          deactivated: false,
          avatar_url: 'mxc://x/y',
          password: 'New1!',
        }),
      },
      env
    );
    expect(upd.status).toBe(200);

    const create = await req(
      `/_synapse/admin/v2/users/${encodeURIComponent(CAROL)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'Carol1!', displayname: 'Carol', admin: false }),
      },
      env
    );
    expect(create.status).toBe(200);
    expect(db.users.some((u) => u.user_id === CAROL)).toBe(true);

    const noPass = await req(
      `/_synapse/admin/v2/users/${encodeURIComponent('@dave:example.com')}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayname: 'Dave' }),
      },
      env
    );
    expect(noPass.status).toBe(400);

    const badId = await req(
      '/_synapse/admin/v2/users/not-a-mxid',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'x' }),
      },
      env
    );
    expect(badId.status).toBe(400);
  });
});

describe('admin analytics endpoints', () => {
  it('request analytics supports period presets', async () => {
    const res = await req('/_matrix/client/v3/admin/analytics/requests?period=7d');
    const body = await res.json();
    expect(body.period).toBe('7d');
    expect(body.total_events).toBeGreaterThanOrEqual(1);
    expect(body.events_by_type.some((e: { event_type: string }) => e.event_type === 'm.room.message')).toBe(
      true
    );
  });

  it('federation analytics splits inbound/outbound by server name', async () => {
    const db = createAdminDb({
      events: [
        {
          event_id: '$local',
          room_id: ROOM,
          event_type: 'm.room.message',
          state_key: null,
          sender: ADMIN,
          content: '{}',
          origin_server_ts: Date.now(),
          stream_position: 1,
        },
        {
          event_id: '$remote',
          room_id: ROOM,
          event_type: 'm.room.message',
          state_key: null,
          sender: '@r:remote.example.org',
          content: '{}',
          origin_server_ts: Date.now(),
          stream_position: 2,
        },
      ],
      knownServersCount: 4,
    });
    const res = await req(
      '/_matrix/client/v3/admin/analytics/federation?period=1h',
      {},
      createEnv({ db })
    );
    const body = await res.json();
    expect(body.inbound_events).toBe(1);
    expect(body.outbound_events).toBe(1);
    expect(body.known_servers).toBe(4);
  });
});

describe('admin API bad JSON / missing params leftovers', () => {
  it('rejects bad JSON on mutating endpoints', async () => {
    const paths = [
      ['/admin/api/make-admin', 'POST'],
      ['/admin/api/remove-admin', 'POST'],
      ['/admin/api/users/create', 'POST'],
      ['/admin/api/users/bulk-delete', 'POST'],
      ['/admin/api/server-notice', 'POST'],
      ['/admin/api/idp/providers', 'POST'],
      [`/_synapse/admin/v1/reset_password/${encodeURIComponent(BOB)}`, 'POST'],
      [`/_synapse/admin/v2/users/${encodeURIComponent(BOB)}`, 'PUT'],
    ] as const;

    for (const [path, method] of paths) {
      const res = await req(path, { method, body: '{', headers: { 'Content-Type': 'application/json' } });
      expect(res.status).toBe(400);
    }
  });

  it('missing required params', async () => {
    const make = await req(
      '/admin/api/make-admin',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    );
    expect(make.status).toBe(400);

    const notice = await req(
      '/admin/api/server-notice',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: BOB }) }
    );
    expect(notice.status).toBe(400);

    const create = await req(
      '/admin/api/users/create',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'x' }) }
    );
    expect(create.status).toBe(400);
  });

  it('federation status falls back when CACHE key missing/invalid', async () => {
    const cache = mockKv({ server_signing_key: '{not-json' });
    const res = await req('/admin/api/federation/status', {}, createEnv({ cache }));
    const body = await res.json();
    expect(body.signing_key_id).toMatch(/^ed25519:a_/);

    const empty = await req('/admin/api/federation/status', {}, createEnv({ cache: mockKv() }));
    expect((await empty.json()).signing_key_id).toMatch(/^ed25519:a_/);
  });
});


describe('admin TOKENMAXX auth/whois/keys/login-token leftovers after #102', () => {
  afterEach(() => {
    authState.userId = ADMIN;
    authState.deviceId = 'ADMINDEVICE';
  });

  it('requireAdmin returns M_UNAUTHORIZED when userId is missing', async () => {
    authState.userId = undefined;
    const res = await req('/admin/api/config');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.errcode).toBe('M_UNAUTHORIZED');
    expect(body.error).toMatch(/Admin access required/);
  });

  it('whois: non-admin querying another user is forbidden', async () => {
    authState.userId = BOB;
    const res = await req(`/_matrix/client/v3/admin/whois/${encodeURIComponent(ADMIN)}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.errcode).toBe('M_FORBIDDEN');
    expect(body.error).toMatch(/Admin privileges required to query other users/);
  });

  it('whois: non-admin may query self', async () => {
    authState.userId = BOB;
    const res = await req(`/_matrix/client/v3/admin/whois/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices.BOBDEVICE.sessions[0].connections[0].ip).toBe('5.6.7.8');
  });

  it('login-token deactivated returns exact M_USER_DEACTIVATED', async () => {
    const db = createAdminDb();
    db.users.find((u) => u.user_id === BOB)!.is_deactivated = 1;
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}/login-token`,
      { method: 'POST' },
      createEnv({ db })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      errcode: 'M_USER_DEACTIVATED',
      error: 'User is deactivated',
    });
  });

  it('login-token defaults ttl to 10 minutes on missing/invalid JSON body', async () => {
    const sessions = mockKv();
    const env = createEnv({ sessions });
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}/login-token`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ttl_seconds).toBe(600);
    expect(sessions.puts[0].options?.expirationTtl).toBe(600);
  });

  it('login-token clamps ttl_minutes 0 and 0.5 up to 1 minute', async () => {
    for (const ttl of [0, 0.5]) {
      const sessions = mockKv();
      const env = createEnv({ sessions });
      const res = await req(
        `/admin/api/users/${encodeURIComponent(BOB)}/login-token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl_minutes: ttl }),
        },
        env
      );
      expect(res.status).toBe(200);
      // 0 is falsy → default 10; 0.5 is truthy number → clamp max(0.5,1)=1
      if (ttl === 0) {
        expect((await res.json()).ttl_seconds).toBe(600);
      } else {
        expect((await res.json()).ttl_seconds).toBe(60);
        expect(sessions.puts[0].options?.expirationTtl).toBe(60);
      }
    }
  });

  it('keys debug: No signature in DB when self-signing exists but sig missing', async () => {
    const db = createAdminDb({ crossSigningSigs: [] });
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}/keys`,
      {},
      createEnv({ db })
    );
    const body = await res.json();
    expect(body.verification_status.BOBDEVICE).toEqual({
      verified: false,
      reason: 'No signature in DB',
    });
  });

  it('keys debug: Signature not in device key object when DB sig present', async () => {
    const deviceKeys = mockKv({
      [`device:${BOB}:BOBDEVICE`]: JSON.stringify({
        algorithms: ['m.olm.v1.curve25519-aes-sha2'],
        device_id: 'BOBDEVICE',
        user_id: BOB,
        keys: { 'ed25519:BOBDEVICE': 'DEVKEY' },
        // signatures omit self-signing key id
        signatures: { [BOB]: { 'ed25519:other': 'sig' } },
      }),
    });
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}/keys`,
      {},
      createEnv({ deviceKeys })
    );
    const body = await res.json();
    expect(body.verification_status.BOBDEVICE).toEqual({
      verified: false,
      reason: 'Signature not in device key object',
    });
  });

  it('DELETE idp provider 404s when missing', async () => {
    const db = createAdminDb({ idpProviders: [] });
    const res = await req(
      '/admin/api/idp/providers/missing',
      { method: 'DELETE' },
      createEnv({ db })
    );
    expect(res.status).toBe(404);
    expect((await res.json()).errcode).toBe('M_NOT_FOUND');
  });

  it('idp test connection returns success:false when discovery throws', async () => {
    const db = createAdminDb({
      idpProviders: [
        {
          id: 'bad',
          name: 'Bad',
          issuer_url: 'https://bad-issuer.example',
          client_id: 'c',
          client_secret_encrypted: 'enc:s',
          scopes: 'openid',
          enabled: 1,
          auto_create_users: 0,
          username_claim: 'email',
          display_order: 0,
          icon_url: null,
          created_at: 1,
          updated_at: 1,
        },
      ],
    });
    const res = await req(
      '/admin/api/idp/providers/bad/test',
      { method: 'POST' },
      createEnv({ db })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(String(body.error)).toMatch(/discovery failed/);
  });

  it('unresolve 404s unknown report id', async () => {
    const res = await req('/admin/api/reports/999/unresolve', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('reports resolved=true filter returns only resolved rows', async () => {
    const db = createAdminDb();
    db.reports[0].resolved = 1;
    db.reports[0].resolved_by = ADMIN;
    db.reports[0].resolved_at = 99;
    const res = await req('/admin/api/reports?resolved=true', {}, createEnv({ db }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reports.length).toBeGreaterThan(0);
    for (const r of body.reports) {
      expect(r.resolved).toBeTruthy();
    }
  });

  it('server-notice with zero devices notifies 0', async () => {
    const db = createAdminDb({
      devices: [
        {
          user_id: ADMIN,
          device_id: 'ADMINDEVICE',
          display_name: 'Admin Device',
          last_seen_ts: 5_000,
          last_seen_ip: '1.2.3.4',
        },
      ],
    });
    const res = await req(
      '/admin/api/server-notice',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: BOB, message: 'Hello bob' }),
      },
      createEnv({ db })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).devices_notified).toBe(0);
    expect(db.inserts.some((i) => i.sql.includes('to_device_messages'))).toBe(false);
  });

  it('remove-admin missing user_id is M_MISSING_PARAM', async () => {
    const res = await req(
      '/admin/api/remove-admin',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).errcode).toBe('M_MISSING_PARAM');
  });

  it('synapse deactivate 404s missing user', async () => {
    const res = await req(
      `/_synapse/admin/v1/deactivate/${encodeURIComponent('@nope:example.com')}`,
      { method: 'POST' }
    );
    expect(res.status).toBe(404);
    expect((await res.json()).errcode).toBe('M_NOT_FOUND');
  });

  it('synapse reset_password defaults logout_devices true', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const before = db.tokens.filter((t) => t.user_id === BOB).length;
    expect(before).toBeGreaterThan(0);
    const res = await req(
      `/_synapse/admin/v1/reset_password/${encodeURIComponent(BOB)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: 'Zzz9!' }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(db.tokens.filter((t) => t.user_id === BOB)).toHaveLength(0);
  });

  it('federation status uses serverName first label when CACHE key has no keyId', async () => {
    const cache = mockKv({
      server_signing_key: JSON.stringify({ public_key: 'abc' }),
    });
    const res = await req('/admin/api/federation/status', {}, createEnv({ cache }));
    const body = await res.json();
    expect(body.signing_key_id).toBe('ed25519:example');
  });

  it('analytics unknown period falls back to default window but echoes period', async () => {
    const reqAnalytics = await req('/_matrix/client/v3/admin/analytics/requests?period=weird');
    expect(reqAnalytics.status).toBe(200);
    expect((await reqAnalytics.json()).period).toBe('weird');

    const fedAnalytics = await req('/_matrix/client/v3/admin/analytics/federation?period=weird');
    expect(fedAnalytics.status).toBe(200);
    expect((await fedAnalytics.json()).period).toBe('weird');
  });
});
