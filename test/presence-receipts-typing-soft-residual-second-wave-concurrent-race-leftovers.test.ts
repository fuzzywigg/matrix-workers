/**
 * TOKENMAXX HEAVY leftovers after #301 first soft∥success concurrent wave /
 * tip past #303 — residual *presence + receipts + typing* soft→*concurrent-
 * race* second-wave binds unsaturated by:
 *   #301 first wave (other-user / Invalid presence substring / User not
 *        found / typing other+Not a member+Missing typing / receipt Invalid
 *        type+Not a member / cross-domain triple — never read_markers soft∥
 *        success, never exact full Invalid presence state string under
 *        multi-error soft matrix, never soft multi-error quads mixing
 *        badJson exact with sibling softs under Promise.all),
 *   receipts-concurrent-race (TOCTOU success + parallel-all M_BAD_JSON on
 *        read_markers — never badJson ∥ joined success sibling),
 *   presence/typing concurrent leftovers (success TOCTOU only).
 *
 * Gap table (why leftover after #301):
 *   read_markers `Not a member of this room` ∥ joined markers success
 *     | #301 receipt POST only; markers soft never under soft file
 *   read_markers `Could not parse request body as JSON` ∥ success
 *     | receipts concurrent all-soft parallel only
 *   exact `Invalid presence state: busy. Must be one of: online, offline,
 *     unavailable` ∥ multi softs
 *     | #301 toContain substring only
 *   presence multi: other-user ∥ invalid ∥ badJson ∥ User not found ∥ oks
 *     | #301 pairwise only
 *   typing multi: other ∥ Not a member ∥ Missing typing ∥ badJson ∥ ok
 *     | #301 pairwise / membership-param flood only
 *   receipts multi: Invalid type ∥ Not a member ∥ markers badJson ∥ oks
 *     | never claimed
 *
 * Tests-only. Fixtures use example.com only. Reversible by deleting this file.
 * No invent-product / secrets / DNS.
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

const CANNOT_SET_PRESENCE = {
  errcode: 'M_FORBIDDEN',
  error: 'Cannot set presence for other users',
} as const;

const USER_NOT_FOUND = {
  errcode: 'M_NOT_FOUND',
  error: 'User not found',
} as const;

const BAD_JSON = {
  errcode: 'M_BAD_JSON',
  error: 'Could not parse request body as JSON',
} as const;

const NOT_A_MEMBER = {
  errcode: 'M_FORBIDDEN',
  error: 'Not a member of this room',
} as const;

const CANNOT_SET_TYPING = {
  errcode: 'M_FORBIDDEN',
  error: 'Cannot set typing status for other users',
} as const;

const MISSING_TYPING = {
  errcode: 'M_MISSING_PARAM',
  error: 'Missing required parameter: typing',
} as const;

const INVALID_BUSY = {
  errcode: 'M_INVALID_PARAM',
  error: 'Invalid presence state: busy. Must be one of: online, offline, unavailable',
} as const;

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

const markersPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`;
const markersPath2 = `/_matrix/client/v3/rooms/${ROOM2_ENC}/read_markers`;
const receiptPath = (type: string, eventId: string, roomEnc = ROOM_ENC) =>
  `/_matrix/client/v3/rooms/${roomEnc}/receipt/${type}/${encodeURIComponent(eventId)}`;
const typingPath = (userEnc: string, roomEnc = ROOM_ENC) =>
  `/_matrix/client/v3/rooms/${roomEnc}/typing/${userEnc}`;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Exact Invalid presence state full string under multi-soft race
// ---------------------------------------------------------------------------

describe('presence residual concurrent exact Invalid presence state after #301', () => {
  it('busy exact string ∥ online success — full Must be one of pin', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'busy' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'online', status_msg: 'ok' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(softBody(results, 400).body).toEqual(INVALID_BUSY);
  });

  it('exact busy ∥ other-user ∥ badJson ∥ online under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'busy' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${BOB_ENC}/status`,
        jsonInit('PUT', { presence: 'online' }),
        env
      ),
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
        jsonInit('PUT', { presence: 'offline' }),
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(2);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(softBody(results, 403).body).toEqual(CANNOT_SET_PRESENCE);
    expect(
      results
        .filter((r) => r.status === 400)
        .map((r) => r.body)
        .sort((a, b) => String(a.errcode).localeCompare(String(b.errcode)))
    ).toEqual(
      [BAD_JSON, INVALID_BUSY].sort((a, b) => a.errcode.localeCompare(b.errcode))
    );
  });

  for (const badState of ['idle', 'away', 'dnd', 'ONLINE', 'null']) {
    it(`exact Invalid presence state '${badState}' ∥ unavailable`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: badState }),
          env
        ),
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: 'unavailable' }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body).toEqual({
        errcode: 'M_INVALID_PARAM',
        error: `Invalid presence state: ${badState}. Must be one of: online, offline, unavailable`,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Presence multi-error soft matrix
// ---------------------------------------------------------------------------

describe('presence residual concurrent multi-error soft matrix after #301', () => {
  it('other-user ∥ invalid ∥ badJson ∥ User not found ∥ PUT+GET success', async () => {
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
      presenceReq(
        `/_matrix/client/v3/presence/${BOB_ENC}/status`,
        jsonInit('PUT', { presence: 'online' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'busy' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{bad',
        },
        env
      ),
      presenceReq(`/_matrix/client/v3/presence/${missing}/status`, {}, env),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'online' }),
        env
      ),
      presenceReq(`/_matrix/client/v3/presence/${USER_ENC}/status`, {}, env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(2);
    expect(results.filter((r) => r.status === 404)).toHaveLength(1);
    expect(softBody(results, 403).body).toEqual(CANNOT_SET_PRESENCE);
    expect(softBody(results, 404).body).toEqual(USER_NOT_FOUND);
    expect(softBody(results, 400).body.errcode).toMatch(/M_INVALID_PARAM|M_BAD_JSON/);
  });

  for (let i = 0; i < 6; i++) {
    it(`presence multi-soft flood-${i}`, async () => {
      const env = createEnv({
        db: createSharedDb({ users: [USER, BOB] }),
      });
      const results = await Promise.all([
        presenceReq(
          `/_matrix/client/v3/presence/${BOB_ENC}/status`,
          jsonInit('PUT', { presence: 'online' }),
          env
        ),
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: 'busy' }),
          env
        ),
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: 'offline' }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400, 403]);
      expect(softBody(results, 403).body).toEqual(CANNOT_SET_PRESENCE);
      expect(softBody(results, 400).body).toEqual(INVALID_BUSY);
    });
  }
});

// ---------------------------------------------------------------------------
// read_markers soft ∥ success — never under #301 soft file
// ---------------------------------------------------------------------------

describe('receipts residual concurrent read_markers soft ∥ success after #301', () => {
  it('read_markers Not a member ∥ joined markers — exact soft', async () => {
    const env = createEnv({
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM2, user_id: USER, membership: 'leave' },
        ],
      }),
    });
    const results = await Promise.all([
      receiptsReq(
        markersPath2,
        jsonInit('POST', { 'm.fully_read': '$e-soft:example.com' }),
        env
      ),
      receiptsReq(
        markersPath,
        jsonInit('POST', { 'm.fully_read': '$e-ok:example.com' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toEqual(NOT_A_MEMBER);
    expect(softBody(results, 200).body).toEqual({});
  });

  it('read_markers badJson ∥ joined markers success under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      receiptsReq(
        markersPath,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{truncated',
        },
        env
      ),
      receiptsReq(
        markersPath,
        jsonInit('POST', { 'm.fully_read': '$e-ok2:example.com', 'm.read': '$e-r:example.com' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(softBody(results, 400).body).toEqual(BAD_JSON);
    expect(softBody(results, 200).body).toEqual({});
  });

  it('non-member room + badJson ∥ two joined markers under race', async () => {
    const env = createEnv({
      db: createSharedDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      }),
    });
    const results = await Promise.all([
      receiptsReq(
        markersPath2,
        jsonInit('POST', { 'm.fully_read': '$x:example.com' }),
        env
      ),
      receiptsReq(
        markersPath,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: 'nope',
        },
        env
      ),
      receiptsReq(
        markersPath,
        jsonInit('POST', { 'm.fully_read': '$a:example.com' }),
        env
      ),
      receiptsReq(
        markersPath,
        jsonInit('POST', { 'm.read.private': '$b:example.com' }),
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(1);
    expect(softBody(results, 403).body).toEqual(NOT_A_MEMBER);
    expect(softBody(results, 400).body).toEqual(BAD_JSON);
  });

  for (let i = 0; i < 6; i++) {
    it(`read_markers soft flood-${i}`, async () => {
      const env = createEnv({
        db: createSharedDb({
          memberships: [
            { room_id: ROOM, user_id: USER, membership: 'join' },
            { room_id: ROOM2, user_id: USER, membership: 'invite' },
          ],
        }),
      });
      const soft =
        i % 2 === 0
          ? receiptsReq(
              markersPath2,
              jsonInit('POST', { 'm.fully_read': `$s-${i}:example.com` }),
              env
            )
          : receiptsReq(
              markersPath,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...AUTH },
                body: '{bad',
              },
              env
            );
      const results = await Promise.all([
        soft,
        receiptsReq(
          markersPath,
          jsonInit('POST', { 'm.fully_read': `$ok-${i}:example.com` }),
          env
        ),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.some((r) => r.status === 403 || r.status === 400)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Typing multi-error soft matrix
// ---------------------------------------------------------------------------

describe('typing residual concurrent multi-error soft matrix after #301', () => {
  it('other-user ∥ Not a member ∥ Missing typing ∥ badJson ∥ start ok', async () => {
    const env = createEnv({
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM2, user_id: USER, membership: 'leave' },
        ],
      }),
    });
    const results = await Promise.all([
      typingReq(typingPath(BOB_ENC), jsonInit('PUT', { typing: true }), env),
      typingReq(typingPath(USER_ENC, ROOM2_ENC), jsonInit('PUT', { typing: true }), env),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { timeout: 1000 }), env),
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{bad',
        },
        env
      ),
      typingReq(
        typingPath(USER_ENC),
        jsonInit('PUT', { typing: true, timeout: 5000 }),
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(2);
    expect(results.filter((r) => r.status === 400)).toHaveLength(2);
    expect(
      results
        .filter((r) => r.status === 403)
        .map((r) => r.body.error)
        .sort()
    ).toEqual(['Cannot set typing status for other users', 'Not a member of this room'].sort());
    expect(
      results
        .filter((r) => r.status === 400)
        .map((r) => r.body)
        .sort((a, b) => String(a.errcode).localeCompare(String(b.errcode)))
    ).toEqual(
      [BAD_JSON, MISSING_TYPING].sort((a, b) => a.errcode.localeCompare(b.errcode))
    );
  });

  for (let i = 0; i < 6; i++) {
    it(`typing multi-soft flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        typingReq(typingPath(BOB_ENC), jsonInit('PUT', { typing: i % 2 === 0 }), env),
        typingReq(typingPath(USER_ENC), jsonInit('PUT', { timeout: 1 }), env),
        typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: false }), env),
      ]);
      expect(statusesOf(results)).toEqual([200, 400, 403]);
      expect(softBody(results, 403).body).toEqual(CANNOT_SET_TYPING);
      expect(softBody(results, 400).body).toEqual(MISSING_TYPING);
    });
  }
});

// ---------------------------------------------------------------------------
// Receipts multi-error soft matrix incl markers
// ---------------------------------------------------------------------------

describe('receipts residual concurrent multi-error soft matrix after #301', () => {
  it('Invalid type ∥ Not a member ∥ markers badJson ∥ m.read + markers ok', async () => {
    const env = createEnv({
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM2, user_id: USER, membership: 'leave' },
        ],
      }),
    });
    const results = await Promise.all([
      receiptsReq(receiptPath('m.bogus', '$e1:example.com'), jsonInit('POST', {}), env),
      receiptsReq(
        receiptPath('m.read', '$e2:example.com', ROOM2_ENC),
        jsonInit('POST', {}),
        env
      ),
      receiptsReq(
        markersPath,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{bad',
        },
        env
      ),
      receiptsReq(receiptPath('m.read', '$e3:example.com'), jsonInit('POST', {}), env),
      receiptsReq(
        markersPath,
        jsonInit('POST', { 'm.fully_read': '$e4:example.com' }),
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 400)).toHaveLength(2);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(softBody(results, 403).body).toEqual(NOT_A_MEMBER);
    expect(
      results
        .filter((r) => r.status === 400)
        .map((r) => r.body.error)
        .sort()
    ).toEqual(
      ['Could not parse request body as JSON', 'Invalid receipt type: m.bogus'].sort()
    );
  });

  for (let i = 0; i < 6; i++) {
    it(`receipts multi-soft flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        receiptsReq(
          receiptPath(`m.bad-${i}`, `$e-${i}:example.com`),
          jsonInit('POST', {}),
          env
        ),
        receiptsReq(
          markersPath,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...AUTH },
            body: '{x',
          },
          env
        ),
        receiptsReq(
          receiptPath('m.read.private', `$ok-${i}:example.com`),
          jsonInit('POST', {}),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400, 400]);
      expect(softBody(results, 200).body).toEqual({});
      expect(
        results
          .filter((r) => r.status === 400)
          .some((r) => r.body.error === `Invalid receipt type: m.bad-${i}`)
      ).toBe(true);
      expect(results.filter((r) => r.status === 400).some((r) => r.body.errcode === 'M_BAD_JSON')).toBe(
        true
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-domain soft isolation including read_markers + exact presence
// ---------------------------------------------------------------------------

describe('presence/receipts/typing residual cross-domain soft isolation after #301', () => {
  it('exact busy + typing other + markers Not a member ∥ three successes', async () => {
    const env = createEnv({
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM2, user_id: USER, membership: 'ban' },
        ],
      }),
    });
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'busy' }),
        env
      ),
      typingReq(typingPath(BOB_ENC), jsonInit('PUT', { typing: true }), env),
      receiptsReq(
        markersPath2,
        jsonInit('POST', { 'm.fully_read': '$x:example.com' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'online' }),
        env
      ),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: true }), env),
      receiptsReq(
        markersPath,
        jsonInit('POST', { 'm.fully_read': '$ok:example.com' }),
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 400)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(2);
    expect(softBody(results, 400).body).toEqual(INVALID_BUSY);
    expect(
      results
        .filter((r) => r.status === 403)
        .map((r) => r.body.error)
        .sort()
    ).toEqual(['Cannot set typing status for other users', 'Not a member of this room'].sort());
  });

  for (let i = 0; i < 6; i++) {
    it(`cross-domain residual soft isolation flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: 'busy' }),
          env
        ),
        receiptsReq(
          markersPath,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...AUTH },
            body: '{bad',
          },
          env
        ),
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: 'offline' }),
          env
        ),
        receiptsReq(
          markersPath,
          jsonInit('POST', { 'm.fully_read': `$f-${i}:example.com` }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 400, 400]);
      expect(softBody(results, 400).body.errcode).toMatch(/M_INVALID_PARAM|M_BAD_JSON/);
    });
  }
});
