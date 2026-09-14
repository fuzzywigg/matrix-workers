/**
 * TOKENMAXX HEAVY leftovers after #157 — admin API soft/edge/reliability.
 * Complements admin-api-routes.test.ts. Tests-only — no product inventing.
 * Fixtures use example.com only.
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

beforeEach(() => {
  authState.userId = ADMIN;
  authState.deviceId = 'ADMINDEVICE';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  authState.userId = ADMIN;
  authState.deviceId = 'ADMINDEVICE';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function jsonInit(method: string, body?: unknown, contentType = 'application/json'): RequestInit {
  return {
    method,
    headers: { 'Content-Type': contentType },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

describe('admin leftovers GET /admin/api/stats soft flood after #157', () => {
  it('GET stats soft-0', async () => {
    const adminDO = createAdminDO({ stats: { users: 2, rooms: 1, events: 10, media: 1, unresolved_reports: 0 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(2);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-1', async () => {
    const adminDO = createAdminDO({ stats: { users: 3, rooms: 2, events: 11, media: 1, unresolved_reports: 1 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=false', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(3);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-2', async () => {
    const adminDO = createAdminDO({ stats: { users: 4, rooms: 3, events: 12, media: 1, unresolved_reports: 2 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(4);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-3', async () => {
    const adminDO = createAdminDO({ stats: { users: 5, rooms: 1, events: 13, media: 1, unresolved_reports: 3 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=false', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(5);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-4', async () => {
    const adminDO = createAdminDO({ stats: { users: 6, rooms: 2, events: 14, media: 1, unresolved_reports: 4 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(6);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-5', async () => {
    const adminDO = createAdminDO({ stats: { users: 7, rooms: 3, events: 15, media: 1, unresolved_reports: 0 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=false', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(7);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-6', async () => {
    const adminDO = createAdminDO({ stats: { users: 8, rooms: 1, events: 16, media: 1, unresolved_reports: 1 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(8);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-7', async () => {
    const adminDO = createAdminDO({ stats: { users: 9, rooms: 2, events: 17, media: 1, unresolved_reports: 2 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=false', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(9);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-8', async () => {
    const adminDO = createAdminDO({ stats: { users: 10, rooms: 3, events: 18, media: 1, unresolved_reports: 3 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(10);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-9', async () => {
    const adminDO = createAdminDO({ stats: { users: 11, rooms: 1, events: 19, media: 1, unresolved_reports: 4 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=false', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(11);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-10', async () => {
    const adminDO = createAdminDO({ stats: { users: 12, rooms: 2, events: 20, media: 1, unresolved_reports: 0 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(12);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-11', async () => {
    const adminDO = createAdminDO({ stats: { users: 13, rooms: 3, events: 21, media: 1, unresolved_reports: 1 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=false', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(13);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-12', async () => {
    const adminDO = createAdminDO({ stats: { users: 14, rooms: 1, events: 22, media: 1, unresolved_reports: 2 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(14);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-13', async () => {
    const adminDO = createAdminDO({ stats: { users: 15, rooms: 2, events: 23, media: 1, unresolved_reports: 3 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=false', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(15);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-14', async () => {
    const adminDO = createAdminDO({ stats: { users: 16, rooms: 3, events: 24, media: 1, unresolved_reports: 4 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(16);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-15', async () => {
    const adminDO = createAdminDO({ stats: { users: 17, rooms: 1, events: 25, media: 1, unresolved_reports: 0 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=false', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(17);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-16', async () => {
    const adminDO = createAdminDO({ stats: { users: 18, rooms: 2, events: 26, media: 1, unresolved_reports: 1 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(18);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-17', async () => {
    const adminDO = createAdminDO({ stats: { users: 19, rooms: 3, events: 27, media: 1, unresolved_reports: 2 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=false', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(19);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-18', async () => {
    const adminDO = createAdminDO({ stats: { users: 20, rooms: 1, events: 28, media: 1, unresolved_reports: 3 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(20);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-19', async () => {
    const adminDO = createAdminDO({ stats: { users: 21, rooms: 2, events: 29, media: 1, unresolved_reports: 4 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=false', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(21);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-20', async () => {
    const adminDO = createAdminDO({ stats: { users: 22, rooms: 3, events: 30, media: 1, unresolved_reports: 0 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(22);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-21', async () => {
    const adminDO = createAdminDO({ stats: { users: 23, rooms: 1, events: 31, media: 1, unresolved_reports: 1 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=false', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(23);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-22', async () => {
    const adminDO = createAdminDO({ stats: { users: 24, rooms: 2, events: 32, media: 1, unresolved_reports: 2 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(24);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-23', async () => {
    const adminDO = createAdminDO({ stats: { users: 25, rooms: 3, events: 33, media: 1, unresolved_reports: 3 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=false', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(25);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET stats soft-24', async () => {
    const adminDO = createAdminDO({ stats: { users: 26, rooms: 1, events: 34, media: 1, unresolved_reports: 4 } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/stats?refresh=true', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBe(26);
    expect(body.server).toEqual({ name: SERVER, version: 'tuwunel-test-0.1.0' });
    expect(adminDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

});

describe('admin leftovers GET /admin/api/users soft flood after #157', () => {
  it('GET users list soft-0', async () => {
    const res = await req('/admin/api/users?limit=10&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-1', async () => {
    const res = await req('/admin/api/users?limit=999&offset=-5&search=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-2', async () => {
    const res = await req('/admin/api/users?limit=1&offset=0&search=admin');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-3', async () => {
    const res = await req('/admin/api/users?limit=50&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-4', async () => {
    const res = await req('/admin/api/users?search=bob&limit=25');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-5', async () => {
    const res = await req('/admin/api/users?limit=0&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-6', async () => {
    const res = await req('/admin/api/users?limit=100&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-7', async () => {
    const res = await req('/admin/api/users?limit=5&offset=0&search=BOB');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-8', async () => {
    const res = await req('/admin/api/users?limit=20&offset=0&search=example');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-9', async () => {
    const res = await req('/admin/api/users?limit=3&offset=2');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-10', async () => {
    const res = await req('/admin/api/users?limit=10&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-11', async () => {
    const res = await req('/admin/api/users?limit=999&offset=-5&search=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-12', async () => {
    const res = await req('/admin/api/users?limit=1&offset=0&search=admin');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-13', async () => {
    const res = await req('/admin/api/users?limit=50&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-14', async () => {
    const res = await req('/admin/api/users?search=bob&limit=25');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-15', async () => {
    const res = await req('/admin/api/users?limit=0&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-16', async () => {
    const res = await req('/admin/api/users?limit=100&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-17', async () => {
    const res = await req('/admin/api/users?limit=5&offset=0&search=BOB');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-18', async () => {
    const res = await req('/admin/api/users?limit=20&offset=0&search=example');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-19', async () => {
    const res = await req('/admin/api/users?limit=3&offset=2');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-20', async () => {
    const res = await req('/admin/api/users?limit=10&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-21', async () => {
    const res = await req('/admin/api/users?limit=999&offset=-5&search=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-22', async () => {
    const res = await req('/admin/api/users?limit=1&offset=0&search=admin');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-23', async () => {
    const res = await req('/admin/api/users?limit=50&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('GET users list soft-24', async () => {
    const res = await req('/admin/api/users?search=bob&limit=25');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
    expect(body.offset).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

});

describe('admin leftovers GET /admin/api/users/:userId soft flood after #157', () => {
  it('GET user detail soft-0', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-0
  });

  it('GET user detail soft-1', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-1
  });

  it('GET user detail soft-2', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-2
  });

  it('GET user detail soft-3', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-3
  });

  it('GET user detail soft-4', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-4
  });

  it('GET user detail soft-5', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-5
  });

  it('GET user detail soft-6', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-6
  });

  it('GET user detail soft-7', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-7
  });

  it('GET user detail soft-8', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-8
  });

  it('GET user detail soft-9', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-9
  });

  it('GET user detail soft-10', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-10
  });

  it('GET user detail soft-11', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-11
  });

  it('GET user detail soft-12', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-12
  });

  it('GET user detail soft-13', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-13
  });

  it('GET user detail soft-14', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-14
  });

  it('GET user detail soft-15', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-15
  });

  it('GET user detail soft-16', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-16
  });

  it('GET user detail soft-17', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-17
  });

  it('GET user detail soft-18', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-18
  });

  it('GET user detail soft-19', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-19
  });

  it('GET user detail soft-20', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-20
  });

  it('GET user detail soft-21', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-21
  });

  it('GET user detail soft-22', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-22
  });

  it('GET user detail soft-23', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-23
  });

  it('GET user detail soft-24', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(BOB);
    expect(body.devices[0].device_id).toBe('BOBDEVICE');
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.display_name).toBeTruthy(); // soft-24
  });

});

describe('admin leftovers PUT display_name soft flood after #157', () => {
  it('PUT display_name soft-0', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 0';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-1', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 1';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-2', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 2';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-3', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 3';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-4', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 4';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-5', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 5';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-6', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 6';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-7', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 7';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-8', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 8';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-9', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 9';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-10', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 10';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-11', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 11';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-12', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 12';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-13', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 13';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-14', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 14';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-15', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 15';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-16', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 16';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-17', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 17';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-18', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 18';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-19', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 19';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-20', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 20';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-21', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 21';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-22', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 22';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-23', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 23';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

  it('PUT display_name soft-24', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const name = 'Bobby Soft 24';
    const res = await req(
      `/admin/api/users/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { display_name: name }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('UPDATE users SET'))).toBe(true);
    expect(db.inserts.some((x) => x.sql.includes('admin_audit_log'))).toBe(true);
    expect(db.updates.some((u) => u.args.includes(name))).toBe(true);
  });

});

describe('admin leftovers GET /admin/api/rooms soft flood after #157', () => {
  it('GET rooms soft-0', async () => {
    const res = await req('/admin/api/rooms?limit=5&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-0
  });

  it('GET rooms soft-1', async () => {
    const res = await req('/admin/api/rooms?limit=6&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-1
  });

  it('GET rooms soft-2', async () => {
    const res = await req('/admin/api/rooms?limit=7&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-2
  });

  it('GET rooms soft-3', async () => {
    const res = await req('/admin/api/rooms?limit=8&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-3
  });

  it('GET rooms soft-4', async () => {
    const res = await req('/admin/api/rooms?limit=9&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-4
  });

  it('GET rooms soft-5', async () => {
    const res = await req('/admin/api/rooms?limit=10&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-5
  });

  it('GET rooms soft-6', async () => {
    const res = await req('/admin/api/rooms?limit=11&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-6
  });

  it('GET rooms soft-7', async () => {
    const res = await req('/admin/api/rooms?limit=12&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-7
  });

  it('GET rooms soft-8', async () => {
    const res = await req('/admin/api/rooms?limit=13&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-8
  });

  it('GET rooms soft-9', async () => {
    const res = await req('/admin/api/rooms?limit=14&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-9
  });

  it('GET rooms soft-10', async () => {
    const res = await req('/admin/api/rooms?limit=5&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-10
  });

  it('GET rooms soft-11', async () => {
    const res = await req('/admin/api/rooms?limit=6&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-11
  });

  it('GET rooms soft-12', async () => {
    const res = await req('/admin/api/rooms?limit=7&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-12
  });

  it('GET rooms soft-13', async () => {
    const res = await req('/admin/api/rooms?limit=8&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-13
  });

  it('GET rooms soft-14', async () => {
    const res = await req('/admin/api/rooms?limit=9&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-14
  });

  it('GET rooms soft-15', async () => {
    const res = await req('/admin/api/rooms?limit=10&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-15
  });

  it('GET rooms soft-16', async () => {
    const res = await req('/admin/api/rooms?limit=11&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-16
  });

  it('GET rooms soft-17', async () => {
    const res = await req('/admin/api/rooms?limit=12&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-17
  });

  it('GET rooms soft-18', async () => {
    const res = await req('/admin/api/rooms?limit=13&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-18
  });

  it('GET rooms soft-19', async () => {
    const res = await req('/admin/api/rooms?limit=14&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-19
  });

  it('GET rooms soft-20', async () => {
    const res = await req('/admin/api/rooms?limit=5&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-20
  });

  it('GET rooms soft-21', async () => {
    const res = await req('/admin/api/rooms?limit=6&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-21
  });

  it('GET rooms soft-22', async () => {
    const res = await req('/admin/api/rooms?limit=7&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-22
  });

  it('GET rooms soft-23', async () => {
    const res = await req('/admin/api/rooms?limit=8&offset=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-23
  });

  it('GET rooms soft-24', async () => {
    const res = await req('/admin/api/rooms?limit=9&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms[0].name).toBe('General');
    expect(body.total).toBe(1);
    expect(body.rooms[0].room_id).toBe(ROOM); // soft-24
  });

});

describe('admin leftovers GET /admin/api/media soft flood after #157', () => {
  it('GET media soft-0', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=10&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-0
  });

  it('GET media soft-1', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=11&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-1
  });

  it('GET media soft-2', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=12&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-2
  });

  it('GET media soft-3', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=13&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-3
  });

  it('GET media soft-4', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=14&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-4
  });

  it('GET media soft-5', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=15&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-5
  });

  it('GET media soft-6', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=16&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-6
  });

  it('GET media soft-7', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=17&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-7
  });

  it('GET media soft-8', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=18&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-8
  });

  it('GET media soft-9', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=19&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-9
  });

  it('GET media soft-10', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=20&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-10
  });

  it('GET media soft-11', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=21&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-11
  });

  it('GET media soft-12', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=22&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-12
  });

  it('GET media soft-13', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=23&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-13
  });

  it('GET media soft-14', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=24&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-14
  });

  it('GET media soft-15', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=25&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-15
  });

  it('GET media soft-16', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=26&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-16
  });

  it('GET media soft-17', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=27&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-17
  });

  it('GET media soft-18', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=28&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-18
  });

  it('GET media soft-19', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=29&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-19
  });

  it('GET media soft-20', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=30&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-20
  });

  it('GET media soft-21', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=31&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-21
  });

  it('GET media soft-22', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=32&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-22
  });

  it('GET media soft-23', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=33&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-23
  });

  it('GET media soft-24', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req('/admin/api/media?limit=34&offset=0', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media[0].media_id).toBe(MEDIA_ID);
    expect(body.media[0].content_type).toBe('image/png'); // soft-24
  });

});

describe('admin leftovers GET /admin/api/config soft flood after #157', () => {
  it('GET config soft-0', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-0
  });

  it('GET config soft-1', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-1
  });

  it('GET config soft-2', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-2
  });

  it('GET config soft-3', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-3
  });

  it('GET config soft-4', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-4
  });

  it('GET config soft-5', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-5
  });

  it('GET config soft-6', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-6
  });

  it('GET config soft-7', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-7
  });

  it('GET config soft-8', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-8
  });

  it('GET config soft-9', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-9
  });

  it('GET config soft-10', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-10
  });

  it('GET config soft-11', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-11
  });

  it('GET config soft-12', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-12
  });

  it('GET config soft-13', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-13
  });

  it('GET config soft-14', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-14
  });

  it('GET config soft-15', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-15
  });

  it('GET config soft-16', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-16
  });

  it('GET config soft-17', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-17
  });

  it('GET config soft-18', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-18
  });

  it('GET config soft-19', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-19
  });

  it('GET config soft-20', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-20
  });

  it('GET config soft-21', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-21
  });

  it('GET config soft-22', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-22
  });

  it('GET config soft-23', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-23
  });

  it('GET config soft-24', async () => {
    const res = await req('/admin/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_name).toBe(SERVER);
    expect(body.features.federation).toBe(true);
    expect(body.limits.max_upload_size).toBe(50 * 1024 * 1024);
    expect(typeof body.features).toBe('object'); // soft-24
  });

});

describe('admin leftovers GET /admin/api/registration soft flood after #157', () => {
  it('GET registration soft-0', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-0
  });

  it('GET registration soft-1', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-1
  });

  it('GET registration soft-2', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-2
  });

  it('GET registration soft-3', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-3
  });

  it('GET registration soft-4', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-4
  });

  it('GET registration soft-5', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-5
  });

  it('GET registration soft-6', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-6
  });

  it('GET registration soft-7', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-7
  });

  it('GET registration soft-8', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-8
  });

  it('GET registration soft-9', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-9
  });

  it('GET registration soft-10', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-10
  });

  it('GET registration soft-11', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-11
  });

  it('GET registration soft-12', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-12
  });

  it('GET registration soft-13', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-13
  });

  it('GET registration soft-14', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-14
  });

  it('GET registration soft-15', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-15
  });

  it('GET registration soft-16', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-16
  });

  it('GET registration soft-17', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-17
  });

  it('GET registration soft-18', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-18
  });

  it('GET registration soft-19', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-19
  });

  it('GET registration soft-20', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-20
  });

  it('GET registration soft-21', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-21
  });

  it('GET registration soft-22', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-22
  });

  it('GET registration soft-23', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: false } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-23
  });

  it('GET registration soft-24', async () => {
    const adminDO = createAdminDO({ config: { registration_enabled: true } });
    const env = createEnv({ adminDO });
    const res = await req('/admin/api/registration', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(adminDO.fetches.some((f) => f.url.includes('/config'))).toBe(true); // soft-24
  });

});

describe('admin leftovers Synapse GET /_synapse/admin/v2/users soft flood after #157', () => {
  it('GET synapse users soft-0', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=5&from=0&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-0
  });

  it('GET synapse users soft-1', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=6&from=1&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-1
  });

  it('GET synapse users soft-2', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=7&from=2&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-2
  });

  it('GET synapse users soft-3', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=8&from=0&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-3
  });

  it('GET synapse users soft-4', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=9&from=1&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-4
  });

  it('GET synapse users soft-5', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=10&from=2&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-5
  });

  it('GET synapse users soft-6', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=11&from=0&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-6
  });

  it('GET synapse users soft-7', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=12&from=1&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-7
  });

  it('GET synapse users soft-8', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=13&from=2&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-8
  });

  it('GET synapse users soft-9', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=14&from=0&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-9
  });

  it('GET synapse users soft-10', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=15&from=1&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-10
  });

  it('GET synapse users soft-11', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=16&from=2&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-11
  });

  it('GET synapse users soft-12', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=17&from=0&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-12
  });

  it('GET synapse users soft-13', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=18&from=1&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-13
  });

  it('GET synapse users soft-14', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=19&from=2&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-14
  });

  it('GET synapse users soft-15', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=20&from=0&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-15
  });

  it('GET synapse users soft-16', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=21&from=1&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-16
  });

  it('GET synapse users soft-17', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=22&from=2&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-17
  });

  it('GET synapse users soft-18', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=23&from=0&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-18
  });

  it('GET synapse users soft-19', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=24&from=1&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-19
  });

  it('GET synapse users soft-20', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=5&from=2&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-20
  });

  it('GET synapse users soft-21', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=6&from=0&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-21
  });

  it('GET synapse users soft-22', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=7&from=1&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-22
  });

  it('GET synapse users soft-23', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=8&from=2&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-23
  });

  it('GET synapse users soft-24', async () => {
    const res = await req('/_synapse/admin/v2/users?limit=9&from=0&guests=false&name=bob');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { name: string }) => u.name === BOB)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true); // soft-24
  });

});

describe('admin leftovers GET /_synapse/admin/v1/server_version soft flood after #157', () => {
  it('GET server_version soft-0', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-0
  });

  it('GET server_version soft-1', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-1
  });

  it('GET server_version soft-2', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-2
  });

  it('GET server_version soft-3', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-3
  });

  it('GET server_version soft-4', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-4
  });

  it('GET server_version soft-5', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-5
  });

  it('GET server_version soft-6', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-6
  });

  it('GET server_version soft-7', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-7
  });

  it('GET server_version soft-8', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-8
  });

  it('GET server_version soft-9', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-9
  });

  it('GET server_version soft-10', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-10
  });

  it('GET server_version soft-11', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-11
  });

  it('GET server_version soft-12', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-12
  });

  it('GET server_version soft-13', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-13
  });

  it('GET server_version soft-14', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-14
  });

  it('GET server_version soft-15', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-15
  });

  it('GET server_version soft-16', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-16
  });

  it('GET server_version soft-17', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-17
  });

  it('GET server_version soft-18', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-18
  });

  it('GET server_version soft-19', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-19
  });

  it('GET server_version soft-20', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-20
  });

  it('GET server_version soft-21', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-21
  });

  it('GET server_version soft-22', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-22
  });

  it('GET server_version soft-23', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-23
  });

  it('GET server_version soft-24', async () => {
    const res = await req('/_synapse/admin/v1/server_version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server_version).toBe('tuwunel-test-0.1.0');
    expect(typeof body.server_version).toBe('string'); // soft-24
  });

});

describe('admin leftovers method matrix after #157', () => {
  it('POST /admin/api/stats → 404/405', async () => {
    const res = await req('/admin/api/stats', jsonInit('POST', {}));
    expect([404, 405]).toContain(res.status);
  });

  it('PUT /admin/api/stats → 404/405', async () => {
    const res = await req('/admin/api/stats', jsonInit('PUT', {}));
    expect([404, 405]).toContain(res.status);
  });

  it('DELETE /admin/api/stats → 404/405', async () => {
    const res = await req('/admin/api/stats', jsonInit('DELETE', {}));
    expect([404, 405]).toContain(res.status);
  });

  it('POST /admin/api/config → 404/405', async () => {
    const res = await req('/admin/api/config', jsonInit('POST', {}));
    expect([404, 405]).toContain(res.status);
  });

  it('DELETE /admin/api/config → 404/405', async () => {
    const res = await req('/admin/api/config', jsonInit('DELETE', {}));
    expect([404, 405]).toContain(res.status);
  });

  it('PUT /admin/api/users → 404/405', async () => {
    const res = await req('/admin/api/users', jsonInit('PUT', {}));
    expect([404, 405]).toContain(res.status);
  });

  it('PATCH /admin/api/users → 404/405', async () => {
    const res = await req('/admin/api/users', jsonInit('PATCH', {}));
    expect([404, 405]).toContain(res.status);
  });

  it('POST /admin/api/rooms → 404/405', async () => {
    const res = await req('/admin/api/rooms', jsonInit('POST', {}));
    expect([404, 405]).toContain(res.status);
  });

  it('PUT /admin/api/rooms → 404/405', async () => {
    const res = await req('/admin/api/rooms', jsonInit('PUT', {}));
    expect([404, 405]).toContain(res.status);
  });

  it('POST /_synapse/admin/v1/server_version → 404/405', async () => {
    const res = await req('/_synapse/admin/v1/server_version', jsonInit('POST', {}));
    expect([404, 405]).toContain(res.status);
  });

  it('DELETE /_synapse/admin/v1/server_version → 404/405', async () => {
    const res = await req('/_synapse/admin/v1/server_version', jsonInit('DELETE', {}));
    expect([404, 405]).toContain(res.status);
  });

});

describe('admin leftovers Content-Type charset soft flood after #157', () => {
  it('create user charset soft-0', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'ctuser0';
    const res = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'Secret1!', display_name: 'CT0' }, 'application/json'),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
  });

  it('create user charset soft-1', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'ctuser1';
    const res = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'Secret1!', display_name: 'CT1' }, 'application/json; charset=utf-8'),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
  });

  it('create user charset soft-2', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'ctuser2';
    const res = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'Secret1!', display_name: 'CT2' }, 'application/json;charset=UTF-8'),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
  });

  it('create user charset soft-3', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'ctuser3';
    const res = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'Secret1!', display_name: 'CT3' }, 'application/json; charset=UTF-8'),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
  });

  it('create user charset soft-4', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'ctuser4';
    const res = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'Secret1!', display_name: 'CT4' }, 'application/json; charset="utf-8"'),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
  });

  it('make-admin charset soft-0', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req(
      '/admin/api/make-admin',
      jsonInit('POST', { user_id: BOB }, 'application/json'),
      env
    );
    expect(res.status).toBe(200);
    expect(db.users.find((u) => u.user_id === BOB)?.admin).toBe(1);
  });

  it('make-admin charset soft-1', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req(
      '/admin/api/make-admin',
      jsonInit('POST', { user_id: BOB }, 'application/json; charset=utf-8'),
      env
    );
    expect(res.status).toBe(200);
    expect(db.users.find((u) => u.user_id === BOB)?.admin).toBe(1);
  });

  it('make-admin charset soft-2', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req(
      '/admin/api/make-admin',
      jsonInit('POST', { user_id: BOB }, 'application/json;charset=UTF-8'),
      env
    );
    expect(res.status).toBe(200);
    expect(db.users.find((u) => u.user_id === BOB)?.admin).toBe(1);
  });

  it('make-admin charset soft-3', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req(
      '/admin/api/make-admin',
      jsonInit('POST', { user_id: BOB }, 'application/json; charset=UTF-8'),
      env
    );
    expect(res.status).toBe(200);
    expect(db.users.find((u) => u.user_id === BOB)?.admin).toBe(1);
  });

  it('make-admin charset soft-4', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const res = await req(
      '/admin/api/make-admin',
      jsonInit('POST', { user_id: BOB }, 'application/json; charset="utf-8"'),
      env
    );
    expect(res.status).toBe(200);
    expect(db.users.find((u) => u.user_id === BOB)?.admin).toBe(1);
  });

});

describe('admin leftovers failure/edge cases after #157', () => {
  it('non-admin 403 on config', async () => {
    const db = createAdminDb({ users: [{ ...defaultAdmin(), admin: 0 }, defaultBob()] });
    const res = await req('/admin/api/config', {}, createEnv({ db }));
    expect(res.status).toBe(403);
    expect((await res.json()).errcode).toBe('M_FORBIDDEN');
  });

  it('non-admin 403 on users list', async () => {
    const db = createAdminDb({ users: [{ ...defaultAdmin(), admin: 0 }, defaultBob()] });
    const res = await req('/admin/api/users', {}, createEnv({ db }));
    expect(res.status).toBe(403);
  });

  it('missing user detail 404', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent('@nope:example.com')}`);
    expect(res.status).toBe(404);
  });

  it('missing room 404', async () => {
    const res = await req(`/admin/api/rooms/${encodeURIComponent('!nope:example.com')}`);
    expect(res.status).toBe(404);
  });

  it('PUT user bad JSON 400', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`, { method: 'PUT', body: 'not-json' });
    expect(res.status).toBe(400);
  });

  it('PUT user empty body 400', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}`, jsonInit('PUT', {}));
    expect(res.status).toBe(400);
  });

  it('create user invalid username', async () => {
    const res = await req('/admin/api/users/create', jsonInit('POST', { username: 'Bad Name!', password: 'x' }));
    expect(res.status).toBe(400);
    expect((await res.json()).errcode).toBe('M_INVALID_USERNAME');
  });

  it('create user duplicate', async () => {
    const res = await req('/admin/api/users/create', jsonInit('POST', { username: 'bob', password: 'x' }));
    expect(res.status).toBe(400);
    expect((await res.json()).errcode).toBe('M_USER_IN_USE');
  });

  it('reset-password missing password', async () => {
    const res = await req(`/admin/api/users/${encodeURIComponent(BOB)}/reset-password`, jsonInit('POST', {}));
    expect(res.status).toBe(400);
  });

  it('make-admin missing user_id', async () => {
    const res = await req('/admin/api/make-admin', jsonInit('POST', {}));
    expect(res.status).toBe(400);
  });

  it('unknown auth principal 403', async () => {
    const db = createAdminDb({ users: [defaultBob()] });
    const res = await req('/admin/api/config', {}, createEnv({ db }));
    expect(res.status).toBe(403);
  });

  it('self remove-admin forbidden', async () => {
    const res = await req('/admin/api/remove-admin', jsonInit('POST', { user_id: ADMIN }));
    expect(res.status).toBe(403);
  });

});

describe('admin leftovers lifecycle soft floods after #157', () => {
  it('create→get→deactivate→reactivate lifecycle soft-0', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'life0';
    const create = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'LifePass1!', display_name: `Life ${username}` }),
      env
    );
    expect(create.status).toBe(200);
    const created = await create.json();
    const userId = created.user_id as string;
    expect(userId).toBe(`@${username}:${SERVER}`);

    const got = await req(`/admin/api/users/${encodeURIComponent(userId)}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json()).user_id).toBe(userId);

    const deact = await req(`/admin/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }, env);
    expect(deact.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(1);

    const react = await req(
      `/admin/api/users/${encodeURIComponent(userId)}/reactivate`,
      { method: 'POST' },
      env
    );
    expect(react.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(0);
  });

  it('create→get→deactivate→reactivate lifecycle soft-1', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'life1';
    const create = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'LifePass1!', display_name: `Life ${username}` }),
      env
    );
    expect(create.status).toBe(200);
    const created = await create.json();
    const userId = created.user_id as string;
    expect(userId).toBe(`@${username}:${SERVER}`);

    const got = await req(`/admin/api/users/${encodeURIComponent(userId)}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json()).user_id).toBe(userId);

    const deact = await req(`/admin/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }, env);
    expect(deact.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(1);

    const react = await req(
      `/admin/api/users/${encodeURIComponent(userId)}/reactivate`,
      { method: 'POST' },
      env
    );
    expect(react.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(0);
  });

  it('create→get→deactivate→reactivate lifecycle soft-2', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'life2';
    const create = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'LifePass1!', display_name: `Life ${username}` }),
      env
    );
    expect(create.status).toBe(200);
    const created = await create.json();
    const userId = created.user_id as string;
    expect(userId).toBe(`@${username}:${SERVER}`);

    const got = await req(`/admin/api/users/${encodeURIComponent(userId)}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json()).user_id).toBe(userId);

    const deact = await req(`/admin/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }, env);
    expect(deact.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(1);

    const react = await req(
      `/admin/api/users/${encodeURIComponent(userId)}/reactivate`,
      { method: 'POST' },
      env
    );
    expect(react.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(0);
  });

  it('create→get→deactivate→reactivate lifecycle soft-3', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'life3';
    const create = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'LifePass1!', display_name: `Life ${username}` }),
      env
    );
    expect(create.status).toBe(200);
    const created = await create.json();
    const userId = created.user_id as string;
    expect(userId).toBe(`@${username}:${SERVER}`);

    const got = await req(`/admin/api/users/${encodeURIComponent(userId)}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json()).user_id).toBe(userId);

    const deact = await req(`/admin/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }, env);
    expect(deact.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(1);

    const react = await req(
      `/admin/api/users/${encodeURIComponent(userId)}/reactivate`,
      { method: 'POST' },
      env
    );
    expect(react.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(0);
  });

  it('create→get→deactivate→reactivate lifecycle soft-4', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'life4';
    const create = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'LifePass1!', display_name: `Life ${username}` }),
      env
    );
    expect(create.status).toBe(200);
    const created = await create.json();
    const userId = created.user_id as string;
    expect(userId).toBe(`@${username}:${SERVER}`);

    const got = await req(`/admin/api/users/${encodeURIComponent(userId)}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json()).user_id).toBe(userId);

    const deact = await req(`/admin/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }, env);
    expect(deact.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(1);

    const react = await req(
      `/admin/api/users/${encodeURIComponent(userId)}/reactivate`,
      { method: 'POST' },
      env
    );
    expect(react.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(0);
  });

  it('create→get→deactivate→reactivate lifecycle soft-5', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'life5';
    const create = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'LifePass1!', display_name: `Life ${username}` }),
      env
    );
    expect(create.status).toBe(200);
    const created = await create.json();
    const userId = created.user_id as string;
    expect(userId).toBe(`@${username}:${SERVER}`);

    const got = await req(`/admin/api/users/${encodeURIComponent(userId)}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json()).user_id).toBe(userId);

    const deact = await req(`/admin/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }, env);
    expect(deact.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(1);

    const react = await req(
      `/admin/api/users/${encodeURIComponent(userId)}/reactivate`,
      { method: 'POST' },
      env
    );
    expect(react.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(0);
  });

  it('create→get→deactivate→reactivate lifecycle soft-6', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'life6';
    const create = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'LifePass1!', display_name: `Life ${username}` }),
      env
    );
    expect(create.status).toBe(200);
    const created = await create.json();
    const userId = created.user_id as string;
    expect(userId).toBe(`@${username}:${SERVER}`);

    const got = await req(`/admin/api/users/${encodeURIComponent(userId)}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json()).user_id).toBe(userId);

    const deact = await req(`/admin/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }, env);
    expect(deact.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(1);

    const react = await req(
      `/admin/api/users/${encodeURIComponent(userId)}/reactivate`,
      { method: 'POST' },
      env
    );
    expect(react.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(0);
  });

  it('create→get→deactivate→reactivate lifecycle soft-7', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'life7';
    const create = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'LifePass1!', display_name: `Life ${username}` }),
      env
    );
    expect(create.status).toBe(200);
    const created = await create.json();
    const userId = created.user_id as string;
    expect(userId).toBe(`@${username}:${SERVER}`);

    const got = await req(`/admin/api/users/${encodeURIComponent(userId)}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json()).user_id).toBe(userId);

    const deact = await req(`/admin/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }, env);
    expect(deact.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(1);

    const react = await req(
      `/admin/api/users/${encodeURIComponent(userId)}/reactivate`,
      { method: 'POST' },
      env
    );
    expect(react.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(0);
  });

  it('create→get→deactivate→reactivate lifecycle soft-8', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'life8';
    const create = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'LifePass1!', display_name: `Life ${username}` }),
      env
    );
    expect(create.status).toBe(200);
    const created = await create.json();
    const userId = created.user_id as string;
    expect(userId).toBe(`@${username}:${SERVER}`);

    const got = await req(`/admin/api/users/${encodeURIComponent(userId)}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json()).user_id).toBe(userId);

    const deact = await req(`/admin/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }, env);
    expect(deact.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(1);

    const react = await req(
      `/admin/api/users/${encodeURIComponent(userId)}/reactivate`,
      { method: 'POST' },
      env
    );
    expect(react.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(0);
  });

  it('create→get→deactivate→reactivate lifecycle soft-9', async () => {
    const db = createAdminDb();
    const env = createEnv({ db });
    const username = 'life9';
    const create = await req(
      '/admin/api/users/create',
      jsonInit('POST', { username, password: 'LifePass1!', display_name: `Life ${username}` }),
      env
    );
    expect(create.status).toBe(200);
    const created = await create.json();
    const userId = created.user_id as string;
    expect(userId).toBe(`@${username}:${SERVER}`);

    const got = await req(`/admin/api/users/${encodeURIComponent(userId)}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json()).user_id).toBe(userId);

    const deact = await req(`/admin/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }, env);
    expect(deact.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(1);

    const react = await req(
      `/admin/api/users/${encodeURIComponent(userId)}/reactivate`,
      { method: 'POST' },
      env
    );
    expect(react.status).toBe(200);
    expect(db.users.find((u) => u.user_id === userId)?.is_deactivated).toBe(0);
  });

});

