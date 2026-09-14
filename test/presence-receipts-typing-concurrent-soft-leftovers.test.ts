/**
 * TOKENMAXX HEAVY leftovers after tip past #294/#295 — presence + receipts +
 * typing *first concurrent soft-fail∥success* wave under Promise.all.
 *
 * Existing presence/receipts/typing concurrent leftovers race TOCTOU success
 * paths (D1/KV/DO barriers) but never bind exact soft error: strings under
 * Promise.all (grep Cannot set presence for other users / Invalid presence
 * state / User not found / Cannot set typing status / Invalid receipt type /
 * Not a member of this room / Missing required parameter: typing in
 * *presence*concurrent* / *receipts*concurrent* / *typing*concurrent* = 0).
 *
 * Soft sequential floods live in *-api-routes / *-route-leftovers. This file
 * claims soft ∥ sibling success races only.
 *
 * Avoided siblings claimed by open drafts #299 turn / #300 oauth-devices-crypto
 * and saturated room-cache/crypto/filters/devices/admin/fed. Complements
 * media-api-concurrent-race-leftovers (media niche twin).
 *
 * New file. Tests-only. example.com fixtures only. Reversible by delete.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import presenceApp from '../src/api/presence';
import receiptsApp from '../src/api/receipts';
import typingApp from '../src/api/typing';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!r:example.com';
const ROOM2 = '!r2:example.com';
const SERVER = 'example.com';
const USER_ENC = encodeURIComponent(USER);
const BOB_ENC = encodeURIComponent(BOB);
const ROOM_ENC = encodeURIComponent(ROOM);
const ROOM2_ENC = encodeURIComponent(ROOM2);
const NOW = 1_700_000_000_000;
const AUTH = { Authorization: 'Bearer test-token' };

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type PresenceRow = {
  user_id: string;
  presence: string;
  status_msg: string | null;
  last_active_ts: number;
};
type Membership = { room_id: string; user_id: string; membership: string };
type SqlCall = { sql: string; args: unknown[] };
type RoomFetch = { url: string; method: string; body?: unknown };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  return {
    data,
    puts,
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
      delete data[key];
    },
  } as unknown as KVNamespace & { data: Record<string, string>; puts: KvPut[] };
}

function createFederationStub() {
  return {
    async fetch(_req: Request): Promise<Response> {
      return Response.json({ ok: true });
    },
  };
}

function createRoomDOStub() {
  const fetches: RoomFetch[] = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      fetches.push({ url: req.url, method: req.method, body });
      if (req.method === 'GET' && req.url.includes('/typing')) {
        return Response.json({ user_ids: [] });
      }
      return Response.json({ ok: true });
    },
  };
}

type RoomDOStub = ReturnType<typeof createRoomDOStub>;

function createSharedDb(opts: {
  users?: string[];
  presence?: PresenceRow[];
  memberships?: Membership[];
} = {}) {
  const users = new Set(opts.users ?? [USER, BOB]);
  const presence = opts.presence ?? [];
  const memberships = opts.memberships ?? [
    { room_id: ROOM, user_id: USER, membership: 'join' },
  ];
  const inserts: SqlCall[] = [];
  const runs: SqlCall[] = [];

  return {
    users,
    presence,
    memberships,
    inserts,
    runs,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT user_id FROM users WHERE user_id = ?')) {
                const userId = args[0] as string;
                return (users.has(userId) ? { user_id: userId } : null) as T;
              }
              if (
                sql.includes('FROM presence') &&
                sql.includes('WHERE user_id = ?') &&
                !sql.includes('INSERT')
              ) {
                const userId = args[0] as string;
                const row = presence.find((p) => p.user_id === userId);
                if (!row) return null;
                return {
                  presence: row.presence,
                  status_msg: row.status_msg,
                  last_active_ts: row.last_active_ts,
                } as T;
              }
              if (
                sql.includes('SELECT membership FROM room_memberships') &&
                sql.includes('room_id') &&
                sql.includes('user_id')
              ) {
                const roomId = args[0] as string;
                const userId = args[1] as string;
                const m = memberships.find(
                  (row) => row.room_id === roomId && row.user_id === userId
                );
                return (m ? { membership: m.membership } : null) as T;
              }
              return null;
            },
            async all<T>() {
              if (
                sql.includes('SUBSTR(rm2.user_id') &&
                sql.includes('room_memberships rm1')
              ) {
                return { results: [] as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              runs.push({ sql, args });
              if (sql.includes('INSERT INTO presence')) {
                inserts.push({ sql, args });
                const [userId, presenceState, statusMsg, lastActiveTs] = args as [
                  string,
                  string,
                  string | null,
                  number,
                ];
                const idx = presence.findIndex((p) => p.user_id === userId);
                const row: PresenceRow = {
                  user_id: userId,
                  presence: presenceState,
                  status_msg: statusMsg,
                  last_active_ts: lastActiveTs,
                };
                if (idx >= 0) presence[idx] = row;
                else presence.push(row);
                return { success: true, meta: { changes: 1, last_row_id: 1 } };
              }
              if (sql.includes('INSERT INTO account_data')) {
                inserts.push({ sql, args });
                return { success: true, meta: { changes: 1, last_row_id: 1 } };
              }
              if (sql.includes('UPDATE presence SET last_active_ts')) {
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              return { success: true, meta: { changes: 0, last_row_id: 0 } };
            },
          };
        },
      };
    },
  };
}

type SharedDb = ReturnType<typeof createSharedDb>;

function createEnv(opts: {
  db?: SharedDb;
  cache?: ReturnType<typeof mockKv>;
  roomDO?: RoomDOStub;
  roomById?: Record<string, RoomDOStub>;
} = {}) {
  const db = opts.db ?? createSharedDb();
  const cache = opts.cache ?? mockKv();
  const federation = createFederationStub();
  const defaultDO = opts.roomDO ?? createRoomDOStub();
  const roomById = opts.roomById ?? {};

  return {
    DB: db as unknown as D1Database,
    CACHE: cache,
    SERVER_NAME: SERVER,
    FEDERATION: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => federation,
    },
    ROOMS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: (id: { name: string }) => roomById[id.name] ?? defaultDO,
    },
    _db: db,
    _cache: cache,
    _roomDO: defaultDO,
  } as unknown as Env & {
    _db: SharedDb;
    _cache: ReturnType<typeof mockKv>;
    _roomDO: RoomDOStub;
  };
}

async function reqApp(
  app: typeof presenceApp,
  path: string,
  init: RequestInit,
  env: Env
): Promise<{ status: number; body: any; text: string }> {
  const res = await app.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: any = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text };
}

function presenceReq(path: string, init: RequestInit = {}, env: Env = createEnv()) {
  return reqApp(presenceApp, path, init, env);
}
function receiptsReq(path: string, init: RequestInit = {}, env: Env = createEnv()) {
  return reqApp(receiptsApp, path, init, env);
}
function typingReq(path: string, init: RequestInit = {}, env: Env = createEnv()) {
  return reqApp(typingApp, path, init, env);
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...AUTH },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function softBody(results: Array<{ status: number; body: any }>, status: number) {
  return results.find((r) => r.status === status)!;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Presence softs ∥ success
// ---------------------------------------------------------------------------

describe('presence concurrent Cannot set presence for other users ∥ own PUT after tip', () => {
  it('PUT bob ∥ PUT alice — exact Cannot set presence for other users', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${BOB_ENC}/status`,
        jsonInit('PUT', { presence: 'online' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'online', status_msg: 'ok' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot set presence for other users',
    });
    expect(softBody(results, 200).body).toEqual({});
    expect(env._db.presence.some((p) => p.user_id === USER && p.presence === 'online')).toBe(
      true
    );
  });

  for (let i = 0; i < 6; i++) {
    it(`other-user presence soft flood-${i}`, async () => {
      const env = createEnv();
      const state = i % 2 === 0 ? 'online' : 'unavailable';
      const results = await Promise.all([
        presenceReq(
          `/_matrix/client/v3/presence/${BOB_ENC}/status`,
          jsonInit('PUT', { presence: state }),
          env
        ),
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: state }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 403]);
      expect(softBody(results, 403).body.error).toBe('Cannot set presence for other users');
    });
  }
});

describe('presence concurrent Invalid presence state ∥ valid PUT after tip', () => {
  it('busy ∥ online — binds Invalid presence state under Promise.all', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'busy' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'online' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    const bad = softBody(results, 400);
    expect(bad.body.errcode).toBe('M_INVALID_PARAM');
    expect(String(bad.body.error)).toContain('Invalid presence state');
    expect(String(bad.body.error)).toContain('busy');
    expect(String(bad.body.error)).toContain('online');
  });

  it('badJson ∥ valid under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{not-json',
        },
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'unavailable' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(softBody(results, 400).body.errcode).toBe('M_BAD_JSON');
  });

  for (const badState of ['idle', 'away', 'dnd', '', 'ONLINE']) {
    it(`invalid '${badState}' ∥ offline success`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: badState }),
          env
        ),
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: 'offline' }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(String(softBody(results, 400).body.error)).toContain('Invalid presence state');
    });
  }
});

describe('presence concurrent User not found ∥ known GET after tip', () => {
  it('unknown user ∥ alice — exact User not found', async () => {
    const env = createEnv({
      db: createSharedDb({
        users: [USER],
        presence: [
          {
            user_id: USER,
            presence: 'online',
            status_msg: 'hi',
            last_active_ts: NOW,
          },
        ],
      }),
    });
    const missing = encodeURIComponent('@nobody:example.com');
    const results = await Promise.all([
      presenceReq(`/_matrix/client/v3/presence/${missing}/status`, {}, env),
      presenceReq(`/_matrix/client/v3/presence/${USER_ENC}/status`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 404]);
    expect(softBody(results, 404).body).toMatchObject({
      errcode: 'M_NOT_FOUND',
      error: 'User not found',
    });
    expect(softBody(results, 200).body).toMatchObject({ presence: 'online' });
  });

  for (let i = 0; i < 6; i++) {
    it(`User not found flood-${i}`, async () => {
      const env = createEnv({
        db: createSharedDb({
          users: [USER, BOB],
          presence: [
            {
              user_id: USER,
              presence: 'unavailable',
              status_msg: null,
              last_active_ts: NOW,
            },
          ],
        }),
      });
      const missing = encodeURIComponent(`@ghost${i}:example.com`);
      const results = await Promise.all([
        presenceReq(`/_matrix/client/v3/presence/${missing}/status`, {}, env),
        presenceReq(`/_matrix/client/v3/presence/${USER_ENC}/status`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 404]);
      expect(softBody(results, 404).body.error).toBe('User not found');
    });
  }
});

// ---------------------------------------------------------------------------
// Typing softs ∥ success
// ---------------------------------------------------------------------------

describe('typing concurrent Cannot set typing for other users ∥ own after tip', () => {
  it('PUT bob typing ∥ alice typing — exact error', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      typingReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${BOB_ENC}`,
        jsonInit('PUT', { typing: true }),
        env
      ),
      typingReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
        jsonInit('PUT', { typing: true, timeout: 5000 }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot set typing status for other users',
    });
    expect(softBody(results, 200).body).toEqual({});
    expect(roomDO.fetches.some((f) => f.method === 'PUT')).toBe(true);
  });

  for (let i = 0; i < 6; i++) {
    it(`other-user typing soft flood-${i}`, async () => {
      const env = createEnv({ roomDO: createRoomDOStub() });
      const results = await Promise.all([
        typingReq(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${BOB_ENC}`,
          jsonInit('PUT', { typing: i % 2 === 0 }),
          env
        ),
        typingReq(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
          jsonInit('PUT', { typing: true }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 403]);
      expect(softBody(results, 403).body.error).toBe(
        'Cannot set typing status for other users'
      );
    });
  }
});

describe('typing concurrent Not a member / missing typing ∥ joined start after tip', () => {
  it('non-member ∥ joined — Not a member of this room', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      }),
    });
    const results = await Promise.all([
      typingReq(
        `/_matrix/client/v3/rooms/${ROOM2_ENC}/typing/${USER_ENC}`,
        jsonInit('PUT', { typing: true }),
        env
      ),
      typingReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
        jsonInit('PUT', { typing: true }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Not a member of this room',
    });
  });

  it('Missing required parameter: typing ∥ valid boolean under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      typingReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
        jsonInit('PUT', { timeout: 1000 }),
        env
      ),
      typingReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
        jsonInit('PUT', { typing: false }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(softBody(results, 400).body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: typing',
    });
  });

  it('badJson ∥ start typing under race', async () => {
    const env = createEnv({ roomDO: createRoomDOStub() });
    const results = await Promise.all([
      typingReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: 'not-json',
        },
        env
      ),
      typingReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
        jsonInit('PUT', { typing: true, timeout: 2000 }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(softBody(results, 400).body.errcode).toBe('M_BAD_JSON');
  });

  for (let i = 0; i < 6; i++) {
    it(`typing membership/param soft flood-${i}`, async () => {
      const roomDO = createRoomDOStub();
      const env = createEnv({
        roomDO,
        db: createSharedDb({
          memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
        }),
      });
      const soft =
        i % 2 === 0
          ? typingReq(
              `/_matrix/client/v3/rooms/${ROOM2_ENC}/typing/${USER_ENC}`,
              jsonInit('PUT', { typing: true }),
              env
            )
          : typingReq(
              `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
              jsonInit('PUT', { typing: 'yes' as unknown as boolean }),
              env
            );
      const results = await Promise.all([
        soft,
        typingReq(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
          jsonInit('PUT', { typing: true }),
          env
        ),
      ]);
      expect(results.some((r) => r.status === 200)).toBe(true);
      expect(results.some((r) => [400, 403].includes(r.status))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Receipts softs ∥ success
// ---------------------------------------------------------------------------

describe('receipts concurrent Invalid receipt type ∥ m.read after tip', () => {
  it('m.bogus ∥ m.read — exact Invalid receipt type', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      receiptsReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.bogus/$e1`,
        jsonInit('POST', {}),
        env
      ),
      receiptsReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/$e2`,
        jsonInit('POST', {}),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(softBody(results, 400).body).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'Invalid receipt type: m.bogus',
    });
    expect(softBody(results, 200).body).toEqual({});
  });

  for (const badType of ['m.seen', 'read', 'm.read.public', 'fully_read', 'm.receipt']) {
    it(`invalid ${badType} ∥ m.read.private success`, async () => {
      const env = createEnv({ roomDO: createRoomDOStub() });
      const results = await Promise.all([
        receiptsReq(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/${encodeURIComponent(badType)}/$bad`,
          jsonInit('POST', {}),
          env
        ),
        receiptsReq(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read.private/$ok`,
          jsonInit('POST', {}),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body.error).toBe(`Invalid receipt type: ${badType}`);
    });
  }
});

describe('receipts concurrent Not a member ∥ joined receipt after tip', () => {
  it('non-member room ∥ joined m.read', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      }),
    });
    const results = await Promise.all([
      receiptsReq(
        `/_matrix/client/v3/rooms/${ROOM2_ENC}/receipt/m.read/$e`,
        jsonInit('POST', {}),
        env
      ),
      receiptsReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/$e`,
        jsonInit('POST', {}),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Not a member of this room',
    });
  });

  it('leave membership ∥ join + fully_read under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM2, user_id: USER, membership: 'leave' },
        ],
      }),
    });
    const results = await Promise.all([
      receiptsReq(
        `/_matrix/client/v3/rooms/${ROOM2_ENC}/receipt/m.fully_read/$e`,
        jsonInit('POST', {}),
        env
      ),
      receiptsReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.fully_read/$e`,
        jsonInit('POST', {}),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body.error).toBe('Not a member of this room');
    expect(env._db.inserts.some((i) => i.sql.includes('account_data'))).toBe(true);
  });

  for (let i = 0; i < 6; i++) {
    it(`receipt Not a member flood-${i}`, async () => {
      const env = createEnv({
        roomDO: createRoomDOStub(),
        db: createSharedDb({
          memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
        }),
      });
      const type = i % 2 === 0 ? 'm.read' : 'm.read.private';
      const results = await Promise.all([
        receiptsReq(
          `/_matrix/client/v3/rooms/${ROOM2_ENC}/receipt/${type}/$e${i}`,
          jsonInit('POST', {}),
          env
        ),
        receiptsReq(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/${type}/$e${i}`,
          jsonInit('POST', {}),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 403]);
      expect(softBody(results, 403).body.error).toBe('Not a member of this room');
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-domain soft isolation
// ---------------------------------------------------------------------------

describe('presence/receipts/typing concurrent cross-domain soft isolation after tip', () => {
  it('presence other-user + typing other-user + bad receipt ∥ three successes', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${BOB_ENC}/status`,
        jsonInit('PUT', { presence: 'online' }),
        env
      ),
      typingReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${BOB_ENC}`,
        jsonInit('PUT', { typing: true }),
        env
      ),
      receiptsReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.nope/$e`,
        jsonInit('POST', {}),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'online' }),
        env
      ),
      typingReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
        jsonInit('PUT', { typing: true }),
        env
      ),
      receiptsReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/$e`,
        jsonInit('POST', {}),
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 403)).toHaveLength(2);
    expect(results.filter((r) => r.status === 400)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === 403)
        .map((r) => r.body.error)
        .sort()
    ).toEqual(
      [
        'Cannot set presence for other users',
        'Cannot set typing status for other users',
      ].sort()
    );
    expect(softBody(results, 400).body.error).toBe('Invalid receipt type: m.nope');
  });

  it('User not found + Not a member typing + Not a member receipt ∥ known GET + typing + receipt', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        users: [USER],
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
        presence: [
          {
            user_id: USER,
            presence: 'online',
            status_msg: null,
            last_active_ts: NOW,
          },
        ],
      }),
    });
    const missing = encodeURIComponent('@ghost:example.com');
    const results = await Promise.all([
      presenceReq(`/_matrix/client/v3/presence/${missing}/status`, {}, env),
      typingReq(
        `/_matrix/client/v3/rooms/${ROOM2_ENC}/typing/${USER_ENC}`,
        jsonInit('PUT', { typing: true }),
        env
      ),
      receiptsReq(
        `/_matrix/client/v3/rooms/${ROOM2_ENC}/receipt/m.read/$e`,
        jsonInit('POST', {}),
        env
      ),
      presenceReq(`/_matrix/client/v3/presence/${USER_ENC}/status`, {}, env),
      typingReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
        jsonInit('PUT', { typing: false }),
        env
      ),
      receiptsReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/m.read/$e`,
        jsonInit('POST', {}),
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(softBody(results, 404).body.error).toBe('User not found');
    expect(
      results.filter((r) => r.status === 403).every((r) => r.body.error === 'Not a member of this room')
    ).toBe(true);
  });

  for (let i = 0; i < 6; i++) {
    it(`cross-domain soft isolation flood-${i}`, async () => {
      const env = createEnv({ roomDO: createRoomDOStub() });
      const softPresence =
        i % 3 === 0
          ? presenceReq(
              `/_matrix/client/v3/presence/${USER_ENC}/status`,
              jsonInit('PUT', { presence: 'busy' }),
              env
            )
          : i % 3 === 1
            ? presenceReq(
                `/_matrix/client/v3/presence/${BOB_ENC}/status`,
                jsonInit('PUT', { presence: 'online' }),
                env
              )
            : presenceReq(
                `/_matrix/client/v3/presence/${USER_ENC}/status`,
                jsonInit('PUT', { presence: 'dnd' }),
                env
              );
      const softTyping =
        i % 2 === 0
          ? typingReq(
              `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${BOB_ENC}`,
              jsonInit('PUT', { typing: true }),
              env
            )
          : typingReq(
              `/_matrix/client/v3/rooms/${ROOM2_ENC}/typing/${USER_ENC}`,
              jsonInit('PUT', { typing: true }),
              env
            );
      const results = await Promise.all([
        softPresence,
        softTyping,
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: 'offline' }),
          env
        ),
        typingReq(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${USER_ENC}`,
          jsonInit('PUT', { typing: false }),
          env
        ),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(2);
      expect(results.filter((r) => [400, 403].includes(r.status))).toHaveLength(2);
    });
  }
});
